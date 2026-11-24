//! Minimal MCP stdio server (JSON-RPC 2.0, newline-delimited).
//!
//! Tool surface parity with the Node build for the serial primitives; the DUT
//! tools land in milestone 3 (see rust/README.md). Keeping the transport hand
//! rolled avoids a heavy async runtime for what is a line-oriented loop.

use std::io::{BufRead, Write};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::model::SerialConfig;
use crate::serial::SerialManager;

pub fn serve(manager: Arc<SerialManager>) -> std::io::Result<()> {
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
                match call_tool(&manager, name, &args) {
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

fn tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "serial_list_ports",
            "description": "List the serial ports available on this machine.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "serial_open",
            "description": "Open a serial port and return its connection id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "baudRate": { "type": "number" },
                    "encoding": { "type": "string" },
                    "protocol": { "type": "string", "enum": ["line", "raw", "delimiter", "modbus-rtu", "hex-frame", "slip"] }
                },
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_write",
            "description": "Write data to an open connection.",
            "inputSchema": {
                "type": "object",
                "properties": { "connectionId": { "type": "string" }, "data": { "type": "string" }, "encoding": { "type": "string" } },
                "required": ["connectionId", "data"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_read",
            "description": "Read buffered frames from a connection.",
            "inputSchema": {
                "type": "object",
                "properties": { "connectionId": { "type": "string" }, "count": { "type": "number" }, "direction": { "type": "string" } },
                "required": ["connectionId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_status",
            "description": "Report the open connections and their counters.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "serial_close",
            "description": "Close a connection.",
            "inputSchema": {
                "type": "object",
                "properties": { "connectionId": { "type": "string" } },
                "required": ["connectionId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_set_signals",
            "description": "Toggle DTR/RTS or pulse BREAK.",
            "inputSchema": {
                "type": "object",
                "properties": { "connectionId": { "type": "string" }, "dtr": { "type": "boolean" }, "rts": { "type": "boolean" }, "break": { "type": "boolean" } },
                "required": ["connectionId"],
                "additionalProperties": false
            }
        }),
    ]
}

fn call_tool(manager: &Arc<SerialManager>, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "serial_list_ports" => {
            let ports = manager.list_ports();
            Ok(serde_json::to_string_pretty(&json!({ "ports": ports })).unwrap_or_default())
        }
        "serial_open" => {
            let mut config = SerialConfig::default();
            config.path = args.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if config.path.is_empty() {
                return Err("path is required".into());
            }
            if let Some(v) = args.get("baudRate").and_then(|v| v.as_u64()) {
                config.baud_rate = v as u32;
            }
            if let Some(v) = args.get("encoding").and_then(|v| v.as_str()) {
                config.encoding = v.to_string();
            }
            if let Some(v) = args.get("protocol").and_then(|v| v.as_str()) {
                config.protocol = v.to_string();
            }
            let (id, info) = manager.open(config)?;
            Ok(format!("opened {id} on {} @ {}", info.config.path, info.config.baud_rate))
        }
        "serial_write" => {
            let id = args.get("connectionId").and_then(|v| v.as_str()).unwrap_or("");
            let data = args.get("data").and_then(|v| v.as_str()).unwrap_or("");
            let encoding = args.get("encoding").and_then(|v| v.as_str());
            let (written, raw) = manager.write(id, data, encoding)?;
            Ok(format!("wrote {written} bytes ({raw})"))
        }
        "serial_read" => {
            let id = args.get("connectionId").and_then(|v| v.as_str()).unwrap_or("");
            let count = args.get("count").and_then(|v| v.as_u64()).map(|v| v as usize);
            let messages = manager.messages(id, count);
            Ok(serde_json::to_string_pretty(&json!({ "frames": messages.iter().map(|m| m.to_wire()).collect::<Vec<_>>() })).unwrap_or_default())
        }
        "serial_status" => {
            let connections = manager.list_connections();
            Ok(serde_json::to_string_pretty(&json!({ "connections": connections })).unwrap_or_default())
        }
        "serial_close" => {
            let id = args.get("connectionId").and_then(|v| v.as_str()).unwrap_or("");
            manager.close(id)?;
            Ok(format!("closed {id}"))
        }
        "serial_set_signals" => {
            let id = args.get("connectionId").and_then(|v| v.as_str()).unwrap_or("");
            manager.set_signals(
                id,
                args.get("break").and_then(|v| v.as_bool()),
                args.get("dtr").and_then(|v| v.as_bool()),
                args.get("rts").and_then(|v| v.as_bool()),
            )?;
            Ok("signals applied".into())
        }
        other => Err(format!("Unknown tool: {other}")),
    }
}
