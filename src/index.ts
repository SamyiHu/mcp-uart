#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { SerialManager } from "./serial-manager.js";
import { createServer } from "./server.js";
import { createSerialBackend } from "./hub/serial-backend.js";
import { createDutBackend } from "./hub/dut-backend.js";
import { createHubWithFallback, type HubListenResult } from "./hub/server.js";
import { DutManager } from "./dut/manager.js";

/**
 * Where this process advertises its Hub URL.
 *
 * Other processes cannot read our stderr, so the Hub address is published to a
 * small JSON file. The DSH plugin (and any other local front end) reads it to
 * find the Hub that owns the same SerialManager as the MCP tools. Override with
 * UART_HUB_FILE; set UART_HUB=0 to run without a Hub at all.
 */
export function hubDiscoveryFile(): string {
  return process.env.UART_HUB_FILE || join(homedir(), ".mcp-uart", "hub.json");
}

type HubAdvertisement = {
  url: string;
  port: number;
  pid: number;
  version: string;
  startedAt: string;
  hub: "in-process";
};

/** Publish atomically so a reader never sees a half-written file. */
function publishHub(info: HubAdvertisement): void {
  const file = hubDiscoveryFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(info, null, 2), "utf8");
    renameSync(tmp, file);
  } catch (err: any) {
    process.stderr.write(`Hub discovery file not written (${file}): ${err?.message ?? err}\n`);
  }
}

/** Remove the file only when it still belongs to this process. */
function unpublishHub(): void {
  const file = hubDiscoveryFile();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<HubAdvertisement>;
    if (parsed.pid === process.pid) unlinkSync(file);
  } catch {
    /* nothing to clean up */
  }
}

async function main() {
  // One SerialManager shared by MCP tools + optional in-process Hub UI; one
  // DutManager too, so the panel's DUT page runs over the same session.
  const manager = new SerialManager();
  const dut = new DutManager(manager);

  let hub: HubListenResult | null = null;
  const hubEnabled = process.env.UART_HUB !== "0";

  if (hubEnabled) {
    const preferred = Number(process.env.UART_HUB_PORT || "8787");
    try {
      hub = await createHubWithFallback({
        backend: createSerialBackend(manager),
        dut: createDutBackend(dut, manager),
        preferredPort: preferred,
        portSpan: Number(process.env.UART_HUB_SPAN || "30"),
      });
      process.stderr.write(`UART Hub UI: ${hub.url}\n`);
      if (hub.autoShifted) {
        process.stderr.write(`  (port ${preferred} busy — using ${hub.port})\n`);
      }
      process.stderr.write(`Open this URL to monitor the SAME serial session as MCP.\n`);
      publishHub({
        url: hub.url,
        port: hub.port,
        pid: process.pid,
        version: process.env.npm_package_version || "1.4.0",
        startedAt: new Date().toISOString(),
        hub: "in-process",
      });
    } catch (err: any) {
      process.stderr.write(`Hub UI failed to start (MCP continues): ${err?.message ?? err}\n`);
      hub = null;
    }
  }

  const server = createServer({
    manager,
    dut,
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
    unpublishHub();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", unpublishHub);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
