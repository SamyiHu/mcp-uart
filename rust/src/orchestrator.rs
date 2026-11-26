//! Orchestrator manager — Rust port of `src/orchestrator/manager.ts` + the HubOrchestrator façade in
//! `src/hub/orchestrator-backend.ts`. Holds attached sessions keyed by connection id
//! and exposes profile/status/connect/disconnect/run/smoke to the Hub.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};

use crate::orchestrator_engine::{checksum_of, OrchestratorSession};
use crate::model::{OrchestratorProfile, OrchestratorRunResult};
use crate::serial::SerialManager;

/// Progress event sent to the Hub while a smoke run is in progress.
#[derive(Clone, Debug)]
pub enum OrchestratorEvent {
    SmokeStart { profile: String, total: usize },
    SmokeStep { index: usize, total: usize, step: OrchestratorRunResult },
    SmokeDone { pass: usize, fail: usize, report: usize, elapsed_ms: u64 },
}

/// Manager for one Hub: profiles + attached sessions.
pub struct OrchestratorManager {
    serial: Arc<SerialManager>,
    profiles: Vec<OrchestratorProfile>,
    sessions: Mutex<HashMap<String, Arc<OrchestratorSession>>>,
    busy: AtomicBool,
}

impl OrchestratorManager {
    /// Load profiles from a directory (the Hub passes src/orchestrator/profiles).
    pub fn new(serial: Arc<SerialManager>, profiles_dir: &std::path::Path) -> Arc<Self> {
        let profiles = load_profiles(profiles_dir);
        Arc::new(Self {
            serial,
            profiles,
            sessions: Mutex::new(HashMap::new()),
            busy: AtomicBool::new(false),
        })
    }

    pub fn profiles(&self) -> Vec<Value> {
        self.profiles.iter().map(|p| {
            json!({
                "name": p.name,
                "chip": p.chip,
                "description": p.description,
                "serial": {
                    "baudRate": p.serial.baud_rate,
                    "wiring": p.serial.wiring,
                },
                "frame": p.frame.as_ref().map(|f| json!({
                    "length": f.length, "checksumIndex": f.checksum_index, "checksum": f.checksum
                })).unwrap_or(Value::Null),
                "commands": p.commands.iter().map(|c| json!({
                    "name": c.name,
                    "title": c.title,
                    "fpgaSuitable": c.fpga_suitable.unwrap_or(false),
                })).collect::<Vec<_>>(),
                "smoke": p.smoke,
                "lowPower": p.low_power,
            })
        }).collect()
    }

    pub fn busy(&self) -> bool { self.busy.load(Ordering::Relaxed) }

    fn find_profile(&self, name: &str) -> Result<OrchestratorProfile, String> {
        self.profiles.iter().find(|p| p.name == name).cloned()
            .ok_or_else(|| format!("Unknown Orchestrator profile '{name}'. Available: {}",
                self.profiles.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ")))
    }

    pub fn has_session(&self, connection_id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(connection_id)
    }

    /// Status shape matches Node `status()` in orchestrator-backend.ts.
    pub fn status(&self, connection_id: Option<String>) -> Value {
        let sessions = self.sessions.lock().unwrap();
        let s = connection_id.as_ref().and_then(|id| sessions.get(id));
        match s {
            None => json!({
                "connected": false,
                "profile": null,
                "connectionId": null,
                "port": null,
                "baudRate": null,
                "busy": self.busy(),
            }),
            Some(session) => {
                let p = session.profile();
                json!({
                    "connected": true,
                    "profile": p.name,
                    "connectionId": session.connection_id(),
                    "busy": self.busy(),
                })
            }
        }
    }

    /// Attach a Orchestrator session to an existing connection (or open a new port when
    /// no connection id is supplied). Mirrors HubOrchestrator::connect.
    pub fn connect(
        &self,
        profile: &str,
        path: Option<&str>,
        baud_rate: Option<u32>,
        connection_id: Option<String>,
    ) -> Result<(String, bool), String> {
        let profile_def = self.find_profile(profile)?;
        // If the caller passed an active connection, attach to it directly.
        if let Some(id) = connection_id {
            if !self.has_session(&id) {
                let session = OrchestratorSession::attach(Arc::new(profile_def), id.clone(), self.serial.clone());
                self.sessions.lock().unwrap().insert(id.clone(), session);
            }
            return Ok((id, false));
        }
        let path = path.ok_or("path is required to open a Orchestrator port")?;
        let mut config = crate::model::SerialConfig::default();
        config.path = path.to_string();
        config.baud_rate = baud_rate.unwrap_or(profile_def.serial.baud_rate);
        config.data_bits = profile_def.serial.data_bits.unwrap_or(8);
        config.stop_bits = profile_def.serial.stop_bits.unwrap_or(1);
        config.parity = profile_def.serial.parity.clone().unwrap_or_else(|| "none".into());
        let (id, _info) = self.serial.open(config)?;
        let session = OrchestratorSession::attach(Arc::new(profile_def), id.clone(), self.serial.clone());
        self.sessions.lock().unwrap().insert(id.clone(), session);
        Ok((id, true))
    }

    pub fn disconnect(&self, connection_id: Option<String>, close_port: bool) -> Result<(), String> {
        let id = connection_id.ok_or("No active connection")?;
        let session = self.sessions.lock().unwrap().remove(&id);
        if let Some(s) = session { s.detach(); }
        if close_port { self.serial.close(&id)?; }
        Ok(())
    }

    fn require_session(&self, connection_id: Option<String>) -> Result<Arc<OrchestratorSession>, String> {
        let id = connection_id.ok_or("No Orchestrator session. Connect a profile first.")?;
        self.sessions.lock().unwrap().get(&id).cloned()
            .ok_or_else(|| format!("No Orchestrator session on {id}. Call orchestrator_connect first."))
    }

    pub fn run_command(&self, connection_id: Option<String>, name: &str) -> Result<OrchestratorRunResult, String> {
        if self.busy() { return Err("A smoke run is already in progress".into()); }
        let session = self.require_session(connection_id)?;
        let def = session.profile().commands.iter().find(|c| c.name == name)
            .cloned()
            .ok_or_else(|| format!("Command '{name}' not in profile '{}'. Available: {}",
                session.profile().name,
                session.profile().commands.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", ")))?;
        let started = Instant::now();
        let out = session.run_actions(&def.actions, None)?;
        Ok(session.judge(&def, &out, started))
    }

    /// Run the profile smoke sequence, emitting progress events.
    pub fn run_smoke(
        &self,
        connection_id: Option<String>,
        include_low_power: bool,
        on_event: &dyn Fn(OrchestratorEvent),
    ) -> Result<Value, String> {
        if self.busy() { return Err("A smoke run is already in progress".into()); }
        let session = self.require_session(connection_id)?;
        self.busy.store(true, Ordering::Relaxed);
        let started = Instant::now();
        let result = (|| -> Result<Value, String> {
            let p = session.profile();
            let mut names = p.smoke.clone();
            if include_low_power { names.extend(p.low_power.clone()); }
            let planned: Vec<&String> = names.iter().filter(|n| p.commands.iter().any(|c| &c.name == *n)).collect();
            on_event(OrchestratorEvent::SmokeStart { profile: p.name.clone(), total: planned.len() });

            let mut steps: Vec<OrchestratorRunResult> = Vec::new();
            for (i, name) in planned.iter().enumerate() {
                let def = p.commands.iter().find(|c| &c.name == *name).unwrap();
                let t0 = Instant::now();
                let out = session.run_actions(&def.actions, None)?;
                let result = session.judge(def, &out, t0);
                steps.push(result.clone());
                on_event(OrchestratorEvent::SmokeStep { index: i, total: planned.len(), step: result });
            }
            let pass = steps.iter().filter(|s| s.verdict == "PASS").count();
            let fail = steps.iter().filter(|s| s.verdict == "FAIL" || s.verdict == "TIMEOUT").count();
            let report = steps.len() - pass - fail;
            on_event(OrchestratorEvent::SmokeDone { pass, fail, report, elapsed_ms: started.elapsed().as_millis() as u64 });

            Ok(json!({
                "profile": p.name,
                "steps": steps,
                "passed": pass,
                "failed": fail,
                "report": report,
                "allPassed": fail == 0 && pass > 0,
            }))
        })();
        self.busy.store(false, Ordering::Relaxed);
        result
    }

    /// Run a free-form action sequence (the `sequence` tool action).
    ///
    /// Mirrors the Node `orchestrator_sequence` engine: budget, poll loops, repeats,
    /// step logging and signal restore all live in `orchestrator_sequence`.
    pub fn run_sequence(
        &self,
        connection_id: Option<String>,
        actions: &[Value],
        options: &Value,
    ) -> Result<Value, String> {
        if self.busy() { return Err("A smoke run is already in progress".into()); }
        let session = self.require_session(connection_id)?;
        self.busy.store(true, Ordering::Relaxed);
        let result = crate::orchestrator_sequence::run_sequence(&session, actions, options);
        self.busy.store(false, Ordering::Relaxed);
        result
    }

    /// Utility used by checksum tests and the HTTP layer to explain a frame.
    pub fn checksum_of(bytes: &[u8], index: usize, algorithm: &str) -> u8 {
        checksum_of(bytes, index, algorithm)
    }
}

/// Load every `*.json` profile from a directory.
pub fn load_profiles(dir: &std::path::Path) -> Vec<OrchestratorProfile> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out; };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
        match std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|text| serde_json::from_str::<OrchestratorProfile>(&text).map_err(|e| e.to_string()))
        {
            Ok(profile) => out.push(profile),
            Err(err) => eprintln!("orchestrator: skipped {}: {err}", path.display()),
        }
    }
    out
}
