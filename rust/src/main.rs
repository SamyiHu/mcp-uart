//! uartd — serial daemon.
//!
//! Two modes:
//!   uartd hub   [--host 127.0.0.1] [--port 8787]   HTTP + SSE hub for the console
//!   uartd stdio                                    MCP server on stdin/stdout
//!
//! The Hub speaks the same contract as the browser console and the DSH panel
//! already use, so swapping Node for Rust changes nothing on the UI side.

mod dut;
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
    },
    /// Speak MCP over stdin/stdout.
    Stdio,
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Command::Hub { host, port } => {
            let manager = SerialManager::new();
            let state = hub::HubState::new(manager);
            if let Err(err) = hub::serve(state, &format!("{host}:{port}")) {
                eprintln!("uartd: cannot bind {host}:{port}: {err}");
                std::process::exit(1);
            }
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
