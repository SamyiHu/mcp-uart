//! DUT profiles and judging — milestone 3 (see README).
//!
//! The types are already in `model.rs`; the engine (profile load, frame parse,
//! judge rules, smoke sequencing) is being ported from `src/dut/*.ts`. Until it
//! lands, `uartd hub` reports `"features": { "dut": false }` and the console
//! hides the DUT tab, exactly like a Hub started without a DUT manager.

use crate::model::DutProfile;

/// Load every `*.json` profile from a directory.
pub fn load_profiles(dir: &std::path::Path) -> Vec<DutProfile> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|text| {
            serde_json::from_str::<DutProfile>(&text).map_err(|e| e.to_string())
        }) {
            Ok(profile) => out.push(profile),
            Err(err) => eprintln!("dut: skipped {}: {err}", path.display()),
        }
    }
    out
}
