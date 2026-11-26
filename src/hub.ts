#!/usr/bin/env node
/**
 * mcp-uart-hub — local HTTP host UI for UART (config + live monitor).
 *
 * Usage:
 *   mcp-uart-hub [--port 8787] [--host 127.0.0.1] [--port-span 30]
 *
 * If preferred port is busy, automatically tries preferred+1 … preferred+span,
 * then an ephemeral port. Pass --strict-port to fail hard instead.
 */
import { SerialManager } from "./serial-manager.js";
import { createSerialBackend } from "./hub/serial-backend.js";
import { createOrchestratorBackend } from "./hub/orchestrator-backend.js";
import { createHubWithFallback } from "./hub/server.js";
import { OrchestratorManager } from "./orchestrator/manager.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const host = arg("host", "127.0.0.1")!;
  const preferredPort = Number(arg("port", "8787"));
  const portSpan = Number(arg("port-span", "30"));
  const strict = hasFlag("strict-port");
  const manager = new SerialManager();
  const backend = createSerialBackend(manager);
  const orchestrator = createOrchestratorBackend(new OrchestratorManager(manager), manager);

  let hub;
  if (strict) {
    const { createHub } = await import("./hub/server.js");
    hub = {
      ...(await createHub({ backend, orchestrator, host, port: preferredPort })),
      preferredPort,
      autoShifted: false,
    };
  } else {
    hub = await createHubWithFallback({
      backend,
      orchestrator,
      host,
      preferredPort,
      portSpan,
    });
  }

  const notes: string[] = [];
  if (hub.autoShifted) {
    notes.push(
      `Port ${preferredPort} was busy — using ${hub.port} instead.`
    );
  }

  process.stderr.write(`UART Hub listening on ${hub.url}\n`);
  for (const n of notes) process.stderr.write(`  * ${n}\n`);
  process.stderr.write(`Open the URL in a browser. Ctrl+C to exit.\n`);

  // Also print a single machine-friendly line for scripts
  process.stderr.write(`HUB_URL=${hub.url}\nHUB_PORT=${hub.port}\n`);

  const shutdown = async () => {
    process.stderr.write("\nShutting down...\n");
    await hub.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`Hub fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
