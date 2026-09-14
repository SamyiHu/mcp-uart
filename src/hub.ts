#!/usr/bin/env node
/**
 * mcp-uart-hub — local HTTP host UI for UART (config + live monitor).
 *
 * Usage:
 *   mcp-uart-hub [--port 8787] [--host 127.0.0.1]
 */
import { SerialManager } from "./serial-manager.js";
import { createSerialBackend } from "./hub/serial-backend.js";
import { createHub } from "./hub/server.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return fallback;
}

async function main() {
  const host = arg("host", "127.0.0.1")!;
  const port = Number(arg("port", "8787"));
  const manager = new SerialManager();
  const hub = await createHub({
    backend: createSerialBackend(manager),
    host,
    port,
  });

  process.stderr.write(`UART Hub listening on ${hub.url}\n`);
  process.stderr.write(`Open the URL in a browser. Ctrl+C to exit.\n`);

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
