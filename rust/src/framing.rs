//! Framing: turn the serial byte stream into messages.
//!
//! The rule that matters for the console: a frame is a complete line / delimited
//! frame, never an arbitrary read chunk. `line` accepts CRLF, LF or CR and joins
//! a line split across reads; `raw` deliberately emits every read as one frame.

#[derive(Debug, Clone)]
pub enum Framing {
    /// One frame per read — the old default, kept as an explicit choice.
    Raw,
    /// Split on CR, LF or CRLF; a trailing unterminated line flushes at the end.
    Line,
    /// Split on a custom byte sequence.
    Delimiter(Vec<u8>),
    /// Payload between a start marker (optional) and an end marker.
    HexFrame { start: Option<Vec<u8>>, end: Vec<u8> },
    /// SLIP (RFC 1055).
    Slip,
    /// Modbus RTU: frame boundary by inter-frame silence.
    ModbusRtu,
}

impl Framing {
    pub fn from_config(protocol: &str, delimiter: Option<&str>, start: Option<&str>, end: Option<&str>) -> Self {
        match protocol {
            "line" => Framing::Line,
            "delimiter" => Framing::Delimiter(hex_to_bytes(delimiter.unwrap_or("0D0A"))),
            "hex-frame" => Framing::HexFrame {
                start: start.map(hex_to_bytes),
                end: hex_to_bytes(end.unwrap_or("0D0A")),
            },
            "slip" => Framing::Slip,
            "modbus-rtu" => Framing::ModbusRtu,
            _ => Framing::Raw,
        }
    }
}

pub struct Framer {
    framing: Framing,
    buf: Vec<u8>,
    slip_frame: Vec<u8>,
    slip_escape: bool,
}

impl Framer {
    pub fn new(framing: Framing) -> Self {
        Self { framing, buf: Vec::new(), slip_frame: Vec::new(), slip_escape: false }
    }

    /// Feed bytes; returns every complete frame produced by this chunk.
    pub fn push(&mut self, bytes: &[u8], idle_gap: bool) -> Vec<Vec<u8>> {
        match &self.framing {
            Framing::Raw => vec![bytes.to_vec()],
            Framing::Line => self.push_line(bytes),
            Framing::Delimiter(delim) => {
                let delim = delim.clone();
                self.push_delimiter(bytes, delim)
            }
            Framing::HexFrame { start, end } => {
                let start = start.clone();
                let end = end.clone();
                self.push_hex_frame(bytes, start, end)
            }
            Framing::Slip => self.push_slip(bytes),
            // Modbus is gap-driven: the caller passes `idle_gap` when the line
            // has been quiet long enough.
            Framing::ModbusRtu => {
                self.buf.extend_from_slice(bytes);
                if idle_gap && !self.buf.is_empty() {
                    let frame = std::mem::take(&mut self.buf);
                    return vec![frame];
                }
                Vec::new()
            }
        }
    }

    /// Flush a partial frame at end of stream.
    pub fn flush(&mut self) -> Vec<Vec<u8>> {
        let rest = std::mem::take(&mut self.buf);
        if rest.is_empty() {
            Vec::new()
        } else {
            vec![rest]
        }
    }

    fn push_line(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        let mut start = 0usize;
        let mut i = 0usize;
        while i < self.buf.len() {
            let b = self.buf[i];
            if b != b'\n' && b != b'\r' {
                i += 1;
                continue;
            }
            if i > start {
                out.push(self.buf[start..i].to_vec());
            }
            // A CRLF pair is one terminator.
            if b == b'\r' && self.buf.get(i + 1) == Some(&b'\n') {
                i += 1;
            }
            start = i + 1;
            i += 1;
        }
        self.buf.drain(..start.min(self.buf.len()));
        out
    }

    fn push_delimiter(&mut self, bytes: &[u8], delim: Vec<u8>) -> Vec<Vec<u8>> {
        if delim.is_empty() {
            return vec![bytes.to_vec()];
        }
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(pos) = find_subslice(&self.buf, &delim) {
            if pos > 0 {
                out.push(self.buf[..pos].to_vec());
            }
            self.buf.drain(..pos + delim.len());
        }
        out
    }

    fn push_hex_frame(&mut self, bytes: &[u8], start: Option<Vec<u8>>, end: Vec<u8>) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            if let Some(marker) = &start {
                match find_subslice(&self.buf, marker) {
                    Some(pos) => {
                        self.buf.drain(..pos + marker.len());
                    }
                    None => {
                        // Keep only a possible partial marker tail.
                        let keep = marker.len().saturating_sub(1);
                        if self.buf.len() > keep {
                            let drain = self.buf.len() - keep;
                            self.buf.drain(..drain);
                        }
                        break;
                    }
                }
            }
            match find_subslice(&self.buf, &end) {
                Some(pos) => {
                    let frame = self.buf[..pos].to_vec();
                    self.buf.drain(..pos + end.len());
                    if !frame.is_empty() {
                        out.push(frame);
                    }
                }
                None => break,
            }
        }
        out
    }

    fn push_slip(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        for &b in bytes {
            if b == 0xC0 {
                if !self.slip_frame.is_empty() {
                    out.push(std::mem::take(&mut self.slip_frame));
                }
                self.slip_escape = false;
                continue;
            }
            if b == 0xDB {
                self.slip_escape = true;
                continue;
            }
            if self.slip_escape {
                self.slip_escape = false;
                match b {
                    0xDC => self.slip_frame.push(0xC0),
                    0xDD => self.slip_frame.push(0xDB),
                    _ => {
                        self.slip_frame.push(0xDB);
                        self.slip_frame.push(b);
                    }
                }
                continue;
            }
            self.slip_frame.push(b);
        }
        out
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

pub fn hex_to_bytes(text: &str) -> Vec<u8> {
    let cleaned: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = cleaned.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if let (Some(h), Some(l)) = ((bytes[i] as char).to_digit(16), (bytes[i + 1] as char).to_digit(16)) {
            out.push(((h << 4) | l) as u8);
        }
        i += 2;
    }
    out
}

/// Silence-driven framer for Modbus: tracks the last byte time.
#[derive(Default)]
pub struct IdleClock {
    last: Option<std::time::Instant>,
}

impl IdleClock {
    pub fn mark(&mut self) {
        self.last = Some(std::time::Instant::now());
    }

    pub fn idle_ms(&self) -> u64 {
        self.last.map(|t| t.elapsed().as_millis() as u64).unwrap_or(u64::MAX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line_frames(chunks: &[&str]) -> Vec<String> {
        let mut f = Framer::new(Framing::Line);
        let mut out = Vec::new();
        for chunk in chunks {
            for frame in f.push(chunk.as_bytes(), false) {
                out.push(String::from_utf8_lossy(&frame).to_string());
            }
        }
        for frame in f.flush() {
            out.push(String::from_utf8_lossy(&frame).to_string());
        }
        out
    }

    #[test]
    fn line_splits_on_crlf_lf_and_cr() {
        assert_eq!(line_frames(&["a\r\nb\r\nc"]), vec!["a", "b", "c"]);
        assert_eq!(line_frames(&["a\n", "b\n"]), vec!["a", "b"]);
        assert_eq!(line_frames(&["a\rb\r"]), vec!["a", "b"]);
    }

    #[test]
    fn a_line_split_across_reads_is_one_frame() {
        assert_eq!(
            line_frames(&["TEMP=2", "7.5C VDD", "=3.30V\r\n"]),
            vec!["TEMP=27.5C VDD=3.30V"]
        );
    }

    #[test]
    fn blank_lines_are_dropped() {
        assert_eq!(line_frames(&["x\r\n\r\ny\r\n"]), vec!["x", "y"]);
    }

    #[test]
    fn delimiter_and_hex_frame() {
        let mut f = Framer::new(Framing::Delimiter(vec![0x00]));
        let out = f.push(b"aa\x00bb\x00", false);
        assert_eq!(out, vec![b"aa".to_vec(), b"bb".to_vec()]);

        let mut h = Framer::new(Framing::HexFrame {
            start: Some(vec![0xAA, 0x55]),
            end: vec![0x0D, 0x0A],
        });
        let mut frames = h.push(&[0xFF, 0xFF, 0xAA, 0x55, 1, 2, 3, 4, 0x0D, 0x0A], false);
        frames.extend(h.push(&[0xAA, 0x55, 0xAA, 0xBB, 0x0D, 0x0A], false));
        assert_eq!(frames, vec![vec![1, 2, 3, 4], vec![0xAA, 0xBB]]);
    }
}
