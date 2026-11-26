//! Shared wire types. Field names must match the Node implementation exactly:
//! the browser console and the DSH panel consume these JSON shapes verbatim.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Rx,
    Tx,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialMessage {
    pub timestamp: String,
    pub connection_id: String,
    pub data: String,
    pub raw: String,
    pub length: usize,
    pub direction: Direction,
}

impl SerialMessage {
    /// JSON key names use camelCase on the wire.
    pub fn to_wire(&self) -> serde_json::Value {
        serde_json::json!({
            "timestamp": self.timestamp,
            "connectionId": self.connection_id,
            "data": self.data,
            "raw": self.raw,
            "length": self.length,
            "direction": match self.direction { Direction::Rx => "rx", Direction::Tx => "tx" },
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    pub path: String,
    pub baud_rate: u32,
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    #[serde(default = "default_stop_bits")]
    pub stop_bits: u8,
    #[serde(default = "default_parity")]
    pub parity: String,
    #[serde(default = "default_encoding")]
    pub encoding: String,
    #[serde(default = "default_protocol")]
    pub protocol: String,
    #[serde(default)]
    pub delimiter: Option<String>,
    #[serde(default)]
    pub frame_start: Option<String>,
    #[serde(default)]
    pub frame_end: Option<String>,
    #[serde(default = "default_buffer_size")]
    pub buffer_size: usize,
    #[serde(default = "default_true")]
    pub dtr: bool,
    #[serde(default = "default_true")]
    pub rts: bool,
}

fn default_data_bits() -> u8 { 8 }
fn default_stop_bits() -> u8 { 1 }
fn default_parity() -> String { "none".into() }
fn default_encoding() -> String { "utf8".into() }
fn default_protocol() -> String { "line".into() }
fn default_buffer_size() -> usize { 1000 }
fn default_true() -> bool { true }

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            path: String::new(),
            baud_rate: 115200,
            data_bits: 8,
            stop_bits: 1,
            parity: "none".into(),
            encoding: "utf8".into(),
            protocol: "line".into(),
            delimiter: None,
            frame_start: None,
            frame_end: None,
            buffer_size: 1000,
            dtr: true,
            rts: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: String,
    pub config: SerialConfig,
    pub status: String,
    pub opened_at: String,
    pub message_count: u64,
    pub last_activity: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub path: String,
    pub manufacturer: Option<String>,
    pub serial_number: Option<String>,
    pub vendor_id: Option<String>,
    pub product_id: Option<String>,
}

/// Orchestrator profile as stored in `profiles/*.json`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorProfile {
    pub name: String,
    #[serde(default)]
    pub chip: String,
    #[serde(default)]
    pub description: String,
    pub serial: OrchestratorSerial,
    #[serde(default)]
    pub frame: Option<OrchestratorFrame>,
    #[serde(default)]
    pub commands: Vec<OrchestratorCommand>,
    #[serde(default)]
    pub smoke: Vec<String>,
    #[serde(default)]
    pub low_power: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorSerial {
    #[serde(default = "default_baud")]
    pub baud_rate: u32,
    pub data_bits: Option<u8>,
    pub stop_bits: Option<u8>,
    pub parity: Option<String>,
    pub wiring: Option<String>,
}

fn default_baud() -> u32 { 115200 }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorFrame {
    pub length: usize,
    pub checksum_index: usize,
    #[serde(default)]
    pub checksum: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorCommand {
    pub name: String,
    #[serde(default)]
    pub title: String,
    /// Actions are opaque to the Rust engine for now; the judge rules below are
    /// what decide PASS/FAIL.
    #[serde(default)]
    pub actions: Vec<serde_json::Value>,
    #[serde(default)]
    pub judge: Option<OrchestratorJudge>,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub fpga_suitable: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorJudge {
    #[serde(default)]
    pub result_idx: Option<usize>,
    #[serde(default)]
    pub bytes: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    pub frames_bytes: Option<Vec<Option<serde_json::Map<String, serde_json::Value>>>>,
    #[serde(default)]
    pub extra_contains: Option<String>,
    #[serde(default)]
    pub echo_matches: Option<bool>,
    #[serde(default)]
    pub result_echoes_cmd: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorRunResult {
    pub command: String,
    pub title: String,
    pub verdict: String,
    pub sent: Vec<String>,
    pub frames: Vec<OrchestratorFrameBytes>,
    pub extras: Vec<u8>,
    pub failed_checks: Vec<String>,
    pub elapsed_ms: u64,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OrchestratorFrameBytes {
    pub bytes: Vec<u8>,
    pub timestamp: String,
}
