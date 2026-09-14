#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SerialManager } from "./serial-manager.js";
import { createServer } from "./server.js";
import { createSerialBackend } from "./hub/serial-backend.js";
import { createHubWithFallback, type HubListenResult } from "./hub/server.js";

async function main() {
  // One SerialManager shared by MCP tools + optional in-process Hub UI.
  const manager = new SerialManager();

  let hub: HubListenResult | null = null;
  const hubEnabled = process.env.UART_HUB !== "0";

  if (hubEnabled) {
    const preferred = Number(process.env.UART_HUB_PORT || "8787");
    try {
      hub = await createHubWithFallback({
        backend: createSerialBackend(manager),
        preferredPort: preferred,
        portSpan: Number(process.env.UART_HUB_SPAN || "30"),
      });
      process.stderr.write(`UART Hub UI: ${hub.url}\n`);
      if (hub.autoShifted) {
        process.stderr.write(`  (port ${preferred} busy — using ${hub.port})\n`);
      }
      process.stderr.write(`Open this URL to monitor the SAME serial session as MCP.\n`);
    } catch (err: any) {
      process.stderr.write(`Hub UI failed to start (MCP continues): ${err?.message ?? err}\n`);
      hub = null;
    }
  }

  const server = createServer({
    manager,
    onConnectionOpen: (id) => {
      hub?.attach(id);
      process.stderr.write(`Monitoring connection ${id} in Hub UI\n`);
    },
    onConnectionClose: (id) => {
      if (hub?.getActiveConnectionId() === id) hub.clear();
    },
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("MCP UART server started on stdio\n");

  const shutdown = async () => {
    if (hub) await hub.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
