//! uartd — serial daemon.
//!
//! Two modes:
//!   uartd hub   [--host 127.0.0.1] [--port 8787]   HTTP + SSE hub for the console
//!   uartd stdio                                    MCP server on stdin/stdout
//!
//! The Hub speaks the same contract as the browser console and the DSH panel
//! already use, so swapping Node for Rust changes nothing on the UI side.

mod orchestrator;
mod orchestrator_engine;
mod orchestrator_sequence;
mod encoding;
mod framing;
mod hub;
mod mcp;
mod model;
mod serial;
mod util;

use clap::{Parser, Subcommand};

use crate::serial::SerialManager;

#[derive(Parser, Debug)]
#[command(name = "uartd", version, about = "Serial port daemon (MCP + HTTP hub)")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Serve the HTTP/SSE hub used by the console UI.
    Hub {
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        #[arg(long, default_value_t = 8787)]
        port: u16,
        /// Number of following ports to try when the preferred one is busy.
        #[arg(long, default_value_t = 30)]
        port_span: u16,
    },
    /// Speak MCP over stdin/stdout.
    Stdio,
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Command::Hub { host, port, port_span } => {
            let manager = SerialManager::new();
            // Profile directory: env override, else the repo's src/orchestrator/profiles
            // relative to this source tree (CARGO_MANIFEST_DIR at compile time).
            let profiles_dir = std::env::var_os("UART_Orchestrator_PROFILES")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("..").join("src").join("orchestrator").join("profiles")
                });
            let state = hub::HubState::new(manager, &profiles_dir);
            let mut last = None;
            for candidate in port..=port.saturating_add(port_span) {
                match hub::serve(state.clone(), &format!("{host}:{candidate}")) {
                    Ok(()) => return,
                    Err(err) => {
                        // Windows maps WSAEADDRINUSE (10048) to Other, so check
                        // the raw OS error as well as the portable ErrorKind.
                        let busy = err.kind() == std::io::ErrorKind::AddrInUse
                            || err.kind() == std::io::ErrorKind::PermissionDenied
                            || err.raw_os_error() == Some(10048);
                        if !busy {
                            eprintln!("uartd: cannot bind {host}:{candidate}: {err}");
                            std::process::exit(1);
                        }
                        last = Some(err);
                    }
                }
            }
            eprintln!(
                "uartd: cannot bind any port in {port}..{}: {}",
                port.saturating_add(port_span),
                last.map(|e| e.to_string()).unwrap_or_default()
            );
            std::process::exit(1);
        }
        Command::Stdio => {
            let manager = SerialManager::new();
            if let Err(err) = mcp::serve(manager) {
                eprintln!("uartd: mcp loop failed: {err}");
                std::process::exit(1);
            }
        }
    }
}
