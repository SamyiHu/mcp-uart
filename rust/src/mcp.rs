//! MCP stdio server (JSON-RPC 2.0, newline-delimited).
//!
//! Three grouped tools, matching the Node build and the DSH-native tools:
//!   uart_serial  serial port control
//!   uart_orchestrator     Orchestrator (orchestrator) profiles and smoke runs
//!   uart_view    frames / history / visualisations
//!
//! Keeping the transport hand rolled avoids a heavy async runtime for what is
//! a line-oriented loop.

use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use std::collections::HashMap;

use serde_json::{json, Value};

use crate::orchestrator::{OrchestratorEvent, OrchestratorManager};
use crate::model::SerialConfig;
use crate::serial::SerialManager;

/// A running file-log monitor, keyed by connection id.
struct MonitorEntry {
    log_path: String,
    started: Instant,
    count: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
}
type Monitors = Arc<Mutex<HashMap<String, MonitorEntry>>>;

pub fn serve(manager: Arc<SerialManager>) -> std::io::Result<()> {
    // MCP stdio has its own serial stack (and its own Orchestrator sessions) — it is a
    // separate process from the Hub. Load the shipped profiles from the repo.
    let profiles_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("src")
        .join("orchestrator")
        .join("profiles");
    let orchestrator = OrchestratorManager::new(manager.clone(), &profiles_dir);
    let monitors: Monitors = Arc::new(Mutex::new(HashMap::new()));
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(err) => {
                let _ = writeln!(stdout, "{}", json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":err.to_string()}}));
                let _ = stdout.flush();
                continue;
            }
        };

        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or(json!({}));

        let response = match method {
            "initialize" => Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "uartd", "version": env!("CARGO_PKG_VERSION") }
                }
            })),
            "notifications/initialized" => None,
            "tools/list" => Some(json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tool_schemas() } })),
            "tools/call" => {
                let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                match call_tool(&manager, &orchestrator, &monitors, name, &args) {
                    Ok(text) => Some(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "content": [ { "type": "text", "text": text } ], "isError": false }
                    })),
                    Err(err) => Some(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "content": [ { "type": "text", "text": err } ], "isError": true }
                    })),
                }
            }
            _ => Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {method}") }
            })),
        };

        if let Some(payload) = response {
            let _ = writeln!(stdout, "{}", payload);
            let _ = stdout.flush();
        }
    }
    Ok(())
}

/// Input schema shared shape: `action` enum plus the merged parameters of the
/// member operations. All fields are optional so a single schema can serve all
/// actions; the chosen action is validated in call_tool.
fn serial_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list_ports","open","close","write","read","capture","extract","wait","wait_frame","start_monitor","stop_monitor","status","reconfigure","list_encodings","list_protocols","set_signals","configure"],
                "description": "Operation to run."
            },
            "path": { "type": "string", "description": "Serial port, e.g. COM6 or /dev/ttyUSB0." },
            "baudRate": { "type": "integer", "description": "Baud rate (default 115200)." },
            "data": { "type": "string", "description": "Payload to send." },
            "encoding": { "type": "string", "description": "utf8 | gbk | gb18030 | big5 | shift_jis | euc-kr | latin1 | hex | base64." },
            "protocol": { "type": "string", "enum": ["line","raw","delimiter","modbus-rtu","hex-frame","slip"] },
            "count": { "type": "integer", "description": "How many recent frames to return." },
            "direction": { "type": "string", "enum": ["all","rx","tx"] },
            "dtr": { "type": "boolean" },
            "rts": { "type": "boolean" },
            "break": { "type": "boolean" },
            "timeoutMs": { "type": "integer", "description": "capture: hard upper bound (ms)." },
            "silenceMs": { "type": "integer", "description": "capture: stop after this much RX silence." },
            "send": { "type": "object", "description": "capture: optional trigger written at t0, e.g. {data, encoding}." },
            "filter": { "type": "object", "description": "capture: direction/matchHex/matchText/minLength/maxLength." },
            "stop": { "type": "object", "description": "capture: bytes/frames/untilHex/untilText conditions (first match wins)." },
            "startHex": { "type": "string", "description": "capture: drop frames before this HEX marker." },
            "includeTx": { "type": "boolean", "description": "capture: include TX frames (default false)." },
            "path_spec": { "type": "string", "description": "extract: field path, e.g. last.raw / rxHex / messages[-1].data." },
            "logPath": { "type": "string", "description": "start_monitor: output log path." },
            "matchHex": { "type": "string", "description": "wait/wait_frame: keep frames whose raw hex contains this." },
            "matchText": { "type": "string", "description": "wait/wait_frame: keep frames whose text contains this." },
            "timeout": { "type": "integer", "description": "wait_frame: timeout in ms (default 5000)." }
        },
        "required": ["action"],
        "additionalProperties": false
    })
}

fn orchestrator_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list","connect","disconnect","run","sequence","smoke","status"],
                "description": "Operation to run."
            },
            "profile": { "type": "string", "description": "Profile name." },
            "path": { "type": "string" },
            "baudRate": { "type": "integer" },
            "name": { "type": "string", "description": "Command name for action=run." },
            "actions": { "type": "array", "items": { "type": "object" }, "description": "Action list for action=sequence." },
            "options": { "type": "object", "description": "totalBudgetMs / abortOnError / captureFrames." },
            "includeLowPower": { "type": "boolean" }
        },
        "required": ["action"],
        "additionalProperties": false
    })
}

fn view_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["panel","frames","history","ports","visualize","visualize_smoke"],
                "description": "Operation to run."
            },
            "limit": { "type": "integer" },
            "offset": { "type": "integer" },
            "text": { "type": "string" },
            "hex": { "type": "string" },
            "direction": { "type": "string", "enum": ["all","rx","tx"] },
            "outputPath": { "type": "string", "description": "visualize: output .html path." },
            "title": { "type": "string", "description": "visualize: report title." }
        },
        "required": ["action"],
        "additionalProperties": false
    })
}

fn tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "uart_serial",
            "title": "Serial port",
            "description": "Serial port control: list ports, open/close, send and read data, condition-driven capture, modem signals, live encoding/framing changes. Select the operation with `action`.",
            "inputSchema": serial_parameters()
        }),
        json!({
            "name": "uart_orchestrator",
            "title": "Orchestrator test profiles",
            "description": "Profile-driven Orchestrator testing: list profiles, connect, run a command or the smoke sequence, and read session status. Select the operation with `action`.",
            "inputSchema": orchestrator_parameters()
        }),
        json!({
            "name": "uart_view",
            "title": "Serial views",
            "description": "Read-side view: panel/Hub status, buffered frames, archived history with text/HEX search, and port details. Select the operation with `action`.",
            "inputSchema": view_parameters()
        }),
    ]
}

fn call_tool(manager: &Arc<SerialManager>, orchestrator: &Arc<OrchestratorManager>, monitors: &Monitors, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "uart_serial" => call_serial(manager, monitors, args),
        "uart_orchestrator" => call_orchestrator(orchestrator, args),
        "uart_view" => call_view(manager, monitors, args),
        // Accept the old flat names too, so any stale caller keeps working.
        "serial_list_ports" => call_serial(manager, monitors, &json!({"action":"list_ports"})),
        "serial_open" => call_serial(manager, monitors, &json!({"action":"open","path":args.get("path").cloned().unwrap_or(Value::Null),"baudRate":args.get("baudRate").cloned().unwrap_or(Value::Null)})),
        "serial_write" => call_serial(manager, monitors, &json!({"action":"write","data":args.get("data").cloned().unwrap_or(Value::Null),"encoding":args.get("encoding").cloned().unwrap_or(Value::Null)})),
        "serial_read" => call_serial(manager, monitors, &json!({"action":"read","count":args.get("count").cloned().unwrap_or(Value::Null)})),
        "serial_status" => call_serial(manager, monitors, &json!({"action":"status"})),
        "serial_close" => call_serial(manager, monitors, &json!({"action":"close"})),
        "serial_set_signals" => call_serial(manager, monitors, &json!({"action":"set_signals","dtr":args.get("dtr").cloned().unwrap_or(Value::Null),"rts":args.get("rts").cloned().unwrap_or(Value::Null),"break":args.get("break").cloned().unwrap_or(Value::Null)})),
        other => Err(format!("Unknown tool: {other}")),
    }
}

fn active_id(manager: &Arc<SerialManager>) -> Result<String, String> {
    manager
        .list_connections()
        .into_iter()
        .find(|c| c.status == "open")
        .map(|c| c.id)
        .ok_or_else(|| "Not connected".into())
}

fn call_serial(manager: &Arc<SerialManager>, monitors: &Monitors, args: &Value) -> Result<String, String> {
    let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("");
    match action {
        "list_ports" => {
            let ports = manager.list_ports();
            if ports.is_empty() { return Ok("No serial ports found.".into()); }
            Ok(ports.iter().map(|p| {
                let mut parts = vec![p.path.clone()];
                if let Some(m) = &p.manufacturer { parts.push(m.clone()); }
                if let (Some(v), Some(pr)) = (&p.vendor_id, &p.product_id) { parts.push(format!("{v}:{pr}")); }
                parts.join("  ")
            }).collect::<Vec<_>>().join("\n"))
        }
        "open" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            if path.is_empty() { return Err("path is required".into()); }
            let mut config = SerialConfig::default();
            config.path = path.to_string();
            if let Some(v) = args.get("baudRate").and_then(|v| v.as_u64()) { config.baud_rate = v as u32; }
            if let Some(v) = args.get("encoding").and_then(|v| v.as_str()) { config.encoding = v.to_string(); }
            if let Some(v) = args.get("protocol").and_then(|v| v.as_str()) { config.protocol = v.to_string(); }
            let (id, info) = manager.open(config)?;
            Ok(format!("opened {id} on {} @ {}", info.config.path, info.config.baud_rate))
        }
        "close" => {
            let id = args.get("connectionId").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| active_id(manager).unwrap_or_default());
            manager.close(&id)?;
            Ok(format!("closed {id}"))
        }
        "write" => {
            let id = args.get("connectionId").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| active_id(manager).unwrap_or_default());
            let data = args.get("data").and_then(|v| v.as_str()).unwrap_or("");
            if data.is_empty() { return Err("data is required".into()); }
            let encoding = args.get("encoding").and_then(|v| v.as_str());
            let (written, raw) = manager.write(&id, data, encoding)?;
            Ok(format!("wrote {written} bytes  HEX: {raw}"))
        }
        "read" => {
            let id = args.get("connectionId").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| active_id(manager).unwrap_or_default());
            let count = args.get("count").and_then(|v| v.as_u64()).map(|v| v as usize).unwrap_or(50).min(500);
            let messages = manager.messages(&id, Some(count));
            if messages.is_empty() { return Ok("No frames buffered.".into()); }
            Ok(messages.iter().map(frame_line).collect::<Vec<_>>().join("\n"))
        }
        "capture" => {
            let id = match args.get("connectionId").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => active_id(manager)?,
            };
            let mut params = json!({});
            if let Some(v) = args.get("timeoutMs") { params["timeoutMs"] = v.clone(); }
            if let Some(v) = args.get("silenceMs") { params["silenceMs"] = v.clone(); }
            if let Some(v) = args.get("send") { params["send"] = v.clone(); }
            if let Some(v) = args.get("filter") { params["filter"] = v.clone(); }
            if let Some(v) = args.get("stop") { params["stop"] = v.clone(); }
            if let Some(v) = args.get("startHex") { params["startHex"] = v.clone(); }
            if let Some(v) = args.get("includeTx") { params["includeTx"] = v.clone(); }
            if params.get("timeoutMs").is_none() { params["timeoutMs"] = json!(3000); }
            let result = crate::capture::capture(manager, &id, &params)?;
            Ok(format_capture(&result))
        }
        "extract" => {
            let id = args.get("connectionId").and_then(|v| v.as_str()).map(|s| s.to_string())
                .unwrap_or_else(|| active_id(manager).unwrap_or_default());
            let path = args.get("path_spec").or_else(|| args.get("path"))
                .and_then(|v| v.as_str()).ok_or("path is required")?;
            let mut messages = manager.messages(&id, None);
            // sinceLastRead is handled by the caller via read cursor; here we
            // simply extract from the live buffer (the Node cursor is per-tool).
            if let Some(dir) = args.get("direction").and_then(|v| v.as_str()) {
                if dir != "all" {
                    let want = if dir == "tx" { crate::model::Direction::Tx } else { crate::model::Direction::Rx };
                    messages.retain(|m| m.direction == want);
                }
            }
            let value = crate::mcp_extra::extract(&messages, path)?;
            Ok(format!("{path} = {value}"))
        }
        "wait" | "wait_frame" => {
            let id = match args.get("connectionId").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(), None => active_id(manager)?,
            };
            let timeout = args.get("timeout").and_then(|v| v.as_u64()).unwrap_or(5000);
            let silence = args.get("silenceTimeout").and_then(|v| v.as_u64()).unwrap_or(500).min(timeout);
            let mut stop = json!({});
            if action == "wait_frame" { stop["frames"] = json!(1); }
            let mut params = json!({
                "timeoutMs": timeout,
                "stop": stop,
            });
            if action == "wait" { params["silenceMs"] = json!(silence); }
            if let Some(v) = args.get("matchHex") { params["filter"] = json!({"matchHex": v}); }
            if let Some(v) = args.get("matchText") { params["filter"] = json!({"matchText": v}); }
            let result = crate::capture::capture(manager, &id, &params)?;
            Ok(format_capture(&result))
        }
        "start_monitor" => {
            let id = match args.get("connectionId").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(), None => active_id(manager)?,
            };
            let mut guards = monitors.lock().unwrap();
            if guards.contains_key(&id) { return Err("Monitor already running; stop it first".into()); }
            let log_path = args.get("logPath").and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("serial_{}_{}.log", id, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()));
            let file = std::fs::OpenOptions::new().create(true).append(true).open(&log_path)
                .map_err(|e| format!("cannot open log: {e}"))?;
            let stop = Arc::new(AtomicBool::new(false));
            let count = Arc::new(AtomicU64::new(0));
            // Header.
            {
                let mut f = &file;
                let _ = writeln!(f, "=== Serial Monitor Started ===");
                let _ = writeln!(f, "Connection: {id}");
                let _ = writeln!(f, "Time: {}", crate::util::now_iso());
            }
            let sub = manager.subscribe();
            let sid = id.clone();
            let sstop = Arc::clone(&stop);
            let scount = Arc::clone(&count);
            std::thread::spawn(move || {
                let mut file = file;
                let rx = sub.0;
                while !sstop.load(Ordering::Relaxed) {
                    match rx.recv_timeout(std::time::Duration::from_millis(200)) {
                        Ok((wire_id, msg)) if wire_id == sid => {
                            let dir = match msg.direction { crate::model::Direction::Rx => "RX", crate::model::Direction::Tx => "TX" };
                            let _ = writeln!(file, "{} {} {} {}", msg.timestamp, dir, msg.raw, msg.data);
                            let _ = file.flush();
                            scount.fetch_add(1, Ordering::Relaxed);
                        }
                        Ok(_) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                let _ = writeln!(file, "=== Monitor Stopped ===");
            });
            guards.insert(id.clone(), MonitorEntry {
                log_path: log_path.clone(), started: Instant::now(), count, stop,
            });
            Ok(format!("Monitor log: {log_path}\nStop with action=stop_monitor."))
        }
        "stop_monitor" => {
            let id = match args.get("connectionId").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(), None => active_id(manager)?,
            };
            let mut guards = monitors.lock().unwrap();
            let entry = guards.remove(&id).ok_or("No monitor running for this connection")?;
            entry.stop.store(true, Ordering::Relaxed);
            Ok(format!("Monitor stopped: {} ({} messages, {}ms)",
                entry.log_path, entry.count.load(Ordering::Relaxed), entry.started.elapsed().as_millis()))
        }
        "list_encodings" => {
            let encs = crate::mcp_extra::list_encodings();
            Ok(encs.iter().map(|e| format!("  {:<12} — {}", e["name"].as_str().unwrap_or(""), e["description"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n"))
        }
        "list_protocols" => {
            let protos = crate::mcp_extra::list_protocols();
            Ok(protos.iter().map(|p| format!("  {:<14} — {}", p["name"].as_str().unwrap_or(""), p["description"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n"))
        }
        "reconfigure" => {
            let id = args.get("connectionId").and_then(|v| v.as_str()).map(|s| s.to_string())
                .unwrap_or_else(|| active_id(manager).unwrap_or_default());
            let mut updates = json!({});
            if let Some(v) = args.get("encoding") { updates["encoding"] = v.clone(); }
            if let Some(v) = args.get("protocol") { updates["protocol"] = v.clone(); }
            if let Some(v) = args.get("baudRate") { updates["baudRate"] = v.clone(); }
            manager.reconfigure(&id, &updates)?;
            Ok(format!("reconfigured: {updates}"))
        }
        "status" => {
            let connections = manager.list_connections();
            let active = connections.iter().find(|c| c.status == "open");
            let mut lines = vec![
                format!("connections: {}", connections.len()),
                match active { Some(c) => format!("active: {} @ {} ({})", c.config.path, c.config.baud_rate, c.config.encoding), None => "active: (none)".into() },
            ];
            if let Some(c) = active { lines.push(format!("frames: {}", c.message_count)); }
            Ok(lines.join("\n"))
        }
        "set_signals" => {
            let id = args.get("connectionId").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| active_id(manager).unwrap_or_default());
            manager.set_signals(&id,
                args.get("break").and_then(|v| v.as_bool()),
                args.get("dtr").and_then(|v| v.as_bool()),
                args.get("rts").and_then(|v| v.as_bool()))?;
            Ok("signals applied".into())
        }
        "configure" => {
            let id = args.get("connectionId").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| active_id(manager).unwrap_or_default());
            let mut updates = json!({});
            if let Some(v) = args.get("encoding") { updates["encoding"] = v.clone(); }
            if let Some(v) = args.get("protocol") { updates["protocol"] = v.clone(); }
            if let Some(v) = args.get("baudRate") { updates["baudRate"] = v.clone(); }
            manager.reconfigure(&id, &updates)?;
            Ok(format!("reconfigured: {updates}"))
        }
        other => Err(format!("Unknown uart_serial action: {other}")),
    }
}

fn frame_line(message: &crate::model::SerialMessage) -> String {
    let time = message.timestamp.get(11..23).unwrap_or(&message.timestamp);
    let dir = match message.direction { crate::model::Direction::Tx => "TX", crate::model::Direction::Rx => "RX" };
    let body = match message.direction { crate::model::Direction::Tx => &message.raw, crate::model::Direction::Rx => &message.data };
    format!("{time} {dir}  {body}")
}

fn format_capture(result: &Value) -> String {
    let reason = result.get("reason").and_then(|v| v.as_str()).unwrap_or("");
    let elapsed = result.get("elapsedMs").and_then(|v| v.as_u64()).unwrap_or(0);
    let count = result.get("frameCount").and_then(|v| v.as_u64()).unwrap_or(0);
    let bytes = result.get("totalBytes").and_then(|v| v.as_u64()).unwrap_or(0);
    let frames = result.get("frames").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let lines = frames.iter().map(|f| {
        let t = f.get("tMs").and_then(|v| v.as_u64()).unwrap_or(0);
        let dir = f.get("direction").and_then(|v| v.as_str()).unwrap_or("");
        let raw = f.get("raw").and_then(|v| v.as_str()).unwrap_or("");
        let data = f.get("data").and_then(|v| v.as_str()).unwrap_or("");
        format!("+{t:>5}ms  {dir:<2}  {raw:<24}  {data}")
    }).collect::<Vec<_>>().join("\n");
    format!("captured {count} frame(s), {bytes}B in {elapsed}ms (reason={reason})\n{lines}")
}

fn call_view(manager: &Arc<SerialManager>, _monitors: &Monitors, args: &Value) -> Result<String, String> {
    let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("");
    match action {
        "ports" => {
            let ports = manager.list_ports();
            if ports.is_empty() { return Ok("No serial ports found.".into()); }
            Ok(ports.iter().map(|p| serde_json::to_string(p).unwrap_or_default()).collect::<Vec<_>>().join("\n"))
        }
        "panel" => call_serial(manager, _monitors, &json!({"action":"status"})),
        "frames" => {
            let id = args.get("connectionId").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| active_id(manager).unwrap_or_default());
            let count = args.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize).unwrap_or(50).min(500);
            let messages = manager.messages(&id, Some(count));
            if messages.is_empty() { return Ok("No frames buffered.".into()); }
            Ok(messages.iter().map(frame_line).collect::<Vec<_>>().join("\n"))
        }
        "history" => {
            // The Hub owns the cross-reconnect archive; MCP stdio has its own
            // SerialManager with no Hub, so report the live buffer instead.
            let id = args.get("connectionId").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(|| active_id(manager).unwrap_or_default());
            let count = args.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize).unwrap_or(50).min(500);
            let messages = manager.messages(&id, Some(count));
            if messages.is_empty() { return Ok("No frames buffered.".into()); }
            Ok(messages.iter().map(frame_line).collect::<Vec<_>>().join("\n"))
        }
        "visualize" => {
            let id = args.get("connectionId").and_then(|v| v.as_str()).map(|s| s.to_string())
                .unwrap_or_else(|| active_id(manager).unwrap_or_default());
            let count = args.get("count").or_else(|| args.get("limit"))
                .and_then(|v| v.as_u64()).map(|v| v as usize).unwrap_or(200).min(2000);
            let mut messages = manager.messages(&id, Some(count));
            if let Some(dir) = args.get("direction").and_then(|v| v.as_str()) {
                if dir != "all" {
                    let want = if dir == "tx" { crate::model::Direction::Tx } else { crate::model::Direction::Rx };
                    messages.retain(|m| m.direction == want);
                }
            }
            let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("Serial timeline");
            let meta = format!("{} frames", messages.len());
            let html = crate::mcp_extra::render_timeline_html(title, &meta, &messages);
            let out = args.get("outputPath").and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("serial_viz_{}_{}.html", id,
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()));
            let path = crate::mcp_extra::write_report(&out, &html)?;
            Ok(format!("Timeline written ({} frames):\n  {path}\nOpen in a browser.", messages.len()))
        }
        "visualize_smoke" => {
            // The MCP stdio process has the Orchestrator manager; call it via a
            // fresh report. `args.result` may carry a prior smoke result; else
            // run the smoke sequence now.
            let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("Orchestrator smoke report");
            let result = match args.get("result") {
                Some(r) => r.clone(),
                None => return Err("visualize_smoke requires result (run smoke first)".into()),
            };
            let html = crate::mcp_extra::render_smoke_html(title, &result);
            let out = args.get("outputPath").and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("orchestrator_smoke_{}.html",
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()));
            let path = crate::mcp_extra::write_report(&out, &html)?;
            Ok(format!("Smoke report written:\n  {path}\nOpen in a browser."))
        }
        other => Err(format!("Unknown uart_view action: {other}")),
    }
}

fn call_orchestrator(orchestrator: &Arc<OrchestratorManager>, args: &Value) -> Result<String, String> {
    let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("");
    match action {
        "list" => {
            let profiles = orchestrator.profiles();
            if profiles.is_empty() { return Ok("No Orchestrator profiles installed.".into()); }
            Ok(profiles.iter().map(|p| {
                let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let desc = p.get("description").and_then(|v| v.as_str()).unwrap_or("");
                let cmds = p.get("commands").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|c| c.get("name").and_then(|v| v.as_str())).collect::<Vec<_>>().join(", ")).unwrap_or_default();
                format!("{name}: {desc}\n  commands: {cmds}")
            }).collect::<Vec<_>>().join("\n\n"))
        }
        "connect" => {
            let profile = args.get("profile").and_then(|v| v.as_str()).ok_or("profile is required")?;
            let path = args.get("path").and_then(|v| v.as_str());
            let baud = args.get("baudRate").and_then(|v| v.as_u64()).map(|v| v as u32);
            let (id, opened) = orchestrator.connect(profile, path, baud, None)?;
            Ok(format!("Orchestrator {profile} connected to {id}{}", if opened { " (port opened)" } else { " (attached)" }))
        }
        "disconnect" => {
            let id = orchestrator.status(None).get("connectionId").and_then(|v| v.as_str()).map(|s| s.to_string());
            orchestrator.disconnect(id, false)?;
            Ok("Orchestrator session closed".into())
        }
        "status" => {
            let s = orchestrator.status(None);
            Ok(format!("profile: {}\nconnected: {}\nbusy: {}",
                s.get("profile").and_then(|v| v.as_str()).unwrap_or("(none)"),
                s.get("connected").and_then(|v| v.as_bool()).unwrap_or(false),
                s.get("busy").and_then(|v| v.as_bool()).unwrap_or(false)))
        }
        "run" => {
            let name = args.get("name").and_then(|v| v.as_str()).ok_or("name is required")?;
            let id = orchestrator.status(None).get("connectionId").and_then(|v| v.as_str()).map(|s| s.to_string());
            let r = orchestrator.run_command(id, name)?;
            let mut lines = vec![format!("[{}] {} — {} ({}ms)", r.verdict, r.command, r.title, r.elapsed_ms)];
            if !r.failed_checks.is_empty() { lines.push(format!("failed: {}", r.failed_checks.join("; "))); }
            if !r.frames.is_empty() {
                let rx = r.frames.iter().map(|f| f.bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ")).collect::<Vec<_>>().join(" | ");
                lines.push(format!("rx: {rx}"));
            }
            Ok(lines.join("\n"))
        }
        "sequence" => {
            let actions = args.get("actions").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            if actions.is_empty() { return Err("actions[] is required".into()); }
            let options = args.get("options").cloned().unwrap_or(json!({}));
            let id = orchestrator.status(None).get("connectionId").and_then(|v| v.as_str()).map(|s| s.to_string());
            let result = orchestrator.run_sequence(id, &actions, &options)?;
            let stopped = result.get("stopped").and_then(|v| v.as_str()).unwrap_or("null");
            let elapsed = result.get("elapsedMs").and_then(|v| v.as_u64()).unwrap_or(0);
            let steps = result.get("steps").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let lines = steps.iter().map(|s| {
                let i = s.get("i").and_then(|v| v.as_u64()).unwrap_or(0);
                let action = s.get("action").and_then(|v| v.as_str()).unwrap_or("");
                let verdict = s.get("verdict").and_then(|v| v.as_str()).unwrap_or("");
                let at = s.get("atMs").and_then(|v| v.as_u64()).unwrap_or(0);
                format!("[{i}] {action} @{at}ms {verdict}")
            }).collect::<Vec<_>>().join("\n");
            Ok(format!("ok={} stopped={stopped} elapsed={elapsed}ms\n{lines}",
                result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false)))
        }
        "smoke" => {            let id = orchestrator.status(None).get("connectionId").and_then(|v| v.as_str()).map(|s| s.to_string());
            let low = args.get("includeLowPower").and_then(|v| v.as_bool()).unwrap_or(false);
            let result = orchestrator.run_smoke(id, low, &|_event: OrchestratorEvent| {})?;
            let steps = result.get("steps").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let head = format!("PASS {} · FAIL {} · REPORT {} ({}ms)",
                result.get("passed").and_then(|v| v.as_u64()).unwrap_or(0),
                result.get("failed").and_then(|v| v.as_u64()).unwrap_or(0),
                result.get("report").and_then(|v| v.as_u64()).unwrap_or(0),
                result.get("elapsedMs").and_then(|v| v.as_u64()).unwrap_or(0));
            let body = steps.iter().map(|s| {
                let verdict = s.get("verdict").and_then(|v| v.as_str()).unwrap_or("");
                let cmd = s.get("command").and_then(|v| v.as_str()).unwrap_or("");
                let title = s.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let ms = s.get("elapsedMs").and_then(|v| v.as_u64()).unwrap_or(0);
                format!("[{verdict}] {cmd} — {title} ({ms}ms)")
            }).collect::<Vec<_>>().join("\n");
            Ok(format!("{head}\n{body}"))
        }
        other => Err(format!("Unknown uart_orchestrator action: {other}")),
    }
}
