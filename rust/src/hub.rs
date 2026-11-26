//! Local HTTP + SSE hub.
//!
//! Route-for-route compatible with the Node Hub, because the browser console and
//! the DSH panel are unchanged consumers: `/api/health`, `/api/ports`,
//! `/api/status`, `/api/frames`, `/api/history`, `/api/connect`, `/api/write`,
//! `/api/config`, `/api/signals`, `/api/disconnect`, `/api/detach` and
//! `/events/stream`, plus the static UI.

use std::collections::VecDeque;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

use serde_json::{json, Value};
use tiny_http::{Header, Method, Response, Server, StatusCode};

use crate::model::SerialConfig;
use crate::serial::SerialManager;
use crate::util::{json_error, now_iso};

pub struct HubState {
    pub manager: Arc<SerialManager>,
    pub active: Mutex<Option<String>>,
    pub owns_port: Mutex<bool>,
    pub frames: Mutex<VecDeque<Value>>,
    pub history: Mutex<VecDeque<Value>>,
    pub seq: AtomicU64,
    sse: Mutex<Vec<mpsc::Sender<String>>>,
    pub started_at: String,
    pub max_frames: usize,
    pub max_history: usize,
}

impl HubState {
    pub fn new(manager: Arc<SerialManager>) -> Arc<Self> {
        let state = Arc::new(Self {
            manager: manager.clone(),
            active: Mutex::new(None),
            owns_port: Mutex::new(false),
            frames: Mutex::new(VecDeque::new()),
            history: Mutex::new(VecDeque::new()),
            seq: AtomicU64::new(0),
            sse: Mutex::new(Vec::new()),
            started_at: now_iso(),
            max_frames: 2000,
            max_history: 20000,
        });

        // Bridge serial frames into the hub buffers and the SSE fan-out.
        let subscription = manager.subscribe();
        let bridge = Arc::clone(&state);
        thread::spawn(move || {
            for (connection_id, message) in subscription.0.iter() {
                let seq = bridge.seq.fetch_add(1, Ordering::Relaxed) + 1;
                let mut payload = message.to_wire();
                payload["seq"] = json!(seq);
                payload["connectionId"] = json!(connection_id);

                {
                    let mut frames = bridge.frames.lock().unwrap();
                    frames.push_back(payload.clone());
                    let headroom = 256;
                    if frames.len() > bridge.max_frames + headroom {
                        let excess = frames.len() - bridge.max_frames;
                        frames.drain(..excess);
                    }
                }
                {
                    let mut history = bridge.history.lock().unwrap();
                    history.push_back(payload.clone());
                    let headroom = 2048;
                    if history.len() > bridge.max_history + headroom {
                        let excess = history.len() - bridge.max_history;
                        history.drain(..excess);
                    }
                }

                let block = format!(
                    "id: {seq}\nevent: frame\ndata: {}\n\n",
                    serde_json::to_string(&payload).unwrap_or_default()
                );
                let mut subs = bridge.sse.lock().unwrap();
                subs.retain(|tx| tx.send(block.clone()).is_ok());
            }
        });

        state
    }

    fn subscribe_sse(&self) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel();
        self.sse.lock().unwrap().push(tx);
        rx
    }
}

/// Blocking reader that turns SSE channel messages into a response body.
struct SseBody {
    rx: mpsc::Receiver<String>,
    pending: Vec<u8>,
}

impl Read for SseBody {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pending.is_empty() {
            match self.rx.recv_timeout(std::time::Duration::from_secs(15)) {
                Ok(chunk) => self.pending = chunk.into_bytes(),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.pending = b"event: ping\ndata: {}\n\n".to_vec()
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
        let n = self.pending.len().min(buf.len());
        buf[..n].copy_from_slice(&self.pending[..n]);
        self.pending.drain(..n);
        Ok(n)
    }
}

pub fn serve(state: Arc<HubState>, addr: &str) -> std::io::Result<()> {
    let server = Server::http(addr).map_err(|e| {
        // tiny_http boxes the error without raw_os_error; carry the text so the
        // launcher can detect WSAEADDRINUSE (10048) for port fallback.
        let message = e.to_string();
        if message.contains("10048") || message.to_lowercase().contains("address already in use") {
            std::io::Error::new(std::io::ErrorKind::AddrInUse, message)
        } else {
            std::io::Error::new(std::io::ErrorKind::Other, message)
        }
    })?;
    eprintln!("UART hub listening on http://{addr}");
  // Machine-readable line for the DSH host plugin (same marker as dist/hub.js).
  eprintln!("HUB_URL=http://{addr}");

    for request in server.incoming_requests() {
        let state = Arc::clone(&state);
        thread::spawn(move || {
            if let Err(err) = handle(state, request) {
                eprintln!("request failed: {err}");
            }
        });
    }
    Ok(())
}

fn handle(state: Arc<HubState>, mut request: tiny_http::Request) -> std::io::Result<()> {
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();
    let query = url.split('?').nth(1).unwrap_or("").to_string();
    let method = request.method().clone();

    match (method, path.as_str()) {
        (Method::Get, "/api/health") => {
            let active = state.active.lock().unwrap().clone();
            let owns = *state.owns_port.lock().unwrap();
            let frames = state.frames.lock().unwrap().len();
            let seq = state.seq.load(Ordering::Relaxed);
            respond_json(
                request,
                200,
                json!({
                    "ok": true,
                    "activeConnectionId": active,
                    "ownsPort": owns,
                    "frameCount": frames,
                    "seq": seq,
                    "dut": false,
                    "pid": std::process::id(),
                    "startedAt": state.started_at.clone(),
                    "features": { "history": true, "dut": false },
                }),
            )
        }
        (Method::Get, "/api/ports") => {
            let ports = state.manager.list_ports();
            respond_json(request, 200, json!({ "ok": true, "ports": ports }))
        }
        (Method::Get, "/api/status") => {
            let active = state.active.lock().unwrap().clone();
            let connections = state.manager.list_connections();
            let active_info = active
                .as_ref()
                .and_then(|id| connections.iter().find(|c| &c.id == id).cloned());
            respond_json(
                request,
                200,
                json!({
                    "ok": true,
                    "activeConnectionId": active,
                    "frameCount": state.frames.lock().unwrap().len(),
                    "seq": state.seq.load(Ordering::Relaxed),
                    "active": active_info,
                    "connections": connections,
                }),
            )
        }
        (Method::Get, "/api/frames") => {
            let params = parse_query(&query);
            let limit = params.get("limit").and_then(|v| v.parse::<usize>().ok()).unwrap_or(200);
            let since = params.get("sinceSeq").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
            let direction = params.get("direction").cloned().unwrap_or_else(|| "all".into());
            let frames = state.frames.lock().unwrap();
            let mut list: Vec<Value> = frames
                .iter()
                .filter(|f| f.get("seq").and_then(|v| v.as_u64()).unwrap_or(0) > since)
                .filter(|f| direction == "all" || f.get("direction").and_then(|v| v.as_str()) == Some(direction.as_str()))
                .cloned()
                .collect();
            if limit > 0 && list.len() > limit {
                list = list.split_off(list.len() - limit);
            }
            respond_json(request, 200, json!({ "ok": true, "seq": state.seq.load(Ordering::Relaxed), "frames": list }))
        }
        (Method::Get, "/api/history") => {
            let params = parse_query(&query);
            let limit = params.get("limit").and_then(|v| v.parse::<usize>().ok()).unwrap_or(500).min(5000);
            let offset = params.get("offset").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
            let direction = params.get("direction").cloned().unwrap_or_else(|| "all".into());
            let text = params.get("text").cloned().unwrap_or_default();
            let hex = params.get("hex").cloned().unwrap_or_default().replace(' ', "").to_uppercase();
            let history = state.history.lock().unwrap();
            let filtered: Vec<&Value> = history
                .iter()
                .filter(|f| direction == "all" || f.get("direction").and_then(|v| v.as_str()) == Some(direction.as_str()))
                .filter(|f| hex.is_empty() || f.get("raw").and_then(|v| v.as_str()).unwrap_or("").to_uppercase().contains(&hex))
                .filter(|f| text.is_empty() || f.get("data").and_then(|v| v.as_str()).unwrap_or("").contains(&text))
                .collect();
            let total = filtered.len();
            let page: Vec<Value> = filtered.iter().rev().skip(offset).take(limit).map(|v| (*v).clone()).collect();
            respond_json(request, 200, json!({ "ok": true, "total": total, "offset": offset, "limit": limit, "frames": page }))
        }
        (Method::Post, "/api/connect") => {
            let body: Value = match read_json(&mut request) {
                Ok(v) => v,
                Err(err) => return respond_json(request, 400, json_error(err)),
            };
            let path = body.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if path.is_empty() {
                return respond_json(request, 400, json_error("path is required"));
            }
            let mut config = SerialConfig::default();
            config.path = path;
            if let Some(v) = body.get("baudRate").and_then(|v| v.as_u64()) {
                config.baud_rate = v as u32;
            }
            if let Some(v) = body.get("dataBits").and_then(|v| v.as_u64()) {
                config.data_bits = v as u8;
            }
            if let Some(v) = body.get("stopBits").and_then(|v| v.as_u64()) {
                config.stop_bits = v as u8;
            }
            for (key, field) in [("parity", "parity"), ("encoding", "encoding"), ("protocol", "protocol")] {
                if let Some(v) = body.get(key).and_then(|v| v.as_str()) {
                    match field {
                        "parity" => config.parity = v.to_string(),
                        "encoding" => config.encoding = v.to_string(),
                        _ => config.protocol = v.to_string(),
                    }
                }
            }

            match state.manager.open(config) {
                Ok((id, info)) => {
                    *state.active.lock().unwrap() = Some(id.clone());
                    *state.owns_port.lock().unwrap() = true;
                    respond_json(request, 200, json!({ "ok": true, "connectionId": id, "info": info }))
                }
                Err(err) => respond_json(request, 500, json_error(err)),
            }
        }
        (Method::Post, "/api/write") => {
            let body: Value = match read_json(&mut request) {
                Ok(v) => v,
                Err(err) => return respond_json(request, 400, json_error(err)),
            };
            let active = state.active.lock().unwrap().clone();
            let Some(id) = active else {
                return respond_json(request, 409, json_error("Not connected"));
            };
            let data = body.get("data").and_then(|v| v.as_str()).unwrap_or("");
            let encoding = body.get("encoding").and_then(|v| v.as_str());
            match state.manager.write(&id, data, encoding) {
                Ok((written, raw)) => respond_json(request, 200, json!({ "ok": true, "bytesWritten": written, "raw": raw })),
                Err(err) => respond_json(request, 500, json_error(err)),
            }
        }
        (Method::Post, "/api/signals") => {
            let body: Value = match read_json(&mut request) {
                Ok(v) => v,
                Err(err) => return respond_json(request, 400, json_error(err)),
            };
            let active = state.active.lock().unwrap().clone();
            let Some(id) = active else {
                return respond_json(request, 409, json_error("Not connected"));
            };
            let brk = body.get("break").and_then(|v| v.as_bool());
            let dtr = body.get("dtr").and_then(|v| v.as_bool());
            let rts = body.get("rts").and_then(|v| v.as_bool());
            match state.manager.set_signals(&id, brk, dtr, rts) {
                Ok(()) => respond_json(request, 200, json!({ "ok": true, "signals": body })),
                Err(err) => respond_json(request, 500, json_error(err)),
            }
        }
        (Method::Post, "/api/config") => {
            let body: Value = match read_json(&mut request) {
                Ok(v) => v,
                Err(err) => return respond_json(request, 400, json_error(err)),
            };
            let active = state.active.lock().unwrap().clone();
            let Some(id) = active else {
                return respond_json(request, 409, json_error("Not connected"));
            };
            match state.manager.reconfigure(&id, &body) {
                Ok(info) => respond_json(request, 200, json!({ "ok": true, "info": info })),
                Err(err) => respond_json(request, 500, json_error(err)),
            }
        }
        (Method::Post, "/api/detach") => {
            *state.active.lock().unwrap() = None;
            *state.owns_port.lock().unwrap() = false;
            respond_json(request, 200, json!({ "ok": true, "detached": true, "closedPort": false }))
        }
        (Method::Post, "/api/disconnect") => {
            let active = state.active.lock().unwrap().clone();
            if let Some(id) = active {
                let _ = state.manager.close(&id);
            }
            *state.active.lock().unwrap() = None;
            *state.owns_port.lock().unwrap() = false;
            respond_json(request, 200, json!({ "ok": true }))
        }
        (Method::Get, "/events/stream") => {
            let rx = state.subscribe_sse();
            let body = SseBody { rx, pending: Vec::new() };
            // data_length: None → chunked transfer, which is what SSE needs.
            let headers = vec![
                header("Content-Type", "text/event-stream; charset=utf-8"),
                header("Cache-Control", "no-cache, no-transform"),
                header("Connection", "keep-alive"),
            ];
            request.respond(Response::new(StatusCode(200), headers, Box::new(body), None, None))
        }
        (Method::Get, path) if path == "/" || path == "/index.html" => serve_file(request, "index.html"),        (Method::Get, path) if path.starts_with("/static/") => {
            let rel = path.trim_start_matches("/static/").to_string();
            serve_file(request, &rel)
        }
        _ => respond_json(request, 404, json_error(format!("Not found: {path}"))),
    }
}

fn serve_file(request: tiny_http::Request, rel: &str) -> std::io::Result<()> {
    let base = std::env::var("UART_PUBLIC_DIR").unwrap_or_else(|_| "dist/hub/public".to_string());
    let path = std::path::Path::new(&base).join(rel);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let mime = match path.extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "text/javascript; charset=utf-8",
                Some("css") => "text/css; charset=utf-8",
                Some("svg") => "image/svg+xml",
                _ => "application/octet-stream",
            };
            request.respond(Response::from_data(bytes).with_header(header("Content-Type", mime)))
        }
        Err(_) => respond_json(request, 404, json_error("Not found")),
    }
}

fn read_json(request: &mut tiny_http::Request) -> Result<Value, String> {
    let mut body = String::new();
    request.as_reader().take(1_000_000).read_to_string(&mut body).map_err(|e| e.to_string())?;
    if body.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&body).map_err(|e| format!("Invalid JSON body: {e}"))
}

fn respond_json(request: tiny_http::Request, status: u16, body: Value) -> std::io::Result<()> {
    let text = body.to_string();
    let response = Response::from_string(text)
        .with_status_code(StatusCode(status))
        .with_header(header("Content-Type", "application/json; charset=utf-8"))
        .with_header(header("Cache-Control", "no-store"));
    request.respond(response)
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next().unwrap_or("").to_string();
            let value = parts.next().unwrap_or("").to_string();
            (key, urldecode(&value))
        })
        .collect()
}

fn urldecode(value: &str) -> String {    let mut out = String::new();
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte as char);
                    i += 3;
                    continue;
                }
                out.push('%');
                i += 1;
            }
            b'+' => {
                out.push(' ');
                i += 1;
            }
            b => {
                out.push(b as char);
                i += 1;
            }
        }
    }
    out
}
