//! Chip-agnostic DUT protocol engine — Rust port of `src/dut/session.ts` and
//! the judging half of `src/dut/manager.ts`.
//!
//! One `DutSession` owns the raw RX byte state machine for one connection:
//! it appends every raw byte, extracts fixed-length frames whose checksum
//! validates (resyncing one byte at a time past noise), and keeps non-frame
//! bytes as `extras`. Action lists from a profile are executed synchronously
//! on the caller's thread; awaiting frames uses a Condvar with a deadline.

use std::sync::atomic::{AtomicU64, Ordering};use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::model::{DutJudge, DutProfile, DutRunResult};
use crate::serial::SerialManager;

/// Accept 10, "0x0F", "15" — profiles use hex strings for readability.
pub fn num(v: Option<&Value>, fallback: u8) -> u8 {
    match v {
        None => fallback,
        Some(Value::Number(n)) => (n.as_u64().unwrap_or(fallback as u64) & 0xff) as u8,
        Some(Value::String(s)) => {
            let s = s.trim();
            let radix = if s.to_ascii_lowercase().starts_with("0x") { 16 } else { 10 };
            let digits = if radix == 16 { &s[2..] } else { s };
            match u64::from_str_radix(digits, radix) {
                Ok(n) => (n & 0xff) as u8,
                Err(_) => fallback,
            }
        }
        _ => fallback,
    }
}

fn num_field(obj: &Value, key: &str, fallback: u8) -> u8 {
    num(obj.get(key), fallback)
}

/// checksumOf from session.ts: sum / sum-complement / xor over all bytes except
/// the checksum index.
pub fn checksum_of(bytes: &[u8], checksum_index: usize, algorithm: &str) -> u8 {
    let mut sum: u8 = 0;
    let mut xor: u8 = 0;
    for (i, b) in bytes.iter().enumerate() {
        if i == checksum_index { continue; }
        sum = sum.wrapping_add(*b);
        xor ^= *b;
    }
    match algorithm {
        "sum" => sum,
        "xor" => xor,
        _ => 0xFFu8.wrapping_sub(sum), // sum-complement: 0xFF - sum
    }
}

fn hex_byte(b: u8) -> String { format!("{:02X}", b) }
fn now_iso() -> String { crate::util::now_iso() }

#[derive(Clone, Debug)]
pub struct ParsedFrame {
    pub bytes: Vec<u8>,
    pub timestamp: String,
}

#[derive(Default)]
struct SessionState {
    buf: Vec<u8>,
    frames: Vec<ParsedFrame>,
    extras: Vec<u8>,
}

/// A DUT session attached to one connection. Cloneable: the raw hook and the
/// action executor both hold a handle to the same state.
#[derive(Clone)]
pub struct DutSession {
    state: Arc<(Mutex<SessionState>, Condvar)>,
    profile: Arc<DutProfile>,
    connection_id: String,
    manager: Arc<SerialManager>,
    hook_token: Arc<Mutex<Option<u64>>>,
    stats: Arc<SessionStats>,
}

pub struct SessionStats {
    pub frames_parsed: AtomicU64,
    pub noise_bytes: AtomicU64,
    pub frames_sent: AtomicU64,
    pub raw_bytes_sent: AtomicU64,
}

impl SessionStats {
    fn new() -> Self {
        Self {
            frames_parsed: AtomicU64::new(0),
            noise_bytes: AtomicU64::new(0),
            frames_sent: AtomicU64::new(0),
            raw_bytes_sent: AtomicU64::new(0),
        }
    }
    pub fn snapshot(&self) -> (u64, u64, u64, u64) {
        (
            self.frames_parsed.load(Ordering::Relaxed),
            self.noise_bytes.load(Ordering::Relaxed),
            self.frames_sent.load(Ordering::Relaxed),
            self.raw_bytes_sent.load(Ordering::Relaxed),
        )
    }
}

impl DutSession {
    /// Attach a raw byte hook to the connection. Caller must detach when done.
    pub fn attach(profile: Arc<DutProfile>, connection_id: String, manager: Arc<SerialManager>) -> Arc<Self> {
        let session = Arc::new(Self {
            state: Arc::new((Mutex::new(SessionState::default()), Condvar::new())),
            profile,
            connection_id,
            manager,
            hook_token: Arc::new(Mutex::new(None)),
            stats: Arc::new(SessionStats::new()),
        });

        let weak = Arc::downgrade(&session);
        let hook = Arc::new(move |bytes: &[u8]| {
            if let Some(s) = weak.upgrade() {
                s.on_rx(bytes);
            }
        });
        let token = session.manager.add_data_hook(&session.connection_id, hook);
        *session.hook_token.lock().unwrap() = Some(token);
        session
    }

    pub fn detach(&self) {
        if let Some(token) = self.hook_token.lock().unwrap().take() {
            self.manager.remove_data_hook(&self.connection_id, token);
        }
        self.state.1.notify_all();
    }

    pub fn profile(&self) -> &DutProfile { &self.profile }
    pub fn connection_id(&self) -> &str { &self.connection_id }
    pub fn stats(&self) -> (u64, u64, u64, u64) { self.stats.snapshot() }

    pub fn reset(&self) {
        let mut st = self.state.0.lock().unwrap();
        st.buf.clear();
        st.frames.clear();
        st.extras.clear();
    }

    fn on_rx(&self, chunk: &[u8]) {
        {
            let mut pair = self.state.0.lock().unwrap();
            let st = &mut *pair;
            let len = self.profile.frame.as_ref().map(|f| f.length).unwrap_or(0);
            if len == 0 { return; }
            let ci = self.profile.frame.as_ref().unwrap().checksum_index;
            let alg = self.profile.frame.as_ref().unwrap().checksum.as_str();
            for &b in chunk {
                st.buf.push(b);
                while st.buf.len() >= len {
                    let head = &st.buf[..len];
                    if head[ci] == checksum_of(head, ci, alg) {
                        let bytes = head.to_vec();
                        st.buf.drain(..len);
                        st.frames.push(ParsedFrame { bytes, timestamp: now_iso() });
                        self.stats.frames_parsed.fetch_add(1, Ordering::Relaxed);
                    } else {
                        st.extras.push(st.buf.remove(0));
                        self.stats.noise_bytes.fetch_add(1, Ordering::Relaxed);
                        if st.extras.len() > 256 {
                            let excess = st.extras.len() - 256;
                            st.extras.drain(..excess);
                        }
                    }
                }
            }
        }
        self.state.1.notify_all();
    }

    pub fn snapshot(&self) -> (Vec<ParsedFrame>, Vec<u8>) {
        let st = self.state.0.lock().unwrap();
        (st.frames.clone(), st.extras.clone())
    }

    /// Feed raw bytes into the frame state machine. The serial reader calls
    /// this via the registered hook; exposed for offline tests too.
    pub fn inject_rx(&self, bytes: &[u8]) { self.on_rx(bytes); }

    /// Wait until `count` new frames arrive or the deadline passes. Returns
    /// the number of new frames actually seen.
    fn wait_for_frames(&self, baseline: usize, count: u32, deadline: Instant) -> usize {
        if count == 0 { return 0; }
        let target = baseline + count as usize;
        let (lock, cv) = &*self.state;
        let mut st = lock.lock().unwrap();
        loop {
            if st.frames.len() >= target { return st.frames.len() - baseline; }
            let now = Instant::now();
            if now >= deadline { return st.frames.len() - baseline; }
            let (next, _) = cv.wait_timeout(st, deadline - now).unwrap();
            st = next;
        }
    }

    /// Wait until `hex` appears in extras+buffer, or the deadline passes.
    fn wait_for_extra(&self, hex: &str, deadline: Instant) -> bool {
        let clean: String = hex.chars().filter(|c| !c.is_whitespace()).collect();
        let need = parse_hex_bytes(&clean);
        let (lock, cv) = &*self.state;
        let mut st = lock.lock().unwrap();
        loop {
            let mut window = st.extras.clone();
            window.extend_from_slice(&st.buf);
            if contains_subslice(&window, &need) { return true; }
            let now = Instant::now();
            if now >= deadline { return false; }
            let (next, _) = cv.wait_timeout(st, deadline - now).unwrap();
            st = next;
        }
    }

    fn build_frame(&self, cmd: u8, p1: u8, p2: u8) -> Vec<u8> {
        let f = self.profile.frame.as_ref().expect("profile has no frame descriptor");
        let mut bytes = vec![cmd, p1, p2, 0u8];
        // Profiles use length 4 with checksumIndex 3. Pad/truncate to length.
        bytes.resize(f.length, 0u8);
        let ck = checksum_of(&bytes, f.checksum_index, &f.checksum);
        if f.checksum_index < bytes.len() { bytes[f.checksum_index] = ck; }
        bytes
    }

    fn send_frame(&self, cmd: u8, p1: u8, p2: u8) -> Result<String, String> {
        let bytes = self.build_frame(cmd, p1, p2);
        let hex = bytes.iter().map(|b| format!("{:02X}", b)).collect::<String>();
        self.manager.write(&self.connection_id, &hex, Some("hex"))?;
        self.stats.frames_sent.fetch_add(1, Ordering::Relaxed);
        Ok(hex)
    }

    fn send_raw(&self, hex: &str) -> Result<String, String> {
        let clean: String = hex.chars().filter(|c| !c.is_whitespace()).collect();
        let bytes = parse_hex_bytes(&clean);
        let out = bytes.iter().map(|b| format!("{:02X}", b)).collect::<String>();
        self.manager.write(&self.connection_id, &out, Some("hex"))?;
        self.stats.raw_bytes_sent.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        Ok(out)
    }

    /// Execute a command's action list. Returns sent hex, frames, extras,
    /// first command byte, and a timed-out flag.
    pub fn run_actions(
        &self,
        actions: &[Value],
        overrides: Option<(u8, u8, u8)>,
    ) -> Result<ActionOutcome, String> {
        self.reset();
        let mut sent: Vec<String> = Vec::new();
        let mut first_cmd: Option<u8> = None;
        let mut last_frame: Option<(u8, u8, u8)> = None;
        let mut timed_out = false;

        for act in actions {
            let kind = act.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match kind {
                "send-frame" => {
                    let mut cmd = num_field(act, "cmd", 0);
                    let mut p1 = num_field(act, "p1", 0);
                    let mut p2 = num_field(act, "p2", 0);
                    if first_cmd.is_none() {
                        if let Some((o_cmd, o_p1, o_p2)) = overrides {
                            cmd = o_cmd; p1 = o_p1; p2 = o_p2;
                        }
                    }
                    if first_cmd.is_none() { first_cmd = Some(cmd); }
                    last_frame = Some((cmd, p1, p2));
                    sent.push(self.send_frame(cmd, p1, p2)?);
                }
                "expect-echo" => {
                    let (c, p1, p2) = last_frame.ok_or("expect-echo before any send-frame")?;
                    let timeout = act.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(1000);
                    let resend = act.get("resendMs").and_then(|v| v.as_u64()).unwrap_or(800);
                    let deadline = Instant::now() + Duration::from_millis(timeout);
                    let want = self.build_frame(c, p1, p2);
                    let mut resent = false;
                    loop {
                        let baseline = self.state.0.lock().unwrap().frames.len();
                        let now = Instant::now();
                        let wait_until = if now < deadline {
                            std::cmp::min(now + Duration::from_millis(resend.max(50)), deadline)
                        } else { deadline };
                        self.wait_for_frames(baseline, 1, wait_until);
                        let mut st = self.state.0.lock().unwrap();
                        if let Some(f) = st.frames.last() {
                            if f.bytes == want { break; }
                            // stale frame -> move to extras
                            let f = st.frames.pop().unwrap();
                            st.extras.extend_from_slice(&f.bytes);
                            if st.extras.len() > 256 {
                                let e = st.extras.len() - 256;
                                st.extras.drain(..e);
                            }
                        }
                        drop(st);
                        if Instant::now() >= deadline { timed_out = true; break; }
                        if !resent {
                            resent = true;
                            sent.push(self.send_frame(c, p1, p2)?);
                        }
                    }
                }
                "handshake" => {
                    let (c, p1, p2) = last_frame.ok_or("handshake before any send-frame")?;
                    sent.push(self.send_frame(c, p1, p2)?);
                }
                "get-result" => {
                    let (c, p1, p2) = last_frame.ok_or("get-result before any send-frame")?;
                    let timeout = act.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(1000);
                    let retry = act.get("retryMs").and_then(|v| v.as_u64()).unwrap_or(400);
                    let deadline = Instant::now() + Duration::from_millis(timeout);
                    loop {
                        sent.push(self.send_frame(c, p1, p2)?);
                        let baseline = self.state.0.lock().unwrap().frames.len();
                        let got = self.wait_for_frames(baseline, 1, Instant::now() + Duration::from_millis(retry));
                        if got >= 1 { break; }
                        if Instant::now() + Duration::from_millis(retry) >= deadline {
                            timed_out = true;
                            break;
                        }
                    }
                }
                "send-raw" => {
                    let hex = act.get("hex").and_then(|v| v.as_str()).unwrap_or("");
                    sent.push(self.send_raw(hex)?);
                }
                "wait" => {
                    let ms = act.get("ms").and_then(|v| v.as_u64()).unwrap_or(0);
                    std::thread::sleep(Duration::from_millis(ms));
                }
                "collect-frames" => {
                    let count = act.get("count").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    let timeout = act.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(1000);
                    if count > 0 {
                        let baseline = self.state.0.lock().unwrap().frames.len();
                        let got = self.wait_for_frames(baseline, count as u32, Instant::now() + Duration::from_millis(timeout));
                        if got < count { timed_out = true; }
                    }
                }
                "expect-extra" => {
                    let hex = act.get("hex").and_then(|v| v.as_str()).unwrap_or("");
                    let timeout = act.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(1000);
                    if !self.wait_for_extra(hex, Instant::now() + Duration::from_millis(timeout)) {
                        timed_out = true;
                    }
                }
                "wake-pulse" => {
                    let ms = act.get("ms").and_then(|v| v.as_u64()).unwrap_or(2);
                    self.manager.set_signals(&self.connection_id, Some(true), None, None)?;
                    std::thread::sleep(Duration::from_millis(ms));
                    self.manager.set_signals(&self.connection_id, Some(false), None, None)?;
                }
                "clear-state" => self.reset(),
                "signals" => {
                    let dtr = act.get("dtr").and_then(|v| v.as_bool());
                    let rts = act.get("rts").and_then(|v| v.as_bool());
                    let brk = act.get("break").and_then(|v| v.as_bool());
                    self.manager.set_signals(&self.connection_id, brk, dtr, rts)?;
                    if let Some(hold) = act.get("holdMs").and_then(|v| v.as_u64()) {
                        std::thread::sleep(Duration::from_millis(hold));
                        let mut restore = Map::new();
                        if dtr.is_some() { restore.insert("dtr".into(), json!(!dtr.unwrap())); }
                        if rts.is_some() { restore.insert("rts".into(), json!(!rts.unwrap())); }
                        if brk.is_some() { restore.insert("break".into(), json!(false)); }
                        let _ = restore;
                        self.manager.set_signals(&self.connection_id, brk.map(|_| false), dtr.map(|v| !v), rts.map(|v| !v))?;
                    }
                }
                "repeat" => {
                    let times = act.get("times").and_then(|v| v.as_u64()).unwrap_or(1).max(1);
                    let steps = act.get("steps").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                    for _ in 0..times {
                        let sub = self.run_actions(&steps, None)?;
                        sent.extend(sub.sent);
                        if sub.timed_out { timed_out = true; break; }
                    }
                }
                // poll / expect-echo / get-result variants inside sequences use
                // the same primitives; extended poll is handled by the sequence
                // engine (not yet ported) — report clearly if encountered.
                "poll" => return Err("dut action 'poll' is not supported in run_command yet".into()),
                other => return Err(format!("unknown dut action: {other}")),
            }
        }

        let (frames, extras) = self.snapshot();
        Ok(ActionOutcome { sent, frames, extras, first_cmd, timed_out })
    }

    /// Judge the outcome against a profile command definition (manager.ts judge).
    pub fn judge(&self, command: &crate::model::DutCommand, out: &ActionOutcome, started: Instant) -> DutRunResult {
        let mut failed: Vec<String> = Vec::new();
        let mut verdict = "REPORT".to_string();
        let j: Option<&DutJudge> = command.judge.as_ref();
        if let Some(j) = j {
            verdict = "PASS".into();
            if out.timed_out {
                verdict = "TIMEOUT".into();
                failed.push("应答帧/超时未满足".into());
            }
            if verdict != "TIMEOUT" {
                let ridx = j.result_idx.unwrap_or(1);
                if j.echo_matches == Some(true) {
                    let e = out.frames.first();
                    let sb = out.sent.first().and_then(|s| parse_hex_bytes(s).into_iter().next());
                    let ok = match (e, sb) {
                        (Some(f), Some(b)) => f.bytes.first() == Some(&b) && f.bytes == parse_hex_bytes(out.sent.first().unwrap()),
                        _ => false,
                    };
                    if !ok {
                        verdict = "FAIL".into();
                        failed.push(format!("回显帧不符: {} (期望 {})",
                            e.map(|f| f.bytes.iter().map(|b| hex_byte(*b)).collect::<Vec<_>>().join(" ")).unwrap_or_else(|| "无".into()),
                            out.sent.first().cloned().unwrap_or_else(|| "?".into())));
                    }
                }
                if j.result_echoes_cmd == Some(true) {
                    match out.frames.get(ridx) {
                        Some(f) if f.bytes.first() == out.first_cmd.as_ref() => {},
                        other => {
                            verdict = "FAIL".into();
                            failed.push(format!("结果帧首字节 {} != 命令 {}",
                                other.and_then(|f| f.bytes.first()).map(|b| hex_byte(*b)).unwrap_or_else(|| "无".into()),
                                hex_byte(out.first_cmd.unwrap_or(0))));
                        }
                    }
                }
                if let Some(bytes) = &j.bytes {
                    match out.frames.get(ridx) {
                        Some(f) => {
                            for (idx_s, want_v) in bytes {
                                if let Ok(idx) = idx_s.parse::<usize>() {
                                    let want = num(Some(want_v), 0);
                                    let got = f.bytes.get(idx).copied().unwrap_or(0);
                                    if got != want {
                                        verdict = "FAIL".into();
                                        failed.push(format!("结果帧字节{idx}={}，期望{}", hex_byte(got), hex_byte(want)));
                                    }
                                }
                            }
                        }
                        None => {
                            verdict = "FAIL".into();
                            failed.push(format!("未收到结果帧(帧{})", ridx + 1));
                        }
                    }
                }
                if let Some(fb) = &j.frames_bytes {
                    for (i, want_opt) in fb.iter().enumerate() {
                        let Some(want) = want_opt else { continue; };
                        let Some(f) = out.frames.get(i) else {
                            verdict = "FAIL".into();
                            failed.push(format!("未收到帧{}", i + 1));
                            continue;
                        };
                        for (idx_s, want_v) in want {
                            if let Ok(idx) = idx_s.parse::<usize>() {
                                let want_b = num(Some(want_v), 0);
                                let got = f.bytes.get(idx).copied().unwrap_or(0);
                                if got != want_b {
                                    verdict = "FAIL".into();
                                    failed.push(format!("帧{}字节{idx}={}，期望{}", i + 1, hex_byte(got), hex_byte(want_b)));
                                }
                            }
                        }
                    }
                }
                if let Some(extra) = &j.extra_contains {
                    let need: String = extra.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_uppercase();
                    let have: String = out.extras.iter().map(|b| hex_byte(*b)).collect();
                    if !have.contains(&need) {
                        verdict = "FAIL".into();
                        failed.push(format!("回显字节流中未找到 {need}（收到: {}）", if have.is_empty() { "无".into() } else { have }));
                    }
                }
            }
        } else if out.timed_out {
            let wants_frames = false; // run_command profiles with no judge but timedOut — REPORT (matches Node)
            if wants_frames { verdict = "TIMEOUT".into(); }
        }

        DutRunResult {
            command: command.name.clone(),
            title: command.title.clone(),
            verdict,
            sent: out.sent.clone(),
            frames: out.frames.iter().map(|f| crate::model::DutFrameBytes {
                bytes: f.bytes.clone(),
                timestamp: f.timestamp.clone(),
            }).collect(),
            extras: out.extras.clone(),
            failed_checks: failed,
            elapsed_ms: started.elapsed().as_millis() as u64,
            note: command.note.clone(),
        }
    }
}

pub struct ActionOutcome {
    pub sent: Vec<String>,
    pub frames: Vec<ParsedFrame>,
    pub extras: Vec<u8>,
    pub first_cmd: Option<u8>,
    pub timed_out: bool,
}

pub fn parse_hex_bytes(s: &str) -> Vec<u8> {
    let clean: Vec<u8> = s.bytes().filter(|b| !(*b as char).is_ascii_whitespace()).collect();
    let b = clean.as_slice();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < b.len() {
        let h = (b[i] as char).to_digit(16);
        let l = (b[i + 1] as char).to_digit(16);
        if let (Some(h), Some(l)) = (h, l) {
            out.push(((h << 4) | l) as u8);
        }
        i += 2;
    }
    out
}

fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() { return true; }
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(checksum: &str) -> DutProfile {
        serde_json::from_value(json!({
            "name": "test", "chip": "generic", "description": "",
            "serial": { "baudRate": 115200 },
            "frame": { "length": 4, "checksumIndex": 3, "checksum": checksum },
            "commands": []
        })).unwrap()
    }

    #[test]
    fn checksum_algorithms() {
        // payload 0x06,0,0 -> sum=6, sum-complement=0xF9, xor=6
        assert_eq!(checksum_of(&[0x06, 0, 0, 0], 3, "sum-complement"), 0xF9);
        assert_eq!(checksum_of(&[0x06, 0, 0, 0], 3, "sum"), 0x06);
        assert_eq!(checksum_of(&[0x06, 0, 0, 0], 3, "xor"), 0x06);
    }

    #[test]
    fn num_accepts_hex_and_decimal() {
        assert_eq!(num(Some(&json!("0x0F")), 0), 0x0F);
        assert_eq!(num(Some(&json!("15")), 0), 15);
        assert_eq!(num(Some(&json!(10)), 0), 10);
    }

    #[test]
    fn parse_hex_roundtrip() {
        assert_eq!(parse_hex_bytes("0A FF"), vec![0x0A, 0xFF]);
    }

    #[test]
    fn frame_state_machine_with_noise_resync() {
        // Real DutSession: inject a noise byte + a valid frame via the raw-RX
        // path. Noise must land in extras, the frame must be extracted, and a
        // second valid frame after more noise must resync correctly.
        let manager = SerialManager::new();
        let session = DutSession::attach(Arc::new(profile("sum-complement")), "c-test".into(), manager);
        let mut frame = vec![0x03u8, 0x00, 0x00, 0];
        frame[3] = checksum_of(&frame, 3, "sum-complement");

        session.inject_rx(&[0x5A]);               // noise
        session.inject_rx(&[0x03]);               // frame start, split across reads
        session.inject_rx(&[0x00, 0x00]);
        session.inject_rx(&[frame[3]]);
        let (frames, extras) = session.snapshot();
        assert_eq!(extras, vec![0x5A], "noise byte must land in extras");
        assert_eq!(frames.len(), 1, "one valid frame must be extracted");
        assert_eq!(frames[0].bytes, frame);

        // More noise before a second frame — state machine must resync again.
        session.inject_rx(&[0xFF, 0xFE]);
        session.inject_rx(&frame);
        let (frames2, extras2) = session.snapshot();
        assert_eq!(frames2.len(), 2, "second frame must resync after noise");
        assert_eq!(extras2, vec![0x5A, 0xFF, 0xFE]);
        session.detach();
    }

    #[test]
    fn judge_frame_demo_result() {
        // Full judge path with a generic framed profile: a non-zero status byte
        // must produce FAIL with a failed check, zero must produce PASS.
        let manager = SerialManager::new();
        let profile_json = json!({
            "name": "frame-demo", "chip": "generic", "description": "",
            "serial": { "baudRate": 115200 },
            "frame": { "length": 4, "checksumIndex": 3, "checksum": "sum-complement" },
            "commands": [{
                "name": "read_value", "title": "Read value",
                "actions": [{ "type": "send-frame", "cmd": "0x01", "p1": "0", "p2": "0" }],
                "judge": { "echoMatches": true, "resultEchoesCmd": true, "bytes": { "1": 0 } }
            }]
        });
        let p: DutProfile = serde_json::from_value(profile_json).unwrap();
        let session = DutSession::attach(Arc::new(p), "c-judge".into(), manager);
        let def = session.profile().commands[0].clone();

        // Simulate: dispatch frame echo + result frame with status 0.
        let cmd: u8 = 0x01;
        let echo = vec![cmd, 0, 0, checksum_of(&[cmd, 0, 0, 0], 3, "sum-complement")];
        let result = vec![cmd, 0, 0, checksum_of(&[cmd, 0, 0, 0], 3, "sum-complement")];
        let sent_hex = echo.iter().map(|b| format!("{:02X}", b)).collect::<String>();
        let frames = vec![
            ParsedFrame { bytes: echo, timestamp: now_iso() },
            ParsedFrame { bytes: result, timestamp: now_iso() },
        ];
        let out = ActionOutcome {
            sent: vec![sent_hex],
            frames: frames.clone(),
            extras: vec![],
            first_cmd: Some(cmd),
            timed_out: false,
        };
        let r = session.judge(&def, &out, Instant::now());
        assert_eq!(r.verdict, "PASS", "all-zero result should PASS");
        assert!(r.failed_checks.is_empty());

        // Non-zero byte 1 -> FAIL.
        let bad = vec![cmd, 1, 0, checksum_of(&[cmd, 1, 0, 0], 3, "sum-complement")];
        let out2 = ActionOutcome {
            sent: vec![frames[0].bytes.iter().map(|b| format!("{:02X}", b)).collect()],
            frames: vec![frames[0].clone(), ParsedFrame { bytes: bad, timestamp: now_iso() }],
            extras: vec![],
            first_cmd: Some(cmd),
            timed_out: false,
        };
        let r2 = session.judge(&def, &out2, Instant::now());
        assert_eq!(r2.verdict, "FAIL", "non-zero status should FAIL");
        assert!(!r2.failed_checks.is_empty());
        session.detach();
    }
}
