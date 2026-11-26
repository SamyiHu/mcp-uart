//! Free-form action-sequence orchestration on top of `OrchestratorSession`.
//!
//! Port of the Node `src/orchestrator/sequence.ts` engine: it runs an arbitrary
//! `OrchestratorAction[]` (not just a profile command) with a total time budget, step
//! logging, poll loops, nested repeats and signal snapshot/restore.
//!
//! Used by `POST /api/orchestrator/sequence` and the `uart_orchestrator` MCP
//! tool's `sequence` action.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::orchestrator_engine::{num, OrchestratorSession, ParsedFrame};

const DEFAULT_BUDGET_MS: u64 = 25_000;
const MAX_EXTRAS: usize = 256;

fn hex_byte(b: u8) -> String {
    format!("{b:02X}")
}

fn frame_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| hex_byte(*b)).collect()
}

fn num_field(act: &Value, key: &str) -> u8 {
    num(act.get(key), 0)
}

/// `poll.matchHex` must be even-length hex of at least 4 chars, and must not be
/// a substring of the probe frame (that would match the echo instead of a result).
pub fn validate_match_hex(match_hex: &str, probe_frame_hex: Option<&str>) -> Result<(), String> {
    let h: String = match_hex.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_uppercase();
    let valid = h.len() >= 4 && h.len() % 2 == 0 && h.chars().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return Err(format!(
            "poll.matchHex must be even-length hex with >=4 chars (got \"{match_hex}\")"
        ));
    }
    if let Some(probe) = probe_frame_hex {
        if probe.contains(&h) {
            return Err(format!(
                "poll.matchHex \"{h}\" is a substring of probe echo \"{probe}\" — would match the echo. Use the result-frame pattern."
            ));
        }
    }
    Ok(())
}

/// Hard errors abort the whole sequence even without `abortOnError`.
fn is_hard_abort(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("not open")
        || lower.contains("not found")
        || lower.contains("closed")
        || lower.contains("access")
        || lower.contains("denied")
}

#[derive(Clone)]
struct SignalPatch {
    dtr: Option<bool>,
    rts: Option<bool>,
    brk: Option<bool>,
}

impl SignalPatch {
    fn empty() -> Self { Self { dtr: None, rts: None, brk: None } }
    fn is_empty(&self) -> bool { self.dtr.is_none() && self.rts.is_none() && self.brk.is_none() }
}

struct Ctx<'a> {
    session: &'a OrchestratorSession,
    started: Instant,
    budget_ms: u64,
    abort_on_error: bool,
    capture: String,
    stopped: Option<&'static str>,
    abort_reason: Option<String>,
    first_rx_latency_ms: Option<u64>,
    first_rx_seen: bool,
    baseline_at_ms: Option<u64>,
    recovery_ms: Option<u64>,
    last_frame: Option<(u8, u8, u8)>,
    signals_snapshot: SignalPatch,
    signals_touched: SignalPatch,
}

impl<'a> Ctx<'a> {
    fn elapsed(&self) -> u64 { self.started.elapsed().as_millis() as u64 }
    fn remaining(&self) -> i64 { self.budget_ms as i64 - self.elapsed() as i64 }
    fn out_of_budget(&self) -> bool { self.remaining() <= 0 }
    fn aborted(&self) -> bool { self.stopped == Some("aborted") }

    fn sleep_left(&self, ms: u64) {
        let capped = ms.min(self.remaining().max(0) as u64);
        if capped > 0 { std::thread::sleep(Duration::from_millis(capped)); }
    }

    fn set_signals(&self, patch: &SignalPatch) -> Result<(), String> {
        self.session.set_signals(patch.brk, patch.dtr, patch.rts)
    }

    fn restore_signals(&self) {
        let mut restore = SignalPatch::empty();
        if self.signals_touched.dtr.is_some() {
            restore.dtr = self.signals_snapshot.dtr.or(Some(true));
        }
        if self.signals_touched.rts.is_some() {
            restore.rts = self.signals_snapshot.rts.or(Some(true));
        }
        if self.signals_touched.brk.is_some() {
            restore.brk = Some(false);
        }
        if !restore.is_empty() {
            let _ = self.set_signals(&restore);
        }
    }

    fn slim_frames(&self, frames: &[ParsedFrame], matched: Option<&str>) -> Option<Value> {
        if self.capture == "none" { return None; }
        if self.capture == "all" {
            return Some(json!(frames.iter().map(|f| frame_hex(&f.bytes)).collect::<Vec<_>>()));
        }
        match matched {
            Some(h) => Some(json!([h])),
            None => {
                let all: Vec<String> = frames.iter().map(|f| frame_hex(&f.bytes)).collect();
                let tail = if all.len() > 2 { &all[all.len() - 2..] } else { &all[..] };
                Some(json!(tail.to_vec()))
            }
        }
    }

    fn note_first_rx(&mut self, baseline: usize, wait_ms: u64) {
        if self.first_rx_seen { return; }
        let deadline = Instant::now() + Duration::from_millis(wait_ms.max(1));
        self.session.wait_for_frames(baseline, 1, deadline);
        let (frames, _) = self.session.snapshot();
        if frames.len() > baseline {
            self.first_rx_latency_ms = Some(self.elapsed());
            self.first_rx_seen = true;
        }
    }
}

/// Run one poll step. Returns when matched or the poll deadline passes.
fn run_poll(ctx: &mut Ctx, act: &Value, log: &mut Value) {
    let send = act.get("send").cloned().unwrap_or(json!({}));
    let frame = send.get("frame");
    let raw_hex = send.get("hex").and_then(|v| v.as_str());

    let probe_hex = match (frame, raw_hex) {
        (Some(f), _) => {
            let bytes = ctx.session.build_frame(
                num(f.get("cmd"), 0),
                num(f.get("p1"), 0),
                num(f.get("p2"), 0),
            );
            frame_hex(&bytes)
        }
        (None, Some(h)) => h.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_uppercase(),
        _ => {
            log["verdict"] = json!("failed");
            log["note"] = json!("poll.send requires frame or hex");
            return;
        }
    };

    let match_mode = act.get("matchMode").and_then(|v| v.as_str()).unwrap_or("frame-hex");
    let match_hex = act.get("matchHex").and_then(|v| v.as_str())
        .map(|h| h.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_uppercase());

    if let Some(m) = &match_hex {
        let probe_for_check = if match_mode == "frame-hex" { Some(probe_hex.as_str()) } else { None };
        if let Err(err) = validate_match_hex(m, probe_for_check) {
            log["verdict"] = json!("failed");
            log["note"] = json!(err);
            return;
        }
    }

    let timeout_ms = act.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(3000);
    let interval_ms = act.get("intervalMs").and_then(|v| v.as_u64()).unwrap_or(100).max(1);
    let deadline = ctx.elapsed() + timeout_ms.min(ctx.remaining().max(0) as u64);
    let poll_start = ctx.elapsed();
    let frames_count = act.get("framesCount").and_then(|v| v.as_u64());
    let two_phase = act.get("twoPhase").and_then(|v| v.as_bool()).unwrap_or(false);

    let (base_frames, base_extras) = {
        let (f, e) = ctx.session.snapshot();
        (f.len(), e.len())
    };

    let mut attempts = 0u64;
    let mut sent: Vec<String> = Vec::new();
    let mut matched: Option<String> = None;
    let mut new_frames: Vec<ParsedFrame> = Vec::new();

    // scan() is a closure over current state; returns Some((frames, matched))
    let scan = |ctx: &Ctx, base_frames: usize, base_extras: usize| -> Option<(Vec<ParsedFrame>, Option<String>)> {
        let (frames, extras) = ctx.session.snapshot();
        let recent: Vec<ParsedFrame> = frames.iter().skip(base_frames).cloned().collect();
        if let Some(n) = frames_count {
            if recent.len() >= n as usize {
                let last = recent.last().map(|f| frame_hex(&f.bytes));
                return Some((recent, last));
            }
        }
        let m = match_hex.as_ref()?;
        if match_mode == "raw-hex" {
            let mut raw = String::new();
            for b in extras.iter().skip(base_extras) { raw.push_str(&hex_byte(*b)); }
            for f in &recent { raw.push_str(&frame_hex(&f.bytes)); }
            if raw.contains(m.as_str()) {
                let hit = recent.iter().find(|f| frame_hex(&f.bytes).contains(m.as_str()))
                    .map(|f| frame_hex(&f.bytes));
                return Some((recent, Some(hit.unwrap_or_else(|| m.clone()))));
            }
            return None;
        }
        for f in &recent {
            let hx = frame_hex(&f.bytes);
            if hx.contains(m.as_str()) { return Some((recent, Some(hx))); }
        }
        None
    };

    while ctx.elapsed() < deadline && ctx.stopped.is_none() && !ctx.out_of_budget() {
        let attempt_start = ctx.elapsed();
        attempts += 1;

        // Send the probe.
        let send_result = match (frame, raw_hex) {
            (Some(f), _) => {
                let tuple = (num(f.get("cmd"), 0), num(f.get("p1"), 0), num(f.get("p2"), 0));
                ctx.last_frame = Some(tuple);
                ctx.session.send_frame(tuple.0, tuple.1, tuple.2)
            }
            (None, Some(h)) => ctx.session.send_raw(h),
            _ => Err("poll.send requires frame or hex".into()),
        };
        match send_result {
            Ok(hx) => sent.push(hx),
            Err(err) => {
                log["verdict"] = json!("failed");
                log["note"] = json!(err);
                log["attempts"] = json!(attempts);
                return;
            }
        }

        if let Some((frames, m)) = scan(ctx, base_frames, base_extras) {
            new_frames = frames;
            matched = m;
            break;
        }

        if two_phase {
            let short = ctx.remaining().max(0).min(2) as u64;
            if short > 0 { std::thread::sleep(Duration::from_millis(short)); }
            if let Some((frames, m)) = scan(ctx, base_frames, base_extras) {
                new_frames = frames;
                matched = m;
                break;
            }
            if let Some((c, p1, p2)) = ctx.last_frame {
                if let Ok(hx) = ctx.session.send_frame(c, p1, p2) { sent.push(hx); }
            }
        }

        // Wait out the interval, scanning while we wait so late frames still match.
        let interval_end = attempt_start + interval_ms;
        while ctx.elapsed() < interval_end && ctx.elapsed() < deadline && ctx.stopped.is_none() {
            if let Some((frames, m)) = scan(ctx, base_frames, base_extras) {
                new_frames = frames;
                matched = m;
                break;
            }
            let left = (interval_end - ctx.elapsed())
                .min(ctx.remaining().max(0) as u64)
                .min(1);
            if left > 0 { std::thread::sleep(Duration::from_millis(left)); }
        }
        if matched.is_some() { break; }
    }

    let matched_flag = matched.is_some();
    log["attempts"] = json!(attempts);
    log["sent"] = json!(sent);
    if matched_flag {
        log["verdict"] = json!("matched");
        log["firstMatchAtMs"] = json!(ctx.elapsed().saturating_sub(poll_start));
        log["matchedFrameHex"] = json!(matched);
        log["frames"] = ctx.slim_frames(&new_frames, matched.as_deref()).unwrap_or(Value::Null);
        if let Some(base) = ctx.baseline_at_ms {
            ctx.recovery_ms = Some(ctx.elapsed().saturating_sub(base));
        }
    } else {
        log["verdict"] = json!("timeout");
        let (frames, _) = ctx.session.snapshot();
        let recent: Vec<ParsedFrame> = frames.iter().skip(base_frames).cloned().collect();
        log["frames"] = ctx.slim_frames(&recent, None).unwrap_or(Value::Null);
    }
}

/// Execute one action, filling `log`.
fn run_one(ctx: &mut Ctx, act: &Value, log: &mut Value) -> Result<(), String> {
    let kind = act.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "send-frame" => {
            let tuple = (num_field(act, "cmd"), num_field(act, "p1"), num_field(act, "p2"));
            ctx.last_frame = Some(tuple);
            let hx = ctx.session.send_frame(tuple.0, tuple.1, tuple.2)?;
            log["sent"] = json!([hx]);
            let (frames, _) = ctx.session.snapshot();
            let baseline = frames.len();
            let wait = ctx.remaining().max(5).min(20) as u64;
            ctx.note_first_rx(baseline, wait);
            log["verdict"] = json!("ok");
            Ok(())
        }
        "send-raw" => {
            let hex = act.get("hex").and_then(|v| v.as_str()).unwrap_or("");
            let hx = ctx.session.send_raw(hex)?;
            log["sent"] = json!([hx]);
            let (frames, _) = ctx.session.snapshot();
            let baseline = frames.len();
            let wait = ctx.remaining().max(5).min(20) as u64;
            ctx.note_first_rx(baseline, wait);
            log["verdict"] = json!("ok");
            Ok(())
        }
        "handshake" => {
            let (c, p1, p2) = ctx.last_frame.ok_or("handshake before any send-frame")?;
            let hx = ctx.session.send_frame(c, p1, p2)?;
            log["sent"] = json!([hx]);
            log["verdict"] = json!("ok");
            Ok(())
        }
        "wait" => {
            let ms = act.get("ms").and_then(|v| v.as_u64()).unwrap_or(0);
            ctx.sleep_left(ms);
            log["verdict"] = json!("ok");
            Ok(())
        }
        "clear-state" => {
            ctx.session.reset();
            log["verdict"] = json!("ok");
            Ok(())
        }
        "signals" => {
            let mut patch = SignalPatch::empty();
            if let Some(v) = act.get("dtr").and_then(|v| v.as_bool()) {
                patch.dtr = Some(v);
                ctx.signals_touched.dtr = Some(v);
            }
            if let Some(v) = act.get("rts").and_then(|v| v.as_bool()) {
                patch.rts = Some(v);
                ctx.signals_touched.rts = Some(v);
            }
            if let Some(v) = act.get("break").and_then(|v| v.as_bool()) {
                patch.brk = Some(v);
                ctx.signals_touched.brk = Some(v);
            }
            ctx.set_signals(&patch)?;
            if let Some(hold) = act.get("holdMs").and_then(|v| v.as_u64()) {
                ctx.sleep_left(hold);
                let mut restore = SignalPatch::empty();
                if patch.dtr.is_some() { restore.dtr = ctx.signals_snapshot.dtr.or(Some(true)); }
                if patch.rts.is_some() { restore.rts = ctx.signals_snapshot.rts.or(Some(true)); }
                if patch.brk.is_some() { restore.brk = Some(false); }
                let _ = ctx.set_signals(&restore);
            }
            log["verdict"] = json!("ok");
            Ok(())
        }
        "wake-pulse" => {
            let ms = act.get("ms").and_then(|v| v.as_u64()).unwrap_or(2);
            ctx.session.set_signals(Some(true), None, None)?;
            std::thread::sleep(Duration::from_millis(ms));
            ctx.session.set_signals(Some(false), None, None)?;
            ctx.signals_touched.brk = Some(true);
            log["verdict"] = json!("ok");
            Ok(())
        }
        "repeat" => {
            let times = act.get("times").and_then(|v| v.as_u64()).unwrap_or(1).max(1);
            let abort_on_fail = act.get("abortOnFail").and_then(|v| v.as_bool()).unwrap_or(false);
            let each = act.get("logRepeat").and_then(|v| v.as_str()) == Some("each");
            let steps = act.get("steps").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let mut completed = 0u64;
            let mut any_fail = false;
            let mut children: Vec<Value> = Vec::new();

            for _ in 0..times {
                if ctx.out_of_budget() || ctx.aborted() {
                    log["stopped"] = json!(if ctx.aborted() { "aborted" } else { "budget" });
                    if !ctx.aborted() { ctx.stopped = Some("budget"); }
                    break;
                }
                let mut step_fail = false;
                for child in &steps {
                    if ctx.out_of_budget() || ctx.aborted() {
                        if ctx.out_of_budget() { log["stopped"] = json!("budget"); }
                        break;
                    }
                    let mut child_log = json!({
                        "action": child.get("type").and_then(|v| v.as_str()).unwrap_or(""),
                        "atMs": ctx.elapsed(),
                    });
                    if let Some(mark) = child.get("mark") { child_log["mark"] = mark.clone(); }
                    if child.get("baseline").and_then(|v| v.as_bool()).unwrap_or(false) {
                        child_log["baseline"] = json!(true);
                        ctx.baseline_at_ms = Some(ctx.elapsed());
                    }
                    match run_one(ctx, child, &mut child_log) {
                        Ok(()) => {
                            if child_log.get("verdict").and_then(|v| v.as_str()) == Some("timeout") {
                                step_fail = true;
                            }
                        }
                        Err(err) => {
                            child_log["verdict"] = json!("failed");
                            child_log["note"] = json!(err);
                            step_fail = true;
                            let hard = is_hard_abort(&err);
                            if hard || ctx.abort_on_error {
                                ctx.stopped = Some("aborted");
                                ctx.abort_reason = Some(err);
                                if each { children.push(child_log); }
                                break;
                            }
                        }
                    }
                    if each { children.push(child_log); }
                }
                if step_fail {
                    any_fail = true;
                    if abort_on_fail { break; }
                } else {
                    completed += 1;
                }
            }
            log["completed"] = json!(completed);
            log["times"] = json!(times);
            log["verdict"] = json!(if any_fail && completed < times { "failed" } else { "ok" });
            if each && !children.is_empty() { log["steps"] = json!(children); }
            Ok(())
        }
        "poll" => {
            run_poll(ctx, act, log);
            Ok(())
        }
        "expect-echo" | "get-result" | "collect-frames" | "expect-extra" => {
            // These share the profile engine's semantics.
            let single = vec![act.clone()];
            ctx.session.run_actions(&single, None)?;
            log["verdict"] = json!("ok");
            Ok(())
        }
        other => Err(format!("Unsupported action in sequence: {other}")),
    }
}

/// Run a full action sequence. Mirrors `runOrchestratorSequence` from the Node build.
pub fn run_sequence(session: &OrchestratorSession, actions: &[Value], options: &Value) -> Result<Value, String> {
    let budget_ms = options.get("totalBudgetMs").and_then(|v| v.as_u64()).unwrap_or(DEFAULT_BUDGET_MS);
    let abort_on_error = options.get("abortOnError").and_then(|v| v.as_bool()).unwrap_or(false);
    let capture = options.get("captureFrames").and_then(|v| v.as_str()).unwrap_or("match").to_string();

    let (parsed0, _noise0, sent0, _raw0) = session.stats();

    let mut ctx = Ctx {
        session,
        started: Instant::now(),
        budget_ms,
        abort_on_error,
        capture,
        stopped: None,
        abort_reason: None,
        first_rx_latency_ms: None,
        first_rx_seen: false,
        baseline_at_ms: None,
        recovery_ms: None,
        last_frame: None,
        signals_snapshot: SignalPatch { dtr: Some(true), rts: Some(true), brk: Some(false) },
        signals_touched: SignalPatch::empty(),
    };
    session.reset();

    let mut steps: Vec<Value> = Vec::new();
    for (idx, act) in actions.iter().enumerate() {
        if ctx.out_of_budget() {
            ctx.stopped = Some("budget");
            break;
        }
        if ctx.aborted() { break; }

        let mut log = json!({
            "i": idx,
            "action": act.get("type").and_then(|v| v.as_str()).unwrap_or(""),
            "atMs": ctx.elapsed(),
        });
        if let Some(mark) = act.get("mark") { log["mark"] = mark.clone(); }
        if act.get("baseline").and_then(|v| v.as_bool()).unwrap_or(false) {
            log["baseline"] = json!(true);
            ctx.baseline_at_ms = Some(ctx.elapsed());
        }

        match run_one(&mut ctx, act, &mut log) {
            Ok(()) => {}
            Err(err) => {
                log["verdict"] = json!("failed");
                log["note"] = json!(err);
                if is_hard_abort(&err) || abort_on_error {
                    ctx.stopped = Some("aborted");
                    ctx.abort_reason = Some(err);
                }
            }
        }
        steps.push(log);
    }

    ctx.restore_signals();

    let (parsed1, noise1, sent1, _raw1) = session.stats();
    let elapsed_ms = ctx.elapsed();

    let mut summary = json!({
        "framesParsed": parsed1.saturating_sub(parsed0),
        "extras": noise1,
        "framesSent": sent1.saturating_sub(sent0),
    });
    if let Some(v) = ctx.first_rx_latency_ms { summary["firstRxLatencyMs"] = json!(v); }
    if let Some(v) = ctx.recovery_ms { summary["recoveryMs"] = json!(v); }

    Ok(json!({
        "ok": ctx.stopped.is_none(),
        "elapsedMs": elapsed_ms,
        "stopped": ctx.stopped,
        "abortReason": ctx.abort_reason,
        "steps": steps,
        "summary": summary,
    }))
}

/// Trim extras defensively; kept for parity with the Node engine's 256-byte cap.
#[allow(dead_code)]
fn cap_extras(extras: &mut Vec<u8>) {
    if extras.len() > MAX_EXTRAS {
        let excess = extras.len() - MAX_EXTRAS;
        extras.drain(..excess);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_hex_validation_rejects_short_and_odd() {
        assert!(validate_match_hex("0F00", None).is_ok());
        assert!(validate_match_hex("0F0", None).is_err());
        assert!(validate_match_hex("0F000", None).is_err());
        assert!(validate_match_hex("ZZ00", None).is_err());
    }

    #[test]
    fn match_hex_validation_rejects_probe_echo_substring() {
        // "0F04" is a substring of the probe frame 0F 04 00 EC -> would match the echo.
        assert!(validate_match_hex("0F04", Some("0F0400EC")).is_err());
        // A distinct result pattern is accepted.
        assert!(validate_match_hex("0F00", Some("010000FE")).is_ok());
    }

    #[test]
    fn hard_abort_detection() {
        assert!(is_hard_abort("port is not open"));
        assert!(is_hard_abort("Access denied"));
        assert!(!is_hard_abort("timeout waiting for frame"));
    }
}
