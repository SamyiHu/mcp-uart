import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import { SerialManager } from "./serial-manager.js";
import { listEncodings } from "./encodings.js";
import { listProtocols } from "./protocols.js";
import type { SerialConfig, BaudRate, Encoding, ProtocolMode } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IS_WIN = process.platform === "win32";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-uart",
    version: "1.0.0",
  });

  const manager = new SerialManager();
  const monitorProcesses = new Map<string, ReturnType<typeof spawn>>();

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

  // ──────────────────────────────────────────────
  // Tools
  // ──────────────────────────────────────────────

  // --- serial_list_ports ---
  server.tool(
    "serial_list_ports",
    "List all available serial ports on the system. Returns port path, manufacturer, serial number, and USB IDs.",
    {},
    async () => {
      try {
        const ports = await manager.listPorts();
        return {
          content: [
            {
              type: "text" as const,
              text: ports.length === 0
                ? "No serial ports found. Ensure devices are connected."
                : `Found ${ports.length} port(s):\n\n${JSON.stringify(ports, null, 2)}`,
            },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error listing ports: ${err.message}` }], isError: true };
      }
    }
  );

  // --- serial_open ---
  server.tool(
    "serial_open",
    "Open a serial port connection with full configuration. Returns a connection ID for subsequent operations.",
    {
      path: z.string().describe("Serial port path, e.g. COM3, /dev/ttyUSB0"),
      baudRate: z.number().optional().default(115200).describe("Baud rate: 110-921600"),
      dataBits: z.number().optional().default(8).describe("Data bits: 5, 6, 7, or 8"),
      stopBits: z.number().optional().default(1).describe("Stop bits: 1, 1.5, or 2"),
      parity: z.enum(["none", "odd", "even", "mark", "space"]).optional().default("none").describe("Parity mode"),
      flowControl: z.enum(["none", "hardware", "software"]).optional().default("none").describe("Flow control method"),
      encoding: z.string().optional().default("utf8").describe("Character encoding: utf8, ascii, latin1, gbk, gb2312, gb18030, big5, shift_jis, euc-kr, hex, base64, binary"),
      protocol: z.string().optional().default("line").describe("Protocol mode: raw, line, delimiter, modbus-rtu, hex-frame, slip"),
      delimiter: z.string().optional().describe("Custom delimiter as hex string (e.g. '0D0A'), used with 'delimiter' protocol"),
      frameStart: z.string().optional().describe("Start marker hex string for hex-frame protocol"),
      frameEnd: z.string().optional().describe("End marker hex string for hex-frame protocol"),
      bufferSize: z.number().optional().default(1000).describe("Max messages to buffer in memory"),
      dtr: z.boolean().optional().default(true).describe("DTR signal state"),
      rts: z.boolean().optional().default(true).describe("RTS signal state"),
      autoMonitor: z.boolean().optional().default(true).describe("Auto-open a monitor terminal window to see serial data in real-time"),
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

        let monitorInfo = "";
        if (params.autoMonitor) {
          try {
            // Start file logging first
            const { logPath } = manager.startMonitor(result.connectionId);

            // Then spawn a monitor terminal in --tail mode (reads log file, no port conflict)
            const monitorScript = path.resolve(__dirname, "monitor.js");
            try {
              let child: ReturnType<typeof spawn>;
              if (IS_WIN) {
                child = spawn("cmd.exe", ["/c", "start", `"Serial Monitor - ${config.path}"`, "cmd.exe", "/k", "node", monitorScript, "--tail", logPath], {
                  detached: true,
                  stdio: "ignore",
                  shell: true,
                });
              } else {
                child = spawn("x-terminal-emulator", ["-e", `bash -c 'node "${monitorScript}" --tail "${logPath}"; exec bash'`], {
                  detached: true,
                  stdio: "ignore",
                });
              }
              child.unref();
              monitorProcesses.set(result.connectionId, child);
              monitorInfo = "\nMonitor terminal opened — showing serial data in real-time.";
            } catch (spawnErr: any) {
              monitorInfo = `\nAuto-monitor log started at:\n  ${logPath}\n(Could not open terminal: ${spawnErr.message}. Run manually: serial-monitor --tail "${logPath}")`;
            }
          } catch (e: any) {
            monitorInfo = `\n(Could not start auto-monitor: ${e.message})`;
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Connected to ${config.path}.\nConnection ID: ${result.connectionId}${monitorInfo}\nConfig: ${JSON.stringify(config, null, 2)}`,
            },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error opening port: ${err.message}` }], isError: true };
      }
    }
  );

  // --- serial_write ---
  server.tool(
    "serial_write",
    "Write data to an open serial connection. Supports text, hex, or base64 input.",
    {
      connectionId: z.string().describe("Connection ID returned by serial_open"),
      data: z.string().describe("Data to write"),
      encoding: z.string().optional().describe("Input encoding override (default: connection encoding)"),
    },
    async (params) => {
      try {
        const result = await manager.write(params.connectionId, params.data, params.encoding);
        return {
          content: [
            {
              type: "text" as const,
              text: `Sent ${result.bytesWritten} byte(s).\nHex: ${result.raw}`,
            },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error writing: ${err.message}` }], isError: true };
      }
    }
  );

  // --- serial_read ---
  server.tool(
    "serial_read",
    "Read received messages from a serial connection. Returns decoded data and hex dump. Use sinceLastRead=true to only get new messages since your last read, with timing metadata.",
    {
      connectionId: z.string().describe("Connection ID returned by serial_open"),
      count: z.number().optional().describe("Max number of recent messages to return (default: all buffered)"),
      since: z.string().optional().describe("ISO timestamp — only return messages after this time"),
      sinceLastRead: z.boolean().optional().default(false).describe("Only return messages since the last read, with timing metadata"),
      hexDump: z.boolean().optional().default(false).describe("Also return raw hex dump of messages"),
    },
    async (params) => {
      try {
        if (params.sinceLastRead) {
          const result = manager.readSinceLastRead(params.connectionId);
          if (result.messages.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: `No new messages since last read.\nLast activity: ${result.lastActivity ?? "never"}\nData age: ${result.dataAge !== null ? result.dataAge + "ms" : "N/A"}\nTotal buffered: ${result.totalBuffered}`,
              }],
            };
          }

          let text = `${result.newMessageCount} new message(s) since last read:\n\n${JSON.stringify(result.messages, null, 2)}`;
          text += `\n\nTiming:\n  Last activity: ${result.lastActivity}\n  Data age: ${result.dataAge}ms\n  Total buffered: ${result.totalBuffered}`;

          if (params.hexDump) {
            text += `\n\nHex Dump:\n${result.messages.map((m) => `[${m.timestamp}] ${m.direction.toUpperCase()} (${m.length}B): ${m.raw || ""}`).join("\n")}`;
          }

          return { content: [{ type: "text" as const, text }] };
        }

        const messages = manager.read(params.connectionId, params.count, params.since);
        if (messages.length === 0) {
          return { content: [{ type: "text" as const, text: "No messages received yet." }] };
        }

        let text = `${messages.length} message(s):\n\n${JSON.stringify(messages, null, 2)}`;

        if (params.hexDump) {
          text += `\n\nHex Dump:\n${manager.getHexDump(params.connectionId, params.count)}`;
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error reading: ${err.message}` }], isError: true };
      }
    }
  );

  // --- serial_wait ---
  server.tool(
    "serial_wait",
    "Wait for a COMPLETE response from the device. Collects all data frames until silence (no new data for a period) or total timeout. Use after sending a command — it waits until the device finishes replying.",
    {
      connectionId: z.string().describe("Connection ID returned by serial_open"),
      silenceTimeout: z.number().optional().default(500).describe("Silence timeout in ms — if no new data for this long, consider response complete (default: 500)"),
      totalTimeout: z.number().optional().default(10000).describe("Total timeout in ms — hard limit, return everything collected so far (default: 10000)"),
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

        if (result.messages.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `No data received. Waited ${elapsed}ms (silence: ${params.silenceTimeout}ms, total: ${params.totalTimeout}ms).\nReason: ${result.reason} — device did not respond.`,
            }],
          };
        }

        const totalBytes = result.messages.reduce((s, m) => s + m.length, 0);
        const reasonText = result.reason === "silence"
          ? `silence detected (${params.silenceTimeout}ms gap)`
          : `total timeout (${params.totalTimeout}ms)`;

        let text = `Response complete! ${result.messages.length} frame(s), ${totalBytes} byte(s), ${elapsed}ms elapsed.\nEnd reason: ${reasonText}\n\n${JSON.stringify(result.messages, null, 2)}`;
        text += `\n\nTiming:\n  First frame: ${result.messages[0].timestamp}\n  Last frame: ${result.messages[result.messages.length - 1].timestamp}\n  Duration: ${elapsed}ms`;

        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error waiting: ${err.message}` }], isError: true };
      }
    }
  );

  // --- serial_wait_frame ---
  server.tool(
    "serial_wait_frame",
    "Wait for a SINGLE data frame to arrive. Returns as soon as one frame is received, or after timeout. Use when you expect exactly one response.",
    {
      connectionId: z.string().describe("Connection ID returned by serial_open"),
      timeout: z.number().optional().default(5000).describe("Max wait time in milliseconds (default: 5000)"),
    },
    async (params) => {
      try {
        const started = Date.now();
        const messages = await manager.waitForFrame(params.connectionId, params.timeout);
        const elapsed = Date.now() - started;

        if (messages.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `Timeout after ${elapsed}ms — no frame received. Device may not be sending anything.`,
            }],
          };
        }

        const totalBytes = messages.reduce((s, m) => s + m.length, 0);
        let text = `Frame received! ${messages.length} message(s), ${totalBytes} byte(s), waited ${elapsed}ms:\n\n${JSON.stringify(messages, null, 2)}`;
        text += `\n\nTiming:\n  Arrived at: ${messages[0].timestamp}\n  Waited: ${elapsed}ms`;

        return { content: [{ type: "text" as const, text }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error waiting: ${err.message}` }], isError: true };
      }
    }
  );

  // --- serial_start_monitor ---
  server.tool(
    "serial_start_monitor",
    "Start logging all serial data to a file in real-time. Use 'tail -f <logPath>' in another terminal to watch data live, like a serial assistant.",
    {
      connectionId: z.string().describe("Connection ID returned by serial_open"),
      logPath: z.string().optional().describe("Log file path (default: auto-generated in current directory)"),
    },
    async (params) => {
      try {
        const result = manager.startMonitor(params.connectionId, params.logPath);
        return {
          content: [{
            type: "text" as const,
            text: `Monitor started! All serial data will be logged to:\n  ${result.logPath}\n\nTo watch live, run in another terminal:\n  tail -f "${result.logPath}"\n\nStop with serial_stop_monitor.`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- serial_stop_monitor ---
  server.tool(
    "serial_stop_monitor",
    "Stop logging serial data to file.",
    {
      connectionId: z.string().describe("Connection ID"),
    },
    async (params) => {
      try {
        const result = manager.stopMonitor(params.connectionId);
        return {
          content: [{
            type: "text" as const,
            text: `Monitor stopped.\n  Log file: ${result.logPath}\n  Messages logged: ${result.messageCount}\n  Duration: ${Math.round(result.duration / 1000)}s`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- serial_status ---
  server.tool(
    "serial_status",
    "Get status of all active serial connections, or a specific connection.",
    {
      connectionId: z.string().optional().describe("Specific connection ID (omit for all)"),
    },
    async (params) => {
      try {
        if (params.connectionId) {
          const info = manager.getInfo(params.connectionId);
          return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] };
        }
        const all = manager.listConnections();
        return {
          content: [
            {
              type: "text" as const,
              text: all.length === 0
                ? "No active connections."
                : `${all.length} connection(s):\n\n${JSON.stringify(all, null, 2)}`,
            },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- serial_reconfigure ---
  server.tool(
    "serial_reconfigure",
    "Reconfigure an active serial connection (change baud rate, encoding, protocol, etc.)",
    {
      connectionId: z.string().describe("Connection ID to reconfigure"),
      baudRate: z.number().optional().describe("New baud rate"),
      encoding: z.string().optional().describe("New encoding"),
      protocol: z.string().optional().describe("New protocol mode"),
      delimiter: z.string().optional().describe("New delimiter hex"),
      frameStart: z.string().optional().describe("New frame start hex"),
      frameEnd: z.string().optional().describe("New frame end hex"),
      bufferSize: z.number().optional().describe("New buffer size"),
      dtr: z.boolean().optional().describe("New DTR state"),
      rts: z.boolean().optional().describe("New RTS state"),
    },
    async (params) => {
      try {
        const { connectionId, ...updates } = params;
        const info = await manager.reconfigure(connectionId, updates as Partial<SerialConfig>);
        return {
          content: [
            {
              type: "text" as const,
              text: `Reconfigured ${connectionId}.\nCurrent config:\n${JSON.stringify(info, null, 2)}`,
            },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error reconfiguring: ${err.message}` }], isError: true };
      }
    }
  );

  // --- serial_close ---
  server.tool(
    "serial_close",
    "Close a serial port connection and stop its monitor.",
    {
      connectionId: z.string().describe("Connection ID to close"),
    },
    async (params) => {
      try {
        // Kill monitor terminal if running
        const child = monitorProcesses.get(params.connectionId);
        if (child) {
          try { child.kill(); } catch {}
          monitorProcesses.delete(params.connectionId);
        }

        // Stop file monitor if running
        let monitorInfo = "";
        if (manager.isMonitoring(params.connectionId)) {
          const result = manager.stopMonitor(params.connectionId);
          monitorInfo = `\nMonitor stopped. ${result.messageCount} messages logged to ${result.logPath}`;
        }

        await manager.close(params.connectionId);
        return { content: [{ type: "text" as const, text: `Connection ${params.connectionId} closed.${monitorInfo}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error closing: ${err.message}` }], isError: true };
      }
    }
  );

  // --- serial_list_encodings ---
  server.tool(
    "serial_list_encodings",
    "List all supported character encodings with descriptions.",
    {},
    async () => {
      const encs = listEncodings();
      return {
        content: [
          {
            type: "text" as const,
            text: `Supported encodings:\n\n${encs.map((e) => `  ${e.name.padEnd(12)} — ${e.description}`).join("\n")}`,
          },
        ],
      };
    }
  );

  // --- serial_list_protocols ---
  server.tool(
    "serial_list_protocols",
    "List all supported protocol modes with descriptions.",
    {},
    async () => {
      const protos = listProtocols();
      return {
        content: [
          {
            type: "text" as const,
            text: `Supported protocols:\n\n${protos.map((p) => `  ${p.name.padEnd(14)} — ${p.description}`).join("\n")}`,
          },
        ],
      };
    }
  );

  return server;
}
