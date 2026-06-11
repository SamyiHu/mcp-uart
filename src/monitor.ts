#!/usr/bin/env node

/**
 * Serial Monitor — real-time serial port viewer with interactive controls.
 *
 * Modes:
 *   serial-monitor <port> [baudRate] [encoding] [protocol]
 *   serial-monitor --tail <logFile>
 *
 * Commands (type + Enter):
 *   t         Text view (decoded data only)
 *   h         Hex view (raw hex only)
 *   m         Mixed view (text + hex, default)
 *   p         Pause / Resume
 *   s         Show statistics
 *   c         Clear screen
 *   q         Quit
 *   Ctrl+C    Quit
 */

import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import * as fs from "fs";
import * as readline from "readline";
import { decode } from "./encodings.js";
import type { Encoding } from "./types.js";

// ── Colors ──

const C = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
  magenta: "\x1b[35m",
};

// ── View mode ──

type ViewMode = "text" | "hex" | "mixed";

// ── Stats ──

class Stats {
  rxBytes = 0;
  txBytes = 0;
  rxFrames = 0;
  txFrames = 0;
  startTime = Date.now();

  get duration(): string {
    const s = Math.floor((Date.now() - this.startTime) / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m${sec}s` : `${sec}s`;
  }

  get summary(): string {
    return `${C.cyan}RX:${this.rxFrames}f/${this.formatBytes(this.rxBytes)}${C.reset}  ${C.green}TX:${this.txFrames}f/${this.formatBytes(this.txBytes)}${C.reset}  ${C.yellow}Total:${this.formatBytes(this.rxBytes + this.txBytes)}${C.reset}  ${C.dim}${this.duration}${C.reset}`;
  }

  private formatBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    return `${(n / 1024).toFixed(1)}KB`;
  }

  feed(line: string) {
    const isRx = line.includes("RX");
    const match = line.match(/\((\d+)B\)/);
    const bytes = match ? parseInt(match[1], 10) : 0;
    if (isRx) {
      this.rxFrames++;
      this.rxBytes += bytes;
    } else {
      this.txFrames++;
      this.txBytes += bytes;
    }
  }
}

// ── Utility ──

function parseLogLine(line: string): { dir: "rx" | "tx"; text: string; hex: string; bytes: number; ts: string } | null {
  const rxMatch = line.match(/\[([^\]]+)\]\s+RX\s+\((\d+)B\):\s*(.*?)(?:\s*\|\s*HEX:\s*(.*))?$/);
  if (rxMatch) {
    return { dir: "rx", ts: rxMatch[1], bytes: parseInt(rxMatch[2], 10), text: rxMatch[3] || "", hex: rxMatch[4] || "" };
  }
  const txMatch = line.match(/\[([^\]]+)\]\s+TX\s+\((\d+)B\):\s*(.*?)(?:\s*\|\s*HEX:\s*(.*))?$/);
  if (txMatch) {
    return { dir: "tx", ts: txMatch[1], bytes: parseInt(txMatch[2], 10), text: txMatch[3] || "", hex: txMatch[4] || "" };
  }
  return null;
}

function displayFrame(parsed: { dir: "rx" | "tx"; text: string; hex: string; bytes: number; ts: string }, view: ViewMode) {
  const color = parsed.dir === "rx" ? C.cyan : C.green;
  const arrow = parsed.dir === "rx" ? "RX ▶" : "TX ◀";

  const localTs = (() => {
    try {
      const d = new Date(parsed.ts);
      return d.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return parsed.ts;
    }
  })();

  const prefix = `${C.dim}${localTs}${C.reset} ${color}${arrow}${C.reset} ${C.dim}(${parsed.bytes}B)${C.reset}`;
  const indent = "              ";

  const text = parsed.text.replace(/\\r/g, "\r").replace(/\\n/g, "\n");
  const lines = text.split("\n");

  if (view === "text") {
    console.log(`${prefix} ${lines[0]}`);
    for (let i = 1; i < lines.length; i++) {
      console.log(`${indent}${lines[i]}`);
    }
  } else if (view === "hex") {
    const spaced = (parsed.hex || "").replace(/(.{2})/g, "$1 ").trim();
    console.log(`${prefix} ${C.magenta}${spaced}${C.reset}`);
  } else {
    console.log(`${prefix} ${lines[0]}`);
    for (let i = 1; i < lines.length; i++) {
      console.log(`${indent}${lines[i]}`);
    }
    if (parsed.hex) {
      const spaced = parsed.hex.replace(/(.{2})/g, "$1 ").trim();
      console.log(`${C.dim}${indent}HEX: ${spaced}${C.reset}`);
    }
  }
}

function drawHelpBar() {
  console.log(`${C.bgBlue}${C.white}${C.bold} t=Text  h=Hex  m=Mixed  p=Pause  s=Stats  c=Clear  q=Quit ${C.reset}`);
}

// ── Command handler (shared) ──

function handleCommand(cmd: string, ctx: { viewMode: ViewMode; paused: boolean; stats: Stats }, onUpdate: (view: ViewMode, paused: boolean) => void): boolean {
  const c = cmd.trim().toLowerCase();
  let { viewMode, paused } = ctx;

  if (c === "q") {
    console.log(`${C.yellow}── Session Summary ──${C.reset}`);
    console.log(ctx.stats.summary);
    return true; // signal quit
  }
  if (c === "t") {
    viewMode = "text";
    console.log(`${C.yellow}ℹ View: text${C.reset}`);
  } else if (c === "h") {
    viewMode = "hex";
    console.log(`${C.yellow}ℹ View: hex${C.reset}`);
  } else if (c === "m") {
    viewMode = "mixed";
    console.log(`${C.yellow}ℹ View: mixed${C.reset}`);
  } else if (c === "p") {
    paused = !paused;
    console.log(paused
      ? `${C.red}⏸ PAUSED (p + Enter to resume)${C.reset}`
      : `${C.green}▶ Resumed${C.reset}`);
  } else if (c === "s") {
    console.log(ctx.stats.summary);
  } else if (c === "c") {
    console.clear();
    drawHelpBar();
  }

  onUpdate(viewMode, paused);
  return false;
}

// ── Tail mode ──

function runTail(logPath: string) {
  if (!fs.existsSync(logPath)) {
    console.log(`${C.red}✖ Log file not found: ${logPath}${C.reset}`);
    console.log(`${C.yellow}ℹ Waiting for file to appear...${C.reset}`);

    const waitInterval = setInterval(() => {
      if (fs.existsSync(logPath)) {
        clearInterval(waitInterval);
        startTailing(logPath);
      }
    }, 500);

    process.on("SIGINT", () => {
      clearInterval(waitInterval);
      process.exit(0);
    });
    return;
  }

  startTailing(logPath);
}

function startTailing(logPath: string) {
  console.log(`${C.bold}${C.yellow}══════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold} Serial Monitor${C.reset} ${C.dim}— tailing ${logPath}${C.reset}`);
  drawHelpBar();
  console.log(`${C.bold}${C.yellow}══════════════════════════════════════════════════════════${C.reset}`);

  const stats = new Stats();
  let viewMode: ViewMode = "mixed";
  let paused = false;

  // Command input via readline — type command + Enter
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line: string) => {
    const quit = handleCommand(line, { viewMode, paused, stats }, (v, p) => {
      viewMode = v;
      paused = p;
    });
    if (quit) {
      fs.unwatchFile(logPath);
      rl.close();
      process.exit(0);
    }
  });

  // Read existing content
  let lastSize = 0;
  const existing = fs.readFileSync(logPath, "utf8");
  if (existing) {
    for (const line of existing.split("\n")) {
      if (line.trim()) {
        const parsed = parseLogLine(line);
        if (parsed) {
          stats.feed(line);
          displayFrame(parsed, viewMode);
        } else {
          console.log(`${C.dim}${line}${C.reset}`);
        }
      }
    }
    lastSize = Buffer.byteLength(existing, "utf8");
  }

  // Watch for changes
  fs.watchFile(logPath, { interval: 50 }, (curr) => {
    if (curr.size > lastSize) {
      try {
        const fd = fs.openSync(logPath, "r");
        const buf = Buffer.alloc(curr.size - lastSize);
        fs.readSync(fd, buf, 0, buf.length, lastSize);
        fs.closeSync(fd);

        const newContent = buf.toString("utf8");
        for (const line of newContent.split("\n")) {
          if (!line.trim()) continue;
          if (paused) continue;

          const parsed = parseLogLine(line);
          if (parsed) {
            stats.feed(line);
            displayFrame(parsed, viewMode);
          } else {
            console.log(`${C.dim}${line}${C.reset}`);
          }
        }
        lastSize = curr.size;
      } catch {}
    }
  });

  process.on("SIGINT", () => {
    console.log(`\n${C.yellow}── Session Summary ──${C.reset}`);
    console.log(stats.summary);
    fs.unwatchFile(logPath);
    rl.close();
    process.exit(0);
  });
}

// ── Direct port mode ──

function runDirect(portPath: string, baudRate: number, encoding: Encoding, protocol: string) {
  console.log(`${C.yellow}ℹ Opening ${portPath} @ ${baudRate} baud, encoding=${encoding}, protocol=${protocol}${C.reset}`);

  const port = new SerialPort({
    path: portPath,
    baudRate,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    autoOpen: false,
  });

  const stats = new Stats();
  let viewMode: ViewMode = "mixed";

  port.open((err) => {
    if (err) {
      console.log(`${C.red}✖ Failed to open ${portPath}: ${err.message}${C.reset}`);
      process.exit(1);
    }

    console.log(`${C.bold}${C.yellow}══════════════════════════════════════════════════════════${C.reset}`);
    console.log(`${C.bold} Serial Monitor${C.reset} ${C.dim}— ${C.bold}${portPath}${C.reset} @ ${baudRate} baud, ${encoding}`);
    drawHelpBar();
    console.log(`${C.bold}${C.yellow}══════════════════════════════════════════════════════════${C.reset}`);
    console.log(`${C.dim}Type text + Enter to send. /t /h /m /p /s /c /q for commands.${C.reset}`);

    const displayData = (data: Buffer, direction: "rx" | "tx") => {
      const decoded = decode(data, encoding);
      const hex = data.toString("hex").toUpperCase();
      const parsed = { dir: direction, text: decoded, hex, bytes: data.length, ts: new Date().toISOString() };

      if (direction === "rx") {
        stats.rxFrames++;
        stats.rxBytes += data.length;
      } else {
        stats.txFrames++;
        stats.txBytes += data.length;
      }

      displayFrame(parsed, viewMode);
    };

    if (protocol === "line") {
      const parser = new ReadlineParser({ delimiter: "\r\n", includeDelimiter: false, encoding: undefined });
      port.pipe(parser);
      parser.on("data", (data: Buffer) => displayData(data, "rx"));
    } else {
      port.on("data", (data: Buffer) => displayData(data, "rx"));
    }

    // Command input — lines starting with / are commands, others go to serial port
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on("line", (line: string) => {
      if (line.startsWith("/")) {
        const quit = handleCommand(line.slice(1), { viewMode, paused: false, stats }, (v) => {
          viewMode = v;
        });
        if (quit) {
          rl.close();
          port.close(() => process.exit(0));
        }
        return;
      }

      // Send to serial port
      const text = line.trim();
      if (!text) return;

      let buf: Buffer;
      if (encoding === "hex" || encoding === "binary") {
        buf = Buffer.from(text.replace(/\s+/g, ""), "hex");
      } else if (encoding === "base64") {
        buf = Buffer.from(text, "base64");
      } else {
        try {
          const iconv = require("iconv-lite");
          buf = iconv.encodingExists(encoding) ? iconv.encode(text, encoding) : Buffer.from(text, "utf8");
        } catch {
          buf = Buffer.from(text, "utf8");
        }
      }

      port.write(buf, (writeErr) => {
        if (writeErr) console.log(`${C.red}✖ Write failed: ${writeErr.message}${C.reset}`);
        else displayData(buf, "tx");
      });
    });

    port.on("error", (err) => console.log(`${C.red}✖ Port error: ${err.message}${C.reset}`));
    port.on("close", () => {
      console.log(`${C.yellow}ℹ Port closed.${C.reset}`);
      console.log(stats.summary);
      process.exit(0);
    });
  });
}

// ── Main ──

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(`
Serial Monitor — Real-time serial port viewer

Usage:
  serial-monitor <port> [baudRate] [encoding] [protocol]
  serial-monitor --tail <logFile>

Examples:
  serial-monitor COM3
  serial-monitor COM3 115200 gbk
  serial-monitor /dev/ttyUSB0 9600 utf8 line
  serial-monitor --tail serial_abc12345_1234567890.log

Commands (type + Enter):
  t         Text view — decoded data only
  h         Hex view — raw hex bytes
  m         Mixed view — text + hex (default)
  p         Pause / Resume (tail mode)
  s         Show statistics
  c         Clear screen
  q         Quit

Direct mode (port):
  Type text + Enter to send to serial port.
  Prefix with / for commands: /t /h /m /s /c /q
`);
  process.exit(0);
}

if (args[0] === "--tail") {
  if (!args[1]) {
    console.log(`${C.red}✖ Missing log file path. Usage: serial-monitor --tail <logFile>${C.reset}`);
    process.exit(1);
  }
  runTail(args[1]);
} else {
  const portPath = args[0];
  const baudRate = parseInt(args[1] || "115200", 10);
  const encoding = (args[2] || "utf8") as Encoding;
  const protocol = args[3] || "line";
  runDirect(portPath, baudRate, encoding, protocol);
}
