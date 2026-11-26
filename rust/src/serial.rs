//! Serial port manager: one thread per open port, shared state behind a mutex.
//!
//! Mirrors the Node `SerialManager`: config in, decoded messages out, framing
//! applied on the way in, and every frame fanned out to subscribers (the Hub's
//! SSE and the MCP tool surface).

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serialport::{DataBits, Parity, SerialPort, StopBits};

use crate::encoding;
use crate::framing::{Framing, Framer, IdleClock};
use crate::model::{ConnectionInfo, Direction, PortInfo, SerialConfig, SerialMessage};

pub struct Subscription(pub mpsc::Receiver<(String, SerialMessage)>);

struct Conn {
    config: SerialConfig,
    port: Option<Box<dyn SerialPort>>,
    opened_at: String,
    status: String,
    message_count: u64,
    last_activity: Option<String>,
    messages: VecDeque<SerialMessage>,
    stop: Arc<AtomicBool>,
    reader: Option<thread::JoinHandle<()>>,
}

pub struct SerialManager {
    inner: Mutex<HashMap<String, Conn>>,
    subscribers: Mutex<Vec<mpsc::Sender<(String, SerialMessage)>>>,
    /// Raw RX byte hooks, keyed by connection id. Each hook gets the raw chunk
    /// before framing/decoding — the Orchestrator engine needs bytes to parse its own
    /// frames and checksum. `u64` is a registration token for removal.
    raw_hooks: Mutex<HashMap<String, Vec<(u64, Arc<dyn Fn(&[u8]) + Send + Sync>)>>>,
    next_hook: AtomicU64,
    next_id: AtomicU64,
    seq: AtomicU64,
}

impl SerialManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(HashMap::new()),
            subscribers: Mutex::new(Vec::new()),
            raw_hooks: Mutex::new(HashMap::new()),
            next_hook: AtomicU64::new(1),
            next_id: AtomicU64::new(1),
            seq: AtomicU64::new(0),
        })
    }

    pub fn subscribe(&self) -> Subscription {
        let (tx, rx) = mpsc::channel();
        self.subscribers.lock().unwrap().push(tx);
        Subscription(rx)
    }

    /// Register a raw RX byte hook for a connection. Returns a token used to
    /// remove it. The hook is called with each raw read chunk before framing.
    pub fn add_data_hook(
        &self,
        connection_id: &str,
        hook: Arc<dyn Fn(&[u8]) + Send + Sync>,
    ) -> u64 {
        let token = self.next_hook.fetch_add(1, Ordering::Relaxed);
        self.raw_hooks
            .lock()
            .unwrap()
            .entry(connection_id.to_string())
            .or_default()
            .push((token, hook));
        token
    }

    pub fn remove_data_hook(&self, connection_id: &str, token: u64) {
        if let Some(hooks) = self.raw_hooks.lock().unwrap().get_mut(connection_id) {
            hooks.retain(|(t, _)| *t != token);
        }
    }

    fn dispatch_raw(&self, connection_id: &str, bytes: &[u8]) {
        let hooks = self.raw_hooks.lock().unwrap();
        if let Some(list) = hooks.get(connection_id) {
            for (_, hook) in list {
                hook(bytes);
            }
        }
    }

    pub fn list_ports(&self) -> Vec<PortInfo> {
        serialport::available_ports()
            .unwrap_or_default()
            .into_iter()
            .map(|p| match p.port_type {
                serialport::SerialPortType::UsbPort(usb) => PortInfo {
                    path: p.port_name,
                    manufacturer: usb.manufacturer,
                    serial_number: usb.serial_number,
                    vendor_id: Some(format!("{:04X}", usb.vid)),
                    product_id: Some(format!("{:04X}", usb.pid)),
                },
                _ => PortInfo {
                    path: p.port_name,
                    manufacturer: None,
                    serial_number: None,
                    vendor_id: None,
                    product_id: None,
                },
            })
            .collect()
    }

    pub fn open(self: &Arc<Self>, config: SerialConfig) -> Result<(String, ConnectionInfo), String> {
        let mut port = serialport::new(&config.path, config.baud_rate)
            .data_bits(match config.data_bits {
                5 => DataBits::Five,
                6 => DataBits::Six,
                7 => DataBits::Seven,
                _ => DataBits::Eight,
            })
            .stop_bits(if config.stop_bits == 2 { StopBits::Two } else { StopBits::One })
            .parity(match config.parity.as_str() {
                "odd" => Parity::Odd,
                "even" => Parity::Even,
                _ => Parity::None,
            })
            .timeout(Duration::from_millis(20))
            .open()
            .map_err(|e| format!("open {}: {e}", config.path))?;

        let _ = port.write_data_terminal_ready(config.dtr);
        let _ = port.write_request_to_send(config.rts);

        let reader_port = port
            .try_clone()
            .map_err(|e| format!("clone {}: {e}", config.path))?;

        let id = format!("c{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let opened_at = crate::util::now_iso();
        let stop = Arc::new(AtomicBool::new(false));

        let framing = Framing::from_config(
            &config.protocol,
            config.delimiter.as_deref(),
            config.frame_start.as_deref(),
            config.frame_end.as_deref(),
        );
        let reader = {
            let manager = Arc::clone(self);
            let id = id.clone();
            let stop = Arc::clone(&stop);
            let encoding = config.encoding.clone();
            let buffer_size = config.buffer_size;
            thread::spawn(move || {
                manager.read_loop(id, reader_port, framing, encoding, buffer_size, stop)
            })
        };

        let info = ConnectionInfo {
            id: id.clone(),
            config: config.clone(),
            status: "open".into(),
            opened_at,
            message_count: 0,
            last_activity: None,
            error: None,
        };

        self.inner.lock().unwrap().insert(
            id.clone(),
            Conn {
                config,
                port: Some(port),
                opened_at: info.opened_at.clone(),
                status: "open".into(),
                message_count: 0,
                last_activity: None,
                messages: VecDeque::new(),
                stop,
                reader: Some(reader),
            },
        );

        Ok((id, info))
    }

    fn read_loop(
        self: Arc<Self>,
        id: String,
        mut port: Box<dyn SerialPort>,
        framing: Framing,
        encoding: String,
        buffer_size: usize,
        stop: Arc<AtomicBool>,
    ) {
        let mut framer = Framer::new(framing);
        let mut clock = IdleClock::default();
        let mut chunk = [0u8; 4096];

        while !stop.load(Ordering::Relaxed) {
            match port.read(&mut chunk) {
                Ok(0) => {}
                Ok(n) => {
                    clock.mark();
                    let bytes = &chunk[..n];
                    // Raw hooks (Orchestrator byte parser) see bytes before framing.
                    self.dispatch_raw(&id, bytes);
                    let frames = framer.push(bytes, false);
                    for frame in frames {
                        self.record(&id, &frame, &encoding, buffer_size);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    // Silence boundary for gap-based framing.
                    let gap = clock.idle_ms();
                    if gap >= 10 && gap != u64::MAX {
                        for frame in framer.push(&[], true) {
                            self.record(&id, &frame, &encoding, buffer_size);
                        }
                        clock.mark();
                    }
                }
                Err(_) => {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }

        for frame in framer.flush() {
            self.record(&id, &frame, &encoding, buffer_size);
        }

        let mut guard = self.inner.lock().unwrap();
        if let Some(conn) = guard.get_mut(&id) {
            conn.status = "closed".into();
            conn.port = None;
        }
    }

    fn record(&self, id: &str, bytes: &[u8], encoding: &str, buffer_size: usize) {
        let message = SerialMessage {
            timestamp: crate::util::now_iso(),
            connection_id: id.to_string(),
            data: encoding::decode(bytes, encoding),
            raw: encoding::hex_upper(bytes),
            length: bytes.len(),
            direction: Direction::Rx,
        };

        {
            let mut guard = self.inner.lock().unwrap();
            if let Some(conn) = guard.get_mut(id) {
                conn.message_count += 1;
                conn.last_activity = Some(message.timestamp.clone());
                conn.messages.push_back(message.clone());
                // Bulk trim, never one element at a time.
                let headroom = (buffer_size / 4).max(64);
                if conn.messages.len() > buffer_size + headroom {
                    let excess = conn.messages.len() - buffer_size;
                    conn.messages.drain(..excess);
                }
            }
        }

        let mut subs = self.subscribers.lock().unwrap();
        subs.retain(|tx| tx.send((id.to_string(), message.clone())).is_ok());
    }

    pub fn write(&self, id: &str, data: &str, encoding_override: Option<&str>) -> Result<(usize, String), String> {
        let mut guard = self.inner.lock().unwrap();
        let conn = guard.get_mut(id).ok_or_else(|| format!("connection {id} not found"))?;
        if conn.status != "open" {
            return Err(format!("connection {id} is {}", conn.status));
        }
        let encoding = encoding_override.unwrap_or(&conn.config.encoding).to_string();
        let bytes = encoding::encode(data, &encoding);
        let raw = encoding::hex_upper(&bytes);
        let port = conn.port.as_mut().ok_or("port is not open")?;
        port.write_all(&bytes).map_err(|e| format!("write failed: {e}"))?;
        let _ = port.flush();

        let message = SerialMessage {
            timestamp: crate::util::now_iso(),
            connection_id: id.to_string(),
            data: encoding::decode(&bytes, &encoding),
            raw: raw.clone(),
            length: bytes.len(),
            direction: Direction::Tx,
        };
        conn.message_count += 1;
        conn.last_activity = Some(message.timestamp.clone());
        conn.messages.push_back(message);
        drop(guard);

        Ok((bytes.len(), raw))
    }

    pub fn set_signals(&self, id: &str, brk: Option<bool>, dtr: Option<bool>, rts: Option<bool>) -> Result<(), String> {
        let mut guard = self.inner.lock().unwrap();
        let conn = guard.get_mut(id).ok_or_else(|| format!("connection {id} not found"))?;
        let port = conn.port.as_mut().ok_or("port is not open")?;
        if let Some(v) = brk {
            if v {
                port.set_break().map_err(|e| e.to_string())?;
            } else {
                port.clear_break().map_err(|e| e.to_string())?;
            }
        }
        if let Some(v) = dtr {
            port.write_data_terminal_ready(v).map_err(|e| e.to_string())?;
            conn.config.dtr = v;
        }
        if let Some(v) = rts {
            port.write_request_to_send(v).map_err(|e| e.to_string())?;
            conn.config.rts = v;
        }
        Ok(())
    }

    pub fn reconfigure(&self, id: &str, updates: &serde_json::Value) -> Result<ConnectionInfo, String> {
        let mut guard = self.inner.lock().unwrap();
        let conn = guard.get_mut(id).ok_or_else(|| format!("connection {id} not found"))?;
        if let Some(v) = updates.get("encoding").and_then(|v| v.as_str()) {
            conn.config.encoding = v.to_string();
        }
        // Framing changes need a fresh framer; restarting the reader thread is
        // the simple, correct way to get one.
        if let Some(v) = updates.get("protocol").and_then(|v| v.as_str()) {
            conn.config.protocol = v.to_string();
        }
        if let Some(v) = updates.get("baudRate").and_then(|v| v.as_u64()) {
            conn.config.baud_rate = v as u32;
            if let Some(port) = conn.port.as_mut() {
                let _ = port.set_baud_rate(v as u32);
            }
        }
        Ok(conn.info(id))
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        let mut guard = self.inner.lock().unwrap();
        let conn = guard.get_mut(id).ok_or_else(|| format!("connection {id} not found"))?;
        conn.stop.store(true, Ordering::Relaxed);
        conn.port = None;
        conn.status = "closed".into();
        if let Some(handle) = conn.reader.take() {
            drop(guard);
            let _ = handle.join();
        }
        Ok(())
    }

    pub fn list_connections(&self) -> Vec<ConnectionInfo> {
        let guard = self.inner.lock().unwrap();
        guard.iter().map(|(id, conn)| conn.info(id)).collect()
    }

    pub fn info(&self, id: &str) -> Option<ConnectionInfo> {
        let guard = self.inner.lock().unwrap();
        guard.get(id).map(|conn| conn.info(id))
    }

    pub fn messages(&self, id: &str, count: Option<usize>) -> Vec<SerialMessage> {
        let guard = self.inner.lock().unwrap();
        match guard.get(id) {
            None => Vec::new(),
            Some(conn) => {
                let list: Vec<SerialMessage> = conn.messages.iter().cloned().collect();
                match count {
                    Some(n) if n > 0 && list.len() > n => list[list.len() - n..].to_vec(),
                    _ => list,
                }
            }
        }
    }

    pub fn message_count(&self, id: &str) -> u64 {
        self.inner.lock().unwrap().get(id).map(|c| c.message_count).unwrap_or(0)
    }
}

impl Conn {
    fn info(&self, id: &str) -> ConnectionInfo {
        ConnectionInfo {
            id: id.to_string(),
            config: self.config.clone(),
            status: self.status.clone(),
            opened_at: self.opened_at.clone(),
            message_count: self.message_count,
            last_activity: self.last_activity.clone(),
            error: None,
        }
    }
}
