//! Small helpers shared by the modules.

use chrono::Utc;

/// ISO-8601 UTC timestamp, same shape the Node build emitted.
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Monotonic counter helper for request ids.
pub fn json_error(message: impl Into<String>) -> serde_json::Value {
    serde_json::json!({ "ok": false, "error": message.into() })
}

pub fn json_ok() -> serde_json::Value {
    serde_json::json!({ "ok": true })
}
