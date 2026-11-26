//! Pure helpers for the MCP tool surface: static capability tables, field
//! extraction and self-contained HTML reports. Kept separate from mcp.rs so
//! the transport loop stays readable.

use serde_json::{json, Value};

use crate::model::{Direction, SerialMessage};

/// Encodings accepted by `serial_open` / `serial_write` / capture `send`.
pub fn list_encodings() -> Vec<Value> {
    [
        ("utf8", "UTF-8 (default, universal Unicode)"),
        ("ascii", "7-bit ASCII"),
        ("latin1", "ISO-8859-1 / Latin-1 (Western European)"),
        ("gbk", "GBK (Simplified Chinese, Windows)"),
        ("gb2312", "GB2312 (Simplified Chinese, basic)"),
        ("gb18030", "GB18030 (Simplified Chinese, full)"),
        ("big5", "Big5 (Traditional Chinese)"),
        ("shift_jis", "Shift_JIS (Japanese)"),
        ("euc-kr", "EUC-KR (Korean)"),
        ("hex", "Hexadecimal string (e.g. '48656C6C6F')"),
        ("base64", "Base64 encoded"),
        ("binary", "Binary / raw hex (same as hex)"),
    ]
    .iter()
    .map(|(name, desc)| json!({ "name": name, "description": desc }))
    .collect()
}

/// Framing protocols accepted by `serial_open` / `configure`.
pub fn list_protocols() -> Vec<Value> {
    [
        ("raw", "No parsing — raw byte stream, data delivered as-is"),
        ("line", "Line-based — splits on \\r\\n (newline-delimited)"),
        ("delimiter", "Custom delimiter — splits on configurable hex byte sequence"),
        ("modbus-rtu", "Modbus RTU — detects frame boundaries by inter-frame silence gap"),
        ("hex-frame", "Hex frame — extracts data between configurable start/end hex markers"),
        ("slip", "SLIP (RFC 1055) — de-frames SLIP-encoded packets (END=0xC0, ESC=0xDB)"),
    ]
    .iter()
    .map(|(name, desc)| json!({ "name": name, "description": desc }))
    .collect()
}

fn messages_json(messages: &[SerialMessage]) -> Vec<Value> {
    messages.iter().map(|m| {
        json!({
            "timestamp": m.timestamp,
            "direction": match m.direction { Direction::Rx => "rx", Direction::Tx => "tx" },
            "raw": m.raw,
            "data": m.data,
            "length": m.length,
        })
    }).collect()
}

/// Resolve an index token like "0", "-1", "last" into a valid index.
fn resolve_index(token: &str, len: usize) -> Option<usize> {
    match token.trim() {
        "last" | "-1" => len.checked_sub(1),
        "first" | "0" => if len > 0 { Some(0) } else { None },
        other => {
            let n: isize = other.parse().ok()?;
            if n < 0 { len.checked_sub(n.unsigned_abs()) } else { Some(n as usize) }.filter(|i| *i < len)
        }
    }
}

/// Extract one value from buffered messages via a path.
/// Supports: last.raw, last.data, messages[i].raw|data|length|timestamp,
/// rx.count, tx.count, rxHex, rxText, totalBytes, hex, count.
pub fn extract(messages: &[SerialMessage], path: &str) -> Result<Value, String> {
    let rx: Vec<&SerialMessage> = messages.iter().filter(|m| m.direction == Direction::Rx).collect();
    let tx: Vec<&SerialMessage> = messages.iter().filter(|m| m.direction == Direction::Tx).collect();
    let total_bytes: usize = messages.iter().map(|m| m.length).sum();
    let rx_hex: String = rx.iter().map(|m| m.raw.as_str()).collect::<Vec<_>>().join("");
    let rx_text: String = rx.iter().map(|m| m.data.as_str()).collect::<Vec<_>>().join("");
    let all_hex: String = messages.iter().map(|m| m.raw.as_str()).collect::<Vec<_>>().join("");

    let field = |m: &SerialMessage, f: &str| -> Value {
        match f {
            "raw" => json!(m.raw),
            "data" => json!(m.data),
            "length" => json!(m.length),
            "timestamp" => json!(m.timestamp),
            "direction" => json!(match m.direction { Direction::Rx => "rx", Direction::Tx => "tx" }),
            _ => Value::Null,
        }
    };

    let p = path.trim();
    let result = if let Some(rest) = p.strip_prefix("messages[") {
        let close = rest.find(']').ok_or("bad path: expected messages[i].field")?;
        let idx_token = &rest[..close];
        let after = rest[close + 1..].trim_start_matches('.');
        let idx = resolve_index(idx_token, messages.len()).ok_or("index out of range")?;
        field(&messages[idx], after)
    } else if let Some(rest) = p.strip_prefix("last.") {
        let m = messages.last().ok_or("no messages")?;
        field(m, rest)
    } else if let Some(rest) = p.strip_prefix("first.") {
        let m = messages.first().ok_or("no messages")?;
        field(m, rest)
    } else {
        match p {
            "rx.count" => json!(rx.len()),
            "tx.count" => json!(tx.len()),
            "rxHex" => json!(rx_hex),
            "rxText" => json!(rx_text),
            "hex" => json!(all_hex),
            "totalBytes" => json!(total_bytes),
            "count" => json!(messages.len()),
            other => return Err(format!("unknown extract path: {other}")),
        }
    };
    Ok(result)
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
        .replace('"', "&quot;").replace('\'', "&#39;")
}

/// Render buffered frames as a self-contained HTML timeline.
pub fn render_timeline_html(title: &str, meta: &str, messages: &[SerialMessage]) -> String {
    let rows = messages.iter().map(|m| {
        let dir = match m.direction { Direction::Rx => "RX", Direction::Tx => "TX" };
        let cls = match m.direction { Direction::Rx => "rx", Direction::Tx => "tx" };
        format!(
            "<tr class=\"{}\"><td class=\"t\">{}</td><td class=\"d\">{}</td><td class=\"l\">{}B</td><td class=\"h\">{}</td><td class=\"a\">{}</td></tr>",
            cls,
            esc(&m.timestamp.get(11..23).unwrap_or(&m.timestamp)),
            dir,
            m.length,
            esc(&m.raw),
            esc(&m.data),
        )
    }).collect::<Vec<_>>().join("\n");
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title><style>\n\
         body{{font:13px ui-monospace,Consolas,monospace;background:#0f1115;color:#d7dae0;margin:0;padding:18px}}\n\
         h1{{font-size:17px;margin:0 0 4px}} .meta{{color:#8b93a1;margin-bottom:14px}}\n\
         table{{border-collapse:collapse;width:100%}} th,td{{text-align:left;padding:4px 8px;border-bottom:1px solid #232733}}\n\
         th{{color:#8b93a1;position:sticky;top:0;background:#0f1115}} .rx .d{{color:#4ade80}} .tx .d{{color:#fbbf24}}\n\
         .t{{color:#6b7280}} .l{{color:#9ca3af}} .h{{color:#93c5fd}}\n\
         </style></head><body><h1>{}</h1><div class=\"meta\">{}</div>\n\
         <table><thead><tr><th>time</th><th>dir</th><th>len</th><th>hex</th><th>data</th></tr></thead>\n\
         <tbody>{}</tbody></table></body></html>",
        esc(title), esc(title), esc(meta), rows
    )
}

/// Render smoke-run steps as a self-contained HTML report.
pub fn render_smoke_html(title: &str, result: &Value) -> String {
    let steps = result.get("steps").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let rows = steps.iter().map(|s| {
        let verdict = s.get("verdict").and_then(|v| v.as_str()).unwrap_or("");
        let cls = if verdict == "PASS" { "pass" } else { "fail" };
        format!(
            "<tr class=\"{}\"><td>{}</td><td>{}</td><td>{}</td><td>{}ms</td></tr>",
            cls,
            esc(verdict),
            esc(s.get("command").and_then(|v| v.as_str()).unwrap_or("")),
            esc(s.get("title").and_then(|v| v.as_str()).unwrap_or("")),
            s.get("elapsedMs").and_then(|v| v.as_u64()).unwrap_or(0),
        )
    }).collect::<Vec<_>>().join("\n");
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title><style>\n\
         body{{font:13px ui-monospace,Consolas,monospace;background:#0f1115;color:#d7dae0;margin:0;padding:18px}}\n\
         h1{{font-size:17px}} .pass{{color:#4ade80}} .fail{{color:#f87171}}\n\
         table{{border-collapse:collapse;width:100%}} th,td{{text-align:left;padding:5px 8px;border-bottom:1px solid #232733}}\n\
         </style></head><body><h1>{}</h1>\n\
         <div>PASS {} · FAIL {} · REPORT {} · {}ms</div>\n\
         <table><thead><tr><th>verdict</th><th>command</th><th>title</th><th>elapsed</th></tr></thead>\n\
         <tbody>{}</tbody></table></body></html>",
        esc(title), esc(title),
        result.get("passed").and_then(|v| v.as_u64()).unwrap_or(0),
        result.get("failed").and_then(|v| v.as_u64()).unwrap_or(0),
        result.get("report").and_then(|v| v.as_u64()).unwrap_or(0),
        result.get("elapsedMs").and_then(|v| v.as_u64()).unwrap_or(0),
        rows,
    )
}

pub fn write_report(path: &str, html: &str) -> Result<String, String> {
    std::fs::write(path, html).map_err(|e| format!("cannot write {path}: {e}"))?;
    Ok(path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(raw: &str, data: &str, dir: Direction) -> SerialMessage {
        SerialMessage {
            timestamp: "2026-01-01T00:00:00.000Z".into(),
            connection_id: "c".into(), data: data.into(), raw: raw.into(),
            length: raw.len() / 2, direction: dir,
        }
    }

    #[test]
    fn extract_paths() {
        let msgs = vec![
            msg("AA01", "a", Direction::Rx),
            msg("BB02", "b", Direction::Rx),
            msg("CC03", "tx", Direction::Tx),
        ];
        assert_eq!(extract(&msgs, "last.raw").unwrap(), json!("CC03"));
        assert_eq!(extract(&msgs, "messages[-2].data").unwrap(), json!("b"));
        assert_eq!(extract(&msgs, "rx.count").unwrap(), json!(2));
        assert_eq!(extract(&msgs, "rxHex").unwrap(), json!("AA01BB02"));
        assert_eq!(extract(&msgs, "totalBytes").unwrap(), json!(6));
        assert!(extract(&msgs, "bogus").is_err());
    }

    #[test]
    fn static_tables_nonempty() {
        assert_eq!(list_encodings().len(), 12);
        assert_eq!(list_protocols().len(), 6);
    }

    #[test]
    fn html_rendering_escapes() {
        let msgs = vec![msg("AA", "<script>", Direction::Rx)];
        let html = render_timeline_html("t", "m", &msgs);
        assert!(html.contains("&lt;script&gt;"));
        assert!(!html.contains("<script>"));
    }
}
