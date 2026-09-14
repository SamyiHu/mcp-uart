import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import { SerialManager } from "./serial-manager.js";
import { listEncodings } from "./encodings.js";
import { listProtocols } from "./protocols.js";
import type { SerialConfig, BaudRate, Encoding, ProtocolMode, MessageFilter, SerialMessage } from "./types.js";
import { DutManager, formatRun, hex } from "./dut/manager.js";
import { listProfiles } from "./dut/profiles/index.js";
import { extractFromMessages, extractFromObject } from "./extract.js";
import { renderTimelineHtml, renderSmokeHtml, writeHtmlReport } from "./visualize.js";
import { ok, fail } from "./respond.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IS_WIN = process.platform === "win32";
const SERVER_VERSION = "1.2.0";

const hexNum = z
  .number()
  .int()
  .min(0)
  .max(255)
  .describe("字节值 0~255（十进制；如需 0x5A 请换算为 90）");

const msgJson = z.array(
  z.object({
    timestamp: z.string(),
    connectionId: z.string(),
    data: z.string(),
    raw: z.string().optional(),
    length: z.number(),
    direction: z.enum(["rx", "tx"]),
  })
);

const messagesBrief = (ms: SerialMessage[]) =>
  ms.map((m) => ({
    timestamp: m.timestamp,
    connectionId: m.connectionId,
    data: m.data,
    raw: m.raw,
    length: m.length,
    direction: m.direction,
  }));

export type ServerHooks = {
  /** Shared manager (so an in-process Hub can monitor the same SerialManager). */
  manager?: SerialManager;
  /** Called after a port is successfully opened by MCP tools. */
  onConnectionOpen?: (connectionId: string) => void;
  /** Called when MCP closes a connection. */
  onConnectionClose?: (connectionId: string) => void;
};

export function createServer(hooks: ServerHooks = {}): McpServer {
  const server = new McpServer({
    name: "mcp-uart",
    version: SERVER_VERSION,
  });

  const manager = hooks.manager ?? new SerialManager();
  const monitorProcesses = new Map<string, ReturnType<typeof spawn>>();
  const dut = new DutManager(manager);

  // ──────────────────────────────────────────────
  // Resources
  // ──────────────────────────────────────────────

  server.resource("connections", "serial://connections", async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(manager.listConnections(), null, 2),
      },
    ],
  }));

  server.resource("encodings", "serial://encodings", async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(listEncodings(), null, 2),
      },
    ],
  }));

  server.resource("protocols", "serial://protocols", async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(listProtocols(), null, 2),
      },
    ],
  }));

  server.resource(
    "frames",
    new ResourceTemplate("serial://{connectionId}/frames", { list: undefined }),
    async (uri, vars) => {
      const connectionId = String(vars.connectionId);
      const messages = manager.peekMessages(connectionId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                connectionId,
                count: messages.length,
                messages: messagesBrief(messages),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ──────────────────────────────────────────────
  // Generic serial tools
  // ──────────────────────────────────────────────

  server.registerTool(
    "serial_list_ports",
    {
      title: "List serial ports",
      description:
        "List all available serial ports. structuredContent.ports[] has path/manufacturer/usb ids.",
      outputSchema: {
        ports: z.array(
          z.object({
            path: z.string(),
            manufacturer: z.string().optional(),
            serialNumber: z.string().optional(),
            vendorId: z.string().optional(),
            productId: z.string().optional(),
            pnpId: z.string().optional(),
          })
        ),
        count: z.number(),
      },
    },
    async () => {
      try {
        const ports = await manager.listPorts();
        const data = {
          ports,
          count: ports.length,
        };
        return ok(
          data as any,
          ports.length === 0
            ? "No serial ports found."
            : `Found ${ports.length} port(s):\n${ports.map((p) => `  ${p.path}  ${p.manufacturer ?? ""}`).join("\n")}`
        );
      } catch (err: any) {
        return fail(`Error listing ports: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "serial_open",
    {
      title: "Open serial port",
      description:
        "Open a serial port. Returns connectionId. autoMonitor defaults to FALSE (no terminal popup) — set true only for human debugging.",
      inputSchema: {
        path: z.string().describe("Serial port path, e.g. COM3, /dev/ttyUSB0"),
        baudRate: z.number().optional().default(115200).describe("Baud rate: 110-921600"),
        dataBits: z.number().optional().default(8).describe("Data bits: 5, 6, 7, or 8"),
        stopBits: z.number().optional().default(1).describe("Stop bits: 1, 1.5, or 2"),
        parity: z
          .enum(["none", "odd", "even", "mark", "space"])
          .optional()
          .default("none")
          .describe("Parity mode"),
        flowControl: z.enum(["none", "hardware", "software"]).optional().default("none"),
        encoding: z
          .string()
          .optional()
          .default("utf8")
          .describe("utf8, ascii, latin1, gbk, gb2312, gb18030, big5, shift_jis, euc-kr, hex, base64, binary"),
        protocol: z
          .string()
          .optional()
          .default("line")
          .describe("raw, line, delimiter, modbus-rtu, hex-frame, slip"),
        delimiter: z.string().optional().describe("Custom delimiter hex (e.g. '0D0A') with delimiter protocol"),
        frameStart: z.string().optional(),
        frameEnd: z.string().optional(),
        bufferSize: z.number().optional().default(1000),
        dtr: z.boolean().optional().default(true),
        rts: z.boolean().optional().default(true),
        autoMonitor: z
          .boolean()
          .optional()
          .default(false)
          .describe("Open live monitor terminal + file log (default false for agents)"),
      },
      outputSchema: {
        ok: z.boolean(),
        connectionId: z.string(),
        path: z.string(),
        baudRate: z.number(),
        encoding: z.string(),
        protocol: z.string(),
        monitorLog: z.string().nullable(),
        monitorTerminal: z.boolean(),
      },
    },
    async (params) => {
      try {
        const config: SerialConfig = {
          path: params.path,
          baudRate: params.baudRate as BaudRate,
          dataBits: params.dataBits as any,
          stopBits: params.stopBits as any,
          parity: params.parity,
          flowControl: params.flowControl,
          encoding: params.encoding as Encoding,
          protocol: params.protocol as ProtocolMode,
          delimiter: params.delimiter,
          frameStart: params.frameStart,
          frameEnd: params.frameEnd,
          bufferSize: params.bufferSize,
          dtr: params.dtr,
          rts: params.rts,
        };
        const result = await manager.open(config);
        hooks.onConnectionOpen?.(result.connectionId);

        let monitorLog: string | null = null;
        let monitorTerminal = false;
        let monitorInfo = "";
        if (params.autoMonitor) {
          try {
            const { logPath } = manager.startMonitor(result.connectionId);
            monitorLog = logPath;
            const monitorScript = path.resolve(__dirname, "monitor.js");
            try {
              let child: ReturnType<typeof spawn>;
              if (IS_WIN) {
                child = spawn(
                  "cmd.exe",
                  [
                    "/c",
                    "start",
                    `"Serial Monitor - ${config.path}"`,
                    "cmd.exe",
                    "/k",
                    "node",
                    monitorScript,
                    "--tail",
                    logPath,
                  ],
                  { detached: true, stdio: "ignore", shell: true }
                );
              } else {
                child = spawn(
                  "x-terminal-emulator",
                  ["-e", `bash -c 'node "${monitorScript}" --tail "${logPath}"; exec bash'`],
                  { detached: true, stdio: "ignore" }
                );
              }
              child.unref();
              monitorProcesses.set(result.connectionId, child);
              monitorTerminal = true;
              monitorInfo = "\nMonitor terminal opened.";
            } catch (spawnErr: any) {
              monitorInfo = `\nLog at ${logPath}. Terminal failed: ${spawnErr.message}`;
            }
          } catch (e: any) {
            monitorInfo = `\n(monitor failed: ${e.message})`;
          }
        }

        const data = {
          ok: true,
          connectionId: result.connectionId,
          path: config.path,
          baudRate: config.baudRate,
          encoding: config.encoding,
          protocol: config.protocol,
          monitorLog,
          monitorTerminal,
        };
        return ok(
          data as any,
          `Connected to ${config.path}.\nConnection ID: ${result.connectionId}\nBaud ${config.baudRate} ${config.encoding}/${config.protocol}${monitorInfo}\nConfig: ${JSON.stringify(config, null, 2)}`
        );
      } catch (err: any) {
        return fail(`Error opening port: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "serial_write",
    {
      title: "Write serial",
      description: "Write data to an open connection. structuredContent has bytesWritten + hex raw.",
      inputSchema: {
        connectionId: z.string(),
        data: z.string().describe("Data to write"),
        encoding: z.string().optional().describe("Input encoding override"),
      },
      outputSchema: {
        ok: z.boolean(),
        bytesWritten: z.number(),
        raw: z.string(),
      },
    },
    async (params) => {
      try {
        const result = await manager.write(params.connectionId, params.data, params.encoding);
        const data = { ok: true, bytesWritten: result.bytesWritten, raw: result.raw };
        return ok(data as any, `Sent ${result.bytesWritten} byte(s).\nHex: ${result.raw}`);
      } catch (err: any) {
        return fail(`Error writing: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "serial_read",
    {
      title: "Read serial",
      description:
        "Read buffered messages with precise filters (direction/matchHex/matchText/lastOnly/offset). sinceLastRead only returns new messages.",
      inputSchema: {
        connectionId: z.string(),
        count: z.number().optional().describe("Max recent messages"),
        offset: z.number().optional().describe("Skip first N matching messages"),
        since: z.string().optional().describe("ISO timestamp lower bound"),
        sinceLastRead: z.boolean().optional().default(false),
        direction: z.enum(["rx", "tx", "all"]).optional().default("all"),
        matchHex: z.string().optional().describe("Keep messages whose raw hex contains this (e.g. AA55)"),
        matchText: z.string().optional().describe("Keep messages whose decoded text contains this"),
        minLength: z.number().optional(),
        maxLength: z.number().optional(),
        lastOnly: z.boolean().optional().default(false),
        hexDump: z.boolean().optional().default(false).describe("Include formatted hexDump lines in human text"),
      },
      outputSchema: {
        ok: z.boolean(),
        mode: z.string(),
        count: z.number(),
        newMessageCount: z.number().optional(),
        totalBuffered: z.number().optional(),
        lastActivity: z.string().nullable().optional(),
        dataAge: z.number().nullable().optional(),
        totalBytes: z.number(),
        messages: msgJson,
        hexDump: z.string().optional(),
      },
    },
    async (params) => {
      try {
        const filter: MessageFilter = {
          direction: params.direction,
          count: params.count,
          offset: params.offset,
          since: params.since,
          matchHex: params.matchHex,
          matchText: params.matchText,
          minLength: params.minLength,
          maxLength: params.maxLength,
          lastOnly: params.lastOnly,
        };

        if (params.sinceLastRead) {
          const result = manager.readSinceLastRead(params.connectionId);
          const messages = SerialManager.applyFilter(result.messages, filter);
          const data: Record<string, unknown> = {
            ok: true,
            mode: "sinceLastRead",
            count: messages.length,
            newMessageCount: result.newMessageCount,
            totalBuffered: result.totalBuffered,
            lastActivity: result.lastActivity,
            dataAge: result.dataAge,
            totalBytes: messages.reduce((s, m) => s + m.length, 0),
            messages: messagesBrief(messages),
          };
          if (params.hexDump) {
            data.hexDump = messages
              .map((m) => `[${m.timestamp}] ${m.direction.toUpperCase()} (${m.length}B): ${m.raw || ""}`)
              .join("\n");
          }
          const human =
            messages.length === 0
              ? `No matching new messages. totalBuffered=${result.totalBuffered} lastActivity=${result.lastActivity ?? "never"}`
              : `${messages.length} new message(s):\n${JSON.stringify(data.messages, null, 2)}`;
          return ok(data as any, human);
        }

        const messages = manager.readFiltered(params.connectionId, filter);
        const data: Record<string, unknown> = {
          ok: true,
          mode: "buffer",
          count: messages.length,
          totalBytes: messages.reduce((s, m) => s + m.length, 0),
          messages: messagesBrief(messages),
        };
        if (params.hexDump) {
          data.hexDump = manager.getHexDump(params.connectionId, params.count);
        }
        const human =
          messages.length === 0
            ? "No messages (check filters / traffic)."
            : `${messages.length} message(s):\n${JSON.stringify(data.messages, null, 2)}`;
        return ok(data as any, human);
      } catch (err: any) {
        return fail(`Error reading: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "serial_extract",
    {
      title: "Extract field",
      description:
        "Pull one value from buffered messages via a path. Examples: last.raw | messages[-1].data | rx.count | rxHex | totalBytes | messages[0].length",
      inputSchema: {
        connectionId: z.string(),
        path: z
          .string()
          .describe("Path: last.raw, last.data, messages[0].raw, rx.count, rxHex, rxText, totalBytes, first.raw, hex"),
        sinceLastRead: z.boolean().optional().default(false).describe("Only scan messages since last read cursor"),
        direction: z.enum(["rx", "tx", "all"]).optional().default("all"),
        matchHex: z.string().optional(),
        matchText: z.string().optional(),
        minLength: z.number().optional(),
        maxLength: z.number().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        path: z.string(),
        value: z.unknown(),
        matched: z.number(),
      },
    },
    async (params) => {
      try {
        const filter: MessageFilter = {
          direction: params.direction,
          matchHex: params.matchHex,
          matchText: params.matchText,
          minLength: params.minLength,
          maxLength: params.maxLength,
        };
        let pool: SerialMessage[];
        if (params.sinceLastRead) {
          pool = SerialManager.applyFilter(manager.readSinceLastRead(params.connectionId).messages, filter);
        } else {
          pool = manager.peekMessages(params.connectionId, filter);
        }
        const value = extractFromMessages(pool, params.path);
        const data = {
          ok: true,
          path: params.path,
          value: typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value,
          matched: pool.length,
        };
        return ok(data as any, JSON.stringify(data, null, 2));
      } catch (err: any) {
        return fail(`Error extracting: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "serial_wait",
    {
      title: "Wait full response",
      description:
        "Wait until the device finishes responding (silence detection). Optional filters applied to collected frames.",
      inputSchema: {
        connectionId: z.string(),
        silenceTimeout: z.number().optional().default(500),
        totalTimeout: z.number().optional().default(10000),
        direction: z.enum(["rx", "tx", "all"]).optional().default("all"),
        matchHex: z.string().optional(),
        matchText: z.string().optional(),
        lastOnly: z.boolean().optional().default(false),
        count: z.number().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        reason: z.string(),
        elapsedMs: z.number(),
        frameCount: z.number(),
        totalBytes: z.number(),
        messages: msgJson,
      },
    },
    async (params) => {
      try {
        const started = Date.now();
        const result = await manager.waitForResponse(
          params.connectionId,
          params.silenceTimeout,
          params.totalTimeout
        );
        const elapsed = Date.now() - started;
        const filtered = SerialManager.applyFilter(result.messages, {
          direction: params.direction,
          matchHex: params.matchHex,
          matchText: params.matchText,
          lastOnly: params.lastOnly,
          count: params.count,
        });
        const data = {
          ok: filtered.length > 0,
          reason: result.reason,
          elapsedMs: elapsed,
          frameCount: filtered.length,
          totalBytes: filtered.reduce((s, m) => s + m.length, 0),
          messages: messagesBrief(filtered),
        };
        if (filtered.length === 0) {
          return ok(
            data as any,
            `No data. Waited ${elapsed}ms (silence ${params.silenceTimeout}ms, total ${params.totalTimeout}ms). Reason: ${result.reason}`
          );
        }
        return ok(
          data as any,
          `Response complete! ${filtered.length} frame(s), ${data.totalBytes}B, ${elapsed}ms, reason=${result.reason}\n${JSON.stringify(data.messages, null, 2)}`
        );
      } catch (err: any) {
        return fail(`Error waiting: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "serial_wait_frame",
    {
      title: "Wait one frame",
      description: "Wait for a SINGLE frame to arrive (or timeout).",
      inputSchema: {
        connectionId: z.string(),
        timeout: z.number().optional().default(5000),
        matchHex: z.string().optional(),
        matchText: z.string().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        elapsedMs: z.number(),
        frameCount: z.number(),
        totalBytes: z.number(),
        messages: msgJson,
      },
    },
    async (params) => {
      try {
        const started = Date.now();
        const all = await manager.waitForFrame(params.connectionId, params.timeout);
        const elapsed = Date.now() - started;
        const messages = SerialManager.applyFilter(all, {
          matchHex: params.matchHex,
          matchText: params.matchText,
        });
        const data = {
          ok: messages.length > 0,
          elapsedMs: elapsed,
          frameCount: messages.length,
          totalBytes: messages.reduce((s, m) => s + m.length, 0),
          messages: messagesBrief(messages),
        };
        if (messages.length === 0) {
          return ok(data as any, `Timeout after ${elapsed}ms — no matching frame.`);
        }
        return ok(data as any, `Frame in ${elapsed}ms: ${JSON.stringify(data.messages, null, 2)}`);
      } catch (err: any) {
        return fail(`Error waiting: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "serial_start_monitor",
    {
      title: "Start serial file monitor",
      description: "Log all serial data to a file (no terminal popup).",
      inputSchema: {
        connectionId: z.string(),
        logPath: z.string().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        logPath: z.string(),
      },
    },
    async (params) => {
      try {
        const result = manager.startMonitor(params.connectionId, params.logPath);
        return ok(
          { ok: true, logPath: result.logPath } as any,
          `Monitor log: ${result.logPath}\nStop with serial_stop_monitor.`
        );
      } catch (err: any) {
        return fail(`Error: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "serial_stop_monitor",
    {
      title: "Stop serial file monitor",
      description: "Stop file logging.",
      inputSchema: { connectionId: z.string() },
      outputSchema: {
        ok: z.boolean(),
        logPath: z.string(),
        messageCount: z.number(),
        durationMs: z.number(),
      },
    },
    async (params) => {
      try {
        const result = manager.stopMonitor(params.connectionId);
        const data = {
          ok: true,
          logPath: result.logPath,
          messageCount: result.messageCount,
          durationMs: result.duration,
        };
        return ok(data as any, `Monitor stopped. ${result.messageCount} msgs → ${result.logPath}`);
      } catch (err: any) {
        return fail(`Error: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "serial_status",
    {
      title: "Serial status",
      description: "Status of one or all connections (structured JSON).",
      inputSchema: { connectionId: z.string().optional() },
      outputSchema: {
        ok: z.boolean(),
        count: z.number(),
        connections: z.array(z.record(z.string(), z.unknown())),
        connection: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (params) => {
      try {
        if (params.connectionId) {
          const info = manager.getInfo(params.connectionId);
          return ok(
            { ok: true, count: 1, connections: [info], connection: info } as any,
            JSON.stringify(info, null, 2)
          );
        }
        const all = manager.listConnections();
        const data = { ok: true, count: all.length, connections: all };
        return ok(
          data as any,
          all.length === 0
            ? "No active connections."
            : `${all.length} connection(s):\n${JSON.stringify(all, null, 2)}`
        );
      } catch (err: any) {
        return fail(`Error: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "serial_reconfigure",
    {
      title: "Reconfigure serial",
      description: "Change baud/encoding/protocol of an open connection.",
      inputSchema: {
        connectionId: z.string(),
        baudRate: z.number().optional(),
        encoding: z.string().optional(),
        protocol: z.string().optional(),
        delimiter: z.string().optional(),
        frameStart: z.string().optional(),
        frameEnd: z.string().optional(),
        bufferSize: z.number().optional(),
        dtr: z.boolean().optional(),
        rts: z.boolean().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        connectionId: z.string(),
        config: z.record(z.string(), z.unknown()),
      },
    },
    async (params) => {
      try {
        const { connectionId, ...updates } = params;
        const info = await manager.reconfigure(connectionId, updates as Partial<SerialConfig>);
        const data = {
          ok: true,
          connectionId,
          config: info.config as any,
        };
        return ok(data as any, `Reconfigured ${connectionId}.\n${JSON.stringify(info.config, null, 2)}`);
      } catch (err: any) {
        return fail(`Error reconfiguring: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "serial_close",
    {
      title: "Close serial",
      description: "Close connection and stop its monitor.",
      inputSchema: { connectionId: z.string() },
      outputSchema: {
        ok: z.boolean(),
        connectionId: z.string(),
        monitorStopped: z.boolean(),
        loggedMessages: z.number().optional(),
      },
    },
    async (params) => {
      try {
        const child = monitorProcesses.get(params.connectionId);
        if (child) {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
          monitorProcesses.delete(params.connectionId);
        }

        let monitorStopped = false;
        let loggedMessages = 0;
        let monitorInfo = "";
        if (manager.isMonitoring(params.connectionId)) {
          const result = manager.stopMonitor(params.connectionId);
          monitorStopped = true;
          loggedMessages = result.messageCount;
          monitorInfo = ` Monitor logged ${result.messageCount} → ${result.logPath}`;
        }

        await manager.close(params.connectionId);
        hooks.onConnectionClose?.(params.connectionId);
        const data = { ok: true, connectionId: params.connectionId, monitorStopped, loggedMessages };
        return ok(data as any, `Connection ${params.connectionId} closed.${monitorInfo}`);
      } catch (err: any) {
        return fail(`Error closing: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "serial_list_encodings",
    {
      title: "List encodings",
      description: "Supported encodings.",
      outputSchema: {
        encodings: z.array(z.object({ name: z.string(), description: z.string() })),
      },
    },
    async () => {
      const encs = listEncodings();
      return ok(
        { encodings: encs } as any,
        encs.map((e) => `  ${e.name.padEnd(12)} — ${e.description}`).join("\n")
      );
    }
  );

  server.registerTool(
    "serial_list_protocols",
    {
      title: "List protocols",
      description: "Supported protocol modes.",
      outputSchema: {
        protocols: z.array(z.object({ name: z.string(), description: z.string() })),
      },
    },
    async () => {
      const protos = listProtocols();
      return ok(
        { protocols: protos } as any,
        protos.map((p) => `  ${p.name.padEnd(14)} — ${p.description}`).join("\n")
      );
    }
  );

  server.registerTool(
    "serial_set_signals",
    {
      title: "Set modem signals",
      description: "Set break / DTR / RTS (programmable stimulus lines).",
      inputSchema: {
        connectionId: z.string(),
        break: z.boolean().optional(),
        dtr: z.boolean().optional(),
        rts: z.boolean().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        signals: z.record(z.string(), z.unknown()),
      },
    },
    async (params) => {
      try {
        const { connectionId, ...sig } = params;
        await manager.setSignals(connectionId, sig);
        return ok({ ok: true, signals: sig } as any, `Signals set: ${JSON.stringify(sig)}`);
      } catch (err: any) {
        return fail(`Error: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "serial_visualize",
    {
      title: "Visualize serial timeline",
      description:
        "Write a self-contained HTML timeline of TX/RX frames (open in browser).",
      inputSchema: {
        connectionId: z.string(),
        outputPath: z.string().optional().describe("Output .html path (default serial_viz_*.html)"),
        title: z.string().optional(),
        count: z.number().optional().describe("Max recent frames"),
        direction: z.enum(["rx", "tx", "all"]).optional().default("all"),
      },
      outputSchema: {
        ok: z.boolean(),
        kind: z.string(),
        htmlPath: z.string(),
        frameCount: z.number(),
      },
    },
    async (params) => {
      try {
        const filter: MessageFilter = {
          count: params.count,
          direction: params.direction ?? "all",
        };
        const messages = manager.peekMessages(params.connectionId, filter);
        const info = manager.getInfo(params.connectionId);
        const outPath =
          params.outputPath ||
          `serial_viz_${params.connectionId}_${Date.now()}.html`;
        const html = renderTimelineHtml({
          title: params.title || `Serial ${info.config.path}`,
          meta: `${info.config.path} @ ${info.config.baudRate} · ${info.config.encoding}/${info.config.protocol} · ${messages.length} msgs`,
          messages,
        });
        const htmlPath = writeHtmlReport(outPath, html);
        const data = {
          ok: true,
          kind: "timeline",
          htmlPath,
          frameCount: messages.length,
        };
        return ok(
          data as any,
          `Timeline written (${messages.length} frames):\n  ${htmlPath}\nOpen in a browser.`
        );
      } catch (err: any) {
        return fail(`Error visualizing: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "serial_visualize_smoke",
    {
      title: "Visualize DUT smoke report",
      description:
        "Write an HTML PASS/FAIL report. Pass the structured result fields from dut_smoke (or a prior smoke summary).",
      inputSchema: {
        profile: z.string(),
        steps: z.array(
          z.object({
            command: z.string(),
            title: z.string().optional().default(""),
            verdict: z.enum(["PASS", "FAIL", "REPORT", "TIMEOUT"]),
            elapsedMs: z.number().optional().default(0),
            sent: z.array(z.string()).optional().default([]),
            frames: z
              .array(
                z.object({
                  bytes: z.array(z.number()),
                  timestamp: z.string().optional(),
                })
              )
              .optional()
              .default([]),
            extras: z.array(z.number()).optional().default([]),
            failedChecks: z.array(z.string()).optional().default([]),
          })
        ),
        outputPath: z.string().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        kind: z.string(),
        htmlPath: z.string(),
        allPassed: z.boolean(),
        passed: z.number(),
        failed: z.number(),
        report: z.number(),
      },
    },
    async (params) => {
      try {
        const steps = params.steps as any[];
        const passed = steps.filter((s) => s.verdict === "PASS").length;
        const failed = steps.filter((s) => s.verdict === "FAIL" || s.verdict === "TIMEOUT").length;
        const report = steps.length - passed - failed;
        const allPassed = failed === 0 && passed > 0;
        const outPath =
          params.outputPath || `serial_smoke_${params.profile}_${Date.now()}.html`;
        const html = renderSmokeHtml({
          profile: params.profile,
          steps,
          passed,
          failed,
          report,
          allPassed,
        });
        const htmlPath = writeHtmlReport(outPath, html);
        const data = { ok: true, kind: "smoke", htmlPath, allPassed, passed, failed, report };
        return ok(data as any, `Smoke report: ${htmlPath}\nPASS ${passed} / FAIL ${failed} / REPORT ${report}`);
      } catch (err: any) {
        return fail(`Error: ${err.message}`);
      }
    }
  );

  // ──────────────────────────────────────────────
  // DUT profile-driven test tools
  // ──────────────────────────────────────────────

  server.registerTool(
    "dut_list_profiles",
    {
      title: "List DUT profiles",
      description: "List FT test profiles + command tables (entry point).",
      outputSchema: {
        count: z.number(),
        profiles: z.array(
          z.object({
            name: z.string(),
            chip: z.string(),
            description: z.string(),
            smoke: z.array(z.string()),
            serial: z.record(z.string(), z.unknown()),
            commands: z.array(
              z.object({
                name: z.string(),
                title: z.string(),
                fpgaSuitable: z.boolean().optional(),
              })
            ),
          })
        ),
      },
    },
    async () => {
      const ps = listProfiles();
      const data = {
        count: ps.length,
        profiles: ps.map((p) => ({
          name: p.name,
          chip: p.chip,
          description: p.description,
          smoke: p.smoke ?? [],
          serial: p.serial as any,
          commands: p.commands.map((c) => ({
            name: c.name,
            title: c.title,
            fpgaSuitable: c.fpgaSuitable,
          })),
        })),
      };
      const text = ps
        .map(
          (p) =>
            `## ${p.name} — ${p.chip}\n${p.description}\n冒烟: ${(p.smoke ?? []).join(" → ") || "(无)"}\n${p.commands
              .map((c) => `  ${c.name.padEnd(22)} ${c.fpgaSuitable ? "[FPGA✓]" : "[FPGA✗]"} ${c.title}`)
              .join("\n")}`
        )
        .join("\n\n");
      return ok(data as any, text);
    }
  );

  server.registerTool(
    "dut_connect",
    {
      title: "Connect DUT",
      description:
        "Open port + attach profile session (framing/checksum/handshake). Returns connectionId. autoMonitor default false.",
      inputSchema: {
        path: z.string(),
        profile: z.string(),
        baudRate: z.number().optional(),
        autoMonitor: z.boolean().optional().default(false),
      },
      outputSchema: {
        ok: z.boolean(),
        connectionId: z.string(),
        path: z.string(),
        baudRate: z.number(),
        profile: z.string(),
        chip: z.string(),
        wiring: z.string().optional(),
        monitorLog: z.string().nullable(),
      },
    },
    async (params) => {
      try {
        const { getProfile } = await import("./dut/profiles/index.js");
        const profile = getProfile(params.profile);
        const config: SerialConfig = {
          path: params.path,
          baudRate: (params.baudRate ?? profile.serial.baudRate) as BaudRate,
          dataBits: (profile.serial.dataBits ?? 8) as any,
          stopBits: (profile.serial.stopBits ?? 1) as any,
          parity: (profile.serial.parity ?? "none") as any,
          flowControl: "none",
          encoding: "hex" as Encoding,
          protocol: "raw" as ProtocolMode,
          bufferSize: 4000,
          autoReconnect: false,
          dtr: true,
          rts: true,
        };
        const open = await manager.open(config);
        hooks.onConnectionOpen?.(open.connectionId);

        let monitorLog: string | null = null;
        if (params.autoMonitor) {
          try {
            const { logPath } = manager.startMonitor(open.connectionId);
            monitorLog = logPath;
          } catch {
            /* ignore */
          }
        }

        dut.attach(open.connectionId, params.profile);
        const data = {
          ok: true,
          connectionId: open.connectionId,
          path: params.path,
          baudRate: config.baudRate,
          profile: params.profile,
          chip: profile.chip,
          wiring: profile.serial.wiring,
          monitorLog,
        };
        return ok(
          data as any,
          `DUT connected: ${params.path} @ ${config.baudRate} 8N1, profile=${params.profile}\nConnection ID: ${open.connectionId}\n接线: ${profile.serial.wiring ?? "见profile"}${monitorLog ? `\nMonitor: ${monitorLog}` : ""}\n下一步: dut_test / dut_cmd / dut_smoke`
        );
      } catch (err: any) {
        return fail(`Error: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "dut_disconnect",
    {
      title: "Disconnect DUT",
      description: "Detach DUT session and close port.",
      inputSchema: { connectionId: z.string() },
      outputSchema: {
        ok: z.boolean(),
        connectionId: z.string(),
      },
    },
    async (params) => {
      try {
        if (dut.hasSession(params.connectionId)) dut.detach(params.connectionId);
        await manager.close(params.connectionId);
        hooks.onConnectionClose?.(params.connectionId);
        return ok(
          { ok: true, connectionId: params.connectionId } as any,
          `Connection ${params.connectionId} closed.`
        );
      } catch (err: any) {
        return fail(`Error: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "dut_test",
    {
      title: "Run DUT test",
      description:
        "Run one named test with auto PASS/FAIL. structuredContent.verdict is machine-readable; format=human adds prose.",
      inputSchema: {
        connectionId: z.string(),
        name: z.string(),
        cmd: hexNum.optional(),
        p1: hexNum.optional(),
        p2: hexNum.optional(),
        format: z.enum(["structured", "human"]).optional().default("structured"),
      },
      outputSchema: {
        ok: z.boolean(),
        command: z.string(),
        title: z.string(),
        verdict: z.enum(["PASS", "FAIL", "REPORT", "TIMEOUT"]),
        elapsedMs: z.number(),
        sent: z.array(z.string()),
        frames: z.array(
          z.object({
            bytes: z.array(z.number()),
            timestamp: z.string(),
          })
        ),
        extras: z.array(z.number()),
        failedChecks: z.array(z.string()),
        note: z.string().optional(),
      },
    },
    async (params) => {
      try {
        const r = await dut.runCommand(params.connectionId, params.name, {
          cmd: params.cmd,
          p1: params.p1,
          p2: params.p2,
        });
        const human =
          params.format === "human" ? formatRun(r) : JSON.stringify(r, null, 2);
        return {
          content: [{ type: "text" as const, text: human }],
          structuredContent: { ...r, ok: r.verdict === "PASS" || r.verdict === "REPORT" } as any,
          isError: r.verdict === "FAIL" || r.verdict === "TIMEOUT",
        };
      } catch (err: any) {
        return fail(`Error: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "dut_extract",
    {
      title: "Extract DUT field",
      description:
        "Run a named test (or raw-like command) then extract one field via path: verdict | command | elapsedMs | frames.length | frames[1].bytes[2] | sent.0 | failedChecks.0",
      inputSchema: {
        connectionId: z.string(),
        name: z.string(),
        cmd: hexNum.optional(),
        p1: hexNum.optional(),
        p2: hexNum.optional(),
        path: z.string().describe("e.g. verdict, frames[-1].bytes[1], elapsedMs"),
      },
      outputSchema: {
        ok: z.boolean(),
        path: z.string(),
        value: z.unknown(),
        command: z.string(),
        verdict: z.string(),
      },
    },
    async (params) => {
      try {
        const r = await dut.runCommand(params.connectionId, params.name, {
          cmd: params.cmd,
          p1: params.p1,
          p2: params.p2,
        });
        const value = extractFromObject(r as any, params.path);
        const data = {
          ok: true,
          path: params.path,
          value: typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value,
          command: r.command,
          verdict: r.verdict,
        };
        return ok(data as any, JSON.stringify(data, null, 2));
      } catch (err: any) {
        return fail(`Error: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "dut_cmd",
    {
      title: "Raw DUT command",
      description:
        "Send framed command (echo handshake + result). structuredContent.frames is byte arrays.",
      inputSchema: {
        connectionId: z.string(),
        cmd: hexNum,
        p1: hexNum.optional().default(0),
        p2: hexNum.optional().default(0),
        expectFrames: z.number().int().min(0).max(8).optional().default(1),
        timeoutMs: z.number().optional().default(3000),
      },
      outputSchema: {
        ok: z.boolean(),
        timedOut: z.boolean(),
        sent: z.array(z.string()),
        frames: z.array(z.object({ bytes: z.array(z.number()), timestamp: z.string() })),
        extras: z.array(z.number()),
        elapsedMs: z.number(),
      },
    },
    async (params) => {
      try {
        const session = dut.getSession(params.connectionId);
        const started = Date.now();
        const sent: string[] = [];
        session.reset();
        sent.push(await session.sendFrame(params.cmd, params.p1, params.p2));
        const echoGot = await session.waitForFrames(1, Math.min(params.timeoutMs, 1500));
        let timedOut = echoGot === 0;
        if (params.expectFrames > 0) {
          sent.push(await session.sendFrame(params.cmd, params.p1, params.p2));
          const got = await session.waitForFrames(params.expectFrames, params.timeoutMs);
          if (got < params.expectFrames) timedOut = true;
        }
        const { frames, extras } = session.snapshot();
        const data = {
          ok: !timedOut,
          timedOut,
          sent,
          frames,
          extras,
          elapsedMs: Date.now() - started,
        };
        const human = [
          `发送: ${sent.join(" ")}`,
          frames.length
            ? `回帧: ${frames.map((f) => f.bytes.map(hex).join(" ")).join("  |  ")}`
            : `回帧: (无)${timedOut ? ` — 超时 ${params.timeoutMs}ms` : ""}`,
          extras.length ? `额外字节: ${extras.map(hex).join(" ")}` : "",
          `耗时: ${data.elapsedMs}ms`,
        ]
          .filter(Boolean)
          .join("\n");
        return { content: [{ type: "text" as const, text: human }], structuredContent: data as any, isError: timedOut };
      } catch (err: any) {
        return fail(`Error: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "dut_smoke",
    {
      title: "DUT smoke test",
      description:
        "Run profile smoke sequence. structuredContent has steps[] with full frame data (for serial_visualize_smoke).",
      inputSchema: {
        connectionId: z.string(),
        includeLowPower: z.boolean().optional().default(false),
        format: z.enum(["structured", "human"]).optional().default("structured"),
      },
      outputSchema: {
        ok: z.boolean(),
        profile: z.string(),
        passed: z.number(),
        failed: z.number(),
        report: z.number(),
        allPassed: z.boolean(),
        steps: z.array(
          z.object({
            command: z.string(),
            title: z.string(),
            verdict: z.enum(["PASS", "FAIL", "REPORT", "TIMEOUT"]),
            elapsedMs: z.number(),
            sent: z.array(z.string()),
            frames: z.array(
              z.object({
                bytes: z.array(z.number()),
                timestamp: z.string(),
              })
            ),
            extras: z.array(z.number()),
            failedChecks: z.array(z.string()),
          })
        ),
      },
    },
    async (params) => {
      try {
        const result = await dut.runSmoke(params.connectionId, params.includeLowPower);
        const data = { ...result, ok: result.allPassed };
        let human: string;
        if (params.format === "human") {
          const lines: string[] = [`=== DUT smoke (${result.profile}) ===`];
          for (const s of result.steps) {
            const mark =
              s.verdict === "PASS" ? "✓" : s.verdict === "FAIL" ? "✗" : s.verdict === "TIMEOUT" ? "⏱" : "○";
            lines.push(
              `${mark} ${s.command.padEnd(20)} ${s.verdict}  ${s.failedChecks.length ? "— " + s.failedChecks.join("; ") : ""}`
            );
          }
          lines.push(
            `总计: PASS ${result.passed} / FAIL+TIMEOUT ${result.failed} / REPORT ${result.report} → ${result.allPassed ? "通过" : "失败"}`
          );
          human = lines.join("\n");
        } else {
          human = JSON.stringify(data, null, 2);
        }
        return {
          content: [{ type: "text" as const, text: human }],
          structuredContent: data as any,
          isError: !result.allPassed,
        };
      } catch (err: any) {
        return fail(`Error: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "dut_status",
    {
      title: "DUT status",
      description: "Session stats: frames parsed/sent, noise, last frames.",
      inputSchema: { connectionId: z.string() },
      outputSchema: {
        ok: z.boolean(),
        connectionId: z.string(),
        profile: z.string(),
        chip: z.string(),
        status: z.string(),
        path: z.string(),
        baudRate: z.number(),
        stats: z.object({
          framesParsed: z.number(),
          framesSent: z.number(),
          rawBytesSent: z.number(),
          noiseBytes: z.number(),
        }),
        lastFrames: z.array(z.array(z.number())),
        extrasTail: z.array(z.number()),
      },
    },
    async (params) => {
      try {
        const session = dut.getSession(params.connectionId);
        const info = manager.getInfo(params.connectionId);
        const snap = session.snapshot();
        const data = {
          ok: true,
          connectionId: params.connectionId,
          profile: session.profile.name,
          chip: session.profile.chip,
          status: info.status,
          path: info.config.path,
          baudRate: info.config.baudRate,
          stats: session.stats,
          lastFrames: snap.frames.slice(-5).map((f) => f.bytes),
          extrasTail: snap.extras.slice(-16),
        };
        const text = [
          `Connection: ${params.connectionId} (${info.config.path} @ ${info.config.baudRate}, ${info.status})`,
          `Profile: ${session.profile.name} — ${session.profile.chip}`,
          `Stats: framesParsed=${session.stats.framesParsed} framesSent=${session.stats.framesSent} noiseBytes=${session.stats.noiseBytes}`,
          `最近回帧: ${data.lastFrames.map((b) => b.map(hex).join(" ")).join("  |  ") || "(无)"}`,
        ].join("\n");
        return ok(data as any, text);
      } catch (err: any) {
        return fail(`Error: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "dut_send_raw",
    {
      title: "DUT send raw",
      description: "Send raw hex bytes without framing.",
      inputSchema: {
        connectionId: z.string(),
        hexData: z.string(),
      },
      outputSchema: {
        ok: z.boolean(),
        sent: z.string(),
      },
    },
    async (params) => {
      try {
        const session = dut.getSession(params.connectionId);
        const sent = await session.sendRaw(params.hexData);
        return ok({ ok: true, sent } as any, `Sent raw: ${sent}`);
      } catch (err: any) {
        return fail(`Error: ${err.message}`);
      }
    }
  );

  return server;
}
