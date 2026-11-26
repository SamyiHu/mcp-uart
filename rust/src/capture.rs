//! Condition-driven serial capture with server-side timing.
//!
//! One call does trigger → collect → judge stop conditions → slice → return,
//! so the caller gets a single, precisely-timed record instead of polling
//! `read` (round-trip jitter) or writing an external script.
//!
//! All stop conditions are checked after every incoming frame:
//!   bytes / frames / untilHex / untilText / silenceMs / timeoutMs
//! The first one satisfied ends the capture (`reason` says which).

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::model::{Direction, SerialMessage};
use crate::serial::{SerialManager, Subscription};

fn hex_clean(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_uppercase()
}

fn msg_matches(m: &SerialMessage, filter: &Value) -> bool {
    if let Some(dir) = filter.get("direction").and_then(|v| v.as_str()) {
        if dir != "all" {
            let want = if dir == "tx" { Direction::Tx } else { Direction::Rx };
            if m.direction != want { return false; }
        }
    }
    if let Some(h) = filter.get("matchHex").and_then(|v| v.as_str()) {
        let needle = hex_clean(h);
        if !needle.is_empty() && !hex_clean(&m.raw).contains(&needle) { return false; }
    }
    if let Some(t) = filter.get("matchText").and_then(|v| v.as_str()) {
        if !t.is_empty() && !m.data.contains(t) { return false; }
    }
    if let Some(n) = filter.get("minLength").and_then(|v| v.as_u64()) {
        if (m.length as u64) < n { return false; }
    }
    if let Some(n) = filter.get("maxLength").and_then(|v| v.as_u64()) {
        if (m.length as u64) > n { return false; }
    }
    true
}

/// Check whether a stop condition is met by the latest collected message.
/// Returns the reason string when matched.
fn stop_reason(msg: &SerialMessage, cond: &Value, frames: usize, bytes: usize) -> Option<&'static str> {
    if let Some(n) = cond.get("bytes").and_then(|v| v.as_u64()) {
        if bytes >= n as usize { return Some("bytes"); }
    }
    if let Some(n) = cond.get("frames").and_then(|v| v.as_u64()) {
        if frames >= n as usize { return Some("frames"); }
    }
    if let Some(h) = cond.get("untilHex").and_then(|v| v.as_str()) {
        let needle = hex_clean(h);
        if !needle.is_empty() && hex_clean(&msg.raw).contains(&needle) { return Some("untilHex"); }
    }
    if let Some(t) = cond.get("untilText").and_then(|v| v.as_str()) {
        if !t.is_empty() && msg.data.contains(t) { return Some("untilText"); }
    }
    None
}

/// Apply a start marker: frames before it are dropped (the marker frame itself
/// is included and becomes index 0).
fn apply_start(messages: Vec<(u128, SerialMessage)>, start_hex: Option<&str>) -> Vec<(u128, SerialMessage)> {
    let Some(marker) = start_hex.map(hex_clean).filter(|h| !h.is_empty()) else { return messages };
    for (i, (_t, m)) in messages.iter().enumerate() {
        if hex_clean(&m.raw).contains(&marker) {
            return messages[i..].to_vec();
        }
    }
    messages
}

/// Run a capture. Returns a JSON object with relative-timestamped frames.
pub fn capture(
    manager: &Arc<SerialManager>,
    id: &str,
    params: &Value,
) -> Result<Value, String> {
    // Subscribe before triggering so the t0 burst cannot be missed.
    let sub: Subscription = manager.subscribe();

    let started = Instant::now();

    // Optional trigger: write data at t0 (build precise timing from here).
    if let Some(send) = params.get("send") {
        let data = send.get("data").and_then(|v| v.as_str()).unwrap_or("");
        if !data.is_empty() {
            let encoding = send.get("encoding").and_then(|v| v.as_str());
            manager.write(id, data, encoding)?;
        }
    }

    let timeout_ms = params.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(3000);
    let silence_ms = params.get("silenceMs").and_then(|v| v.as_u64());
    let deadline = started + Duration::from_millis(timeout_ms);

    let filter = params.get("filter").cloned().unwrap_or(json!({}));
    let cond = params.get("stop").cloned().unwrap_or(json!({}));
    let start_hex = params.get("startHex").and_then(|v| v.as_str());
    let include_tx = params.get("includeTx").and_then(|v| v.as_bool()).unwrap_or(false);

    let mut collected: Vec<(u128, SerialMessage)> = Vec::new();
    let mut reason: &'static str = "timeout";
    let mut last_rx: Option<Instant> = None;

    loop {
        let now = Instant::now();
        if now >= deadline { reason = "timeout"; break; }

        // Silence: no RX for silenceMs and we already have data.
        if let Some(silence) = silence_ms {
            if !collected.is_empty() {
                if let Some(t) = last_rx {
                    if t.elapsed() >= Duration::from_millis(silence) {
                        reason = "silence";
                        break;
                    }
                }
            }
        }

        let wait = Duration::from_millis(10).min(deadline.saturating_duration_since(now));
        let (wire_id, msg) = match sub.0.recv_timeout(wait) {
            Ok(v) => v,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => { reason = "disconnected"; break; }
        };
        if wire_id != id { continue; }
        if msg.direction == Direction::Tx {
            // TX frames mark t0 activity but are only collected on request.
            if include_tx && msg_matches(&msg, &filter) {
                let t = started.elapsed().as_millis();
                collected.push((t, msg));
            }
            continue;
        }
        last_rx = Some(Instant::now());
        if !msg_matches(&msg, &filter) { continue; }

        let t = started.elapsed().as_millis();
        collected.push((t, msg.clone()));

        let bytes: usize = collected.iter().filter(|(_, m)| m.direction == Direction::Rx).map(|(_, m)| m.length).sum();
        if let Some(r) = stop_reason(&msg, &cond, collected.len(), bytes) {
            reason = r;
            break;
        }
    }

    let elapsed_ms = started.elapsed().as_millis() as u64;
    let filtered = apply_start(collected, start_hex);

    let frames: Vec<Value> = filtered.iter().map(|(t, m)| {
        json!({
            "tMs": t,
            "timestamp": m.timestamp,
            "direction": match m.direction { Direction::Rx => "rx", Direction::Tx => "tx" },
            "raw": m.raw,
            "data": m.data,
            "length": m.length,
        })
    }).collect();

    let total_bytes: usize = filtered.iter().filter(|(_, m)| m.direction == Direction::Rx).map(|(_, m)| m.length).sum();

    Ok(json!({
        "ok": true,
        "reason": reason,
        "elapsedMs": elapsed_ms,
        "frameCount": frames.len(),
        "totalBytes": total_bytes,
        "frames": frames,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn msg(raw: &str, data: &str, dir: Direction) -> SerialMessage {
        let bytes = crate::encoding::parse_hex(raw);
        SerialMessage {
            timestamp: crate::util::now_iso(),
            connection_id: "c-test".into(),
            data: data.into(),
            raw: raw.into(),
            length: bytes.len(),
            direction: dir,
        }
    }

    /// Inject `frames` into the manager from a background thread at `gap_ms`
    /// intervals, then run capture on the main thread.
    fn with_stream(frames: Vec<SerialMessage>, gap_ms: u64, params: Value) -> Value {
        let manager = SerialManager::new();
        let producer = Arc::clone(&manager);
        thread::spawn(move || {
            for m in frames {
                thread::sleep(Duration::from_millis(gap_ms));
                producer.emit_message(m);
            }
        });
        capture(&manager, "c-test", &params).unwrap()
    }

    #[test]
    fn stop_by_frames_and_relative_timing() {
        let frames = vec![
            msg("AA01", "a", Direction::Rx),
            msg("AA02", "b", Direction::Rx),
            msg("AA03", "c", Direction::Rx),
        ];
        let r = with_stream(frames, 20, json!({
            "timeoutMs": 2000,
            "stop": { "frames": 2 }
        }));
        assert_eq!(r["reason"], "frames");
        assert_eq!(r["frameCount"], 2);
        let ts: Vec<u64> = r["frames"].as_array().unwrap().iter()
            .map(|f| f["tMs"].as_u64().unwrap()).collect();
        assert!(ts[0] <= ts[1], "timestamps must be monotonic: {ts:?}");
        assert!(ts[1] >= 15, "second frame should arrive ~20ms after t0: {ts:?}");
    }

    #[test]
    fn stop_by_bytes() {
        let frames = vec![
            msg("AA010203", "abcd", Direction::Rx),
            msg("AA040506", "efgh", Direction::Rx),
        ];
        let r = with_stream(frames, 15, json!({
            "timeoutMs": 2000,
            "stop": { "bytes": 4 }
        }));
        assert_eq!(r["reason"], "bytes");
        assert_eq!(r["frameCount"], 1);
        assert_eq!(r["totalBytes"], 4);
    }

    #[test]
    fn stop_by_until_hex() {
        let frames = vec![
            msg("AA01", "a", Direction::Rx),
            msg("FF00", "END", Direction::Rx),
            msg("AA02", "b", Direction::Rx),
        ];
        let r = with_stream(frames, 15, json!({
            "timeoutMs": 2000,
            "stop": { "untilHex": "FF00" }
        }));
        assert_eq!(r["reason"], "untilHex");
        assert_eq!(r["frameCount"], 2, "capture stops at and includes the marker");
    }

    #[test]
    fn stop_by_until_text() {
        let frames = vec![
            msg("AA01", "hello", Direction::Rx),
            msg("FF00", "OK", Direction::Rx),
            msg("AA02", "ignored", Direction::Rx),
        ];
        let r = with_stream(frames, 15, json!({
            "timeoutMs": 2000,
            "stop": { "untilText": "OK" }
        }));
        assert_eq!(r["reason"], "untilText");
        assert_eq!(r["frameCount"], 2);
    }

    #[test]
    fn stop_by_silence() {
        let frames = vec![msg("AA01", "a", Direction::Rx)];
        let r = with_stream(frames, 10, json!({
            "timeoutMs": 2000,
            "stop": {},
            "silenceMs": 60
        }));
        assert_eq!(r["reason"], "silence");
        assert_eq!(r["frameCount"], 1);
    }

    #[test]
    fn timeout_when_no_data() {
        let r = with_stream(vec![], 10, json!({ "timeoutMs": 60, "stop": {} }));
        assert_eq!(r["reason"], "timeout");
        assert_eq!(r["frameCount"], 0);
        assert!(r["elapsedMs"].as_u64().unwrap() >= 50);
    }

    #[test]
    fn filter_and_start_hex_slice() {
        let frames = vec![
            msg("AA01", "noise", Direction::Rx),
            msg("BB01", "MARK", Direction::Rx),
            msg("CC01", "keep", Direction::Rx),
        ];
        let r = with_stream(frames, 15, json!({
            "timeoutMs": 2000,
            "stop": { "frames": 3 },
            "startHex": "BB"
        }));
        assert_eq!(r["frameCount"], 2, "frames before the start marker are dropped");
        assert_eq!(r["frames"][0]["data"], "MARK");
    }

    #[test]
    fn filter_match_hex_and_direction() {
        let frames = vec![
            msg("AA01", "a", Direction::Rx),
            msg("FFEE", "match", Direction::Rx),
            msg("AA02", "tx", Direction::Tx),
        ];
        let r = with_stream(frames, 15, json!({
            "timeoutMs": 300,
            "stop": { "frames": 2 },
            "filter": { "matchHex": "FF" }
        }));
        assert_eq!(r["frameCount"], 1, "only the FF frame passes the filter");
    }
}
