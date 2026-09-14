/**
 * In-process HTTP hub for the UART host UI.
 *
 * - Single active connection (connect closes previous)
 * - SSE frame stream with seq resume (Last-Event-ID / ?sinceSeq=)
 * - Binds 127.0.0.1 by default (no LAN exposure)
 */
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { HubBackend, HubFrame } from "./backend.js";
import type { MessageFilter, SerialConfig } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type HubOptions = {
  backend: HubBackend;
  host?: string;
  port?: number;
  /** Max frames retained for SSE/history (default 2000) */
  maxFrames?: number;
  /** Directory containing index.html (default dist/hub/public) */
  publicDir?: string;
};

export type HubHandle = {
  url: string;
  port: number;
  close(): Promise<void>;
  server: http.Server;
  /** Monitor an existing SerialManager connection (does not take exclusive ownership). */
  attach(connectionId: string): void;
  /** Stop monitoring without closing the serial port. */
  clear(): void;
  frameCount(): number;
  getActiveConnectionId(): string | null;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson<T = Record<string, unknown>>(req: http.IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

type SseClient = {
  res: http.ServerResponse;
  connectionId: string | null;
};

export async function createHub(opts: HubOptions): Promise<HubHandle> {
  const backend = opts.backend;
  const host = opts.host ?? "127.0.0.1";
  const maxFrames = opts.maxFrames ?? 2000;
  const publicDir =
    opts.publicDir ?? path.resolve(__dirname, "public");

  let activeConnectionId: string | null = null;
  /** true only when this Hub process opened the port (vs MCP-owned attach). */
  let ownsPort = false;
  let unsubscribe: (() => void) | null = null;
  let frames: HubFrame[] = [];
  let seq = 0;
  const sseClients = new Set<SseClient>();

  function pushFrame(msg: HubFrame): void {
    frames.push(msg);
    if (frames.length > maxFrames) {
      frames = frames.slice(-maxFrames);
    }
    const payload = `id: ${msg.seq}\nevent: frame\ndata: ${JSON.stringify(msg)}\n\n`;
    for (const client of sseClients) {
      if (client.connectionId && client.connectionId !== msg.connectionId) continue;
      try {
        client.res.write(payload);
      } catch {
        /* dead client cleaned on close */
      }
    }
  }

  function attachConnection(connectionId: string, options: { ownsPort?: boolean } = {}): void {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    // Keep history when re-attaching the same logical monitor after MCP open;
    // clear only when switching to a different connection.
    if (activeConnectionId !== connectionId) {
      frames = [];
      seq = 0;
    }
    activeConnectionId = connectionId;
    ownsPort = options.ownsPort === true;
    unsubscribe = backend.onMessage(connectionId, (msg) => {
      seq += 1;
      pushFrame({ ...msg, seq });
    });
  }

  async function detachConnection(closePort: boolean): Promise<void> {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    const id = activeConnectionId;
    const shouldClose = closePort && ownsPort;
    activeConnectionId = null;
    ownsPort = false;
    frames = [];
    const bye = `event: close\ndata: ${JSON.stringify({ connectionId: id })}\n\n`;
    for (const client of sseClients) {
      try {
        client.res.write(bye);
      } catch {
        /* ignore */
      }
    }
    if (shouldClose && id) {
      await backend.close(id);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = url.pathname;

    try {
      // ── Static UI ──
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const file = path.join(publicDir, "index.html");
        const html = fs.readFileSync(file, "utf8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/static/")) {
        const rel = pathname.slice("/static/".length);
        const file = path.resolve(publicDir, rel);
        if (!file.startsWith(path.resolve(publicDir))) {
          json(res, 403, { ok: false, error: "Forbidden" });
          return;
        }
        if (!fs.existsSync(file)) {
          json(res, 404, { ok: false, error: "Not found" });
          return;
        }
        const ext = path.extname(file);
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
        res.end(fs.readFileSync(file));
        return;
      }

      // ── API ──
      if (req.method === "GET" && pathname === "/api/health") {
        json(res, 200, {
          ok: true,
          activeConnectionId,
          ownsPort,
          frameCount: frames.length,
          seq,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/ports") {
        const ports = await backend.listPorts();
        json(res, 200, { ok: true, ports });
        return;
      }

      if (req.method === "GET" && pathname === "/api/status") {
        const connections = backend.listConnections();
        const active = activeConnectionId
          ? connections.find((c) => c.id === activeConnectionId) ?? null
          : null;
        json(res, 200, {
          ok: true,
          activeConnectionId,
          frameCount: frames.length,
          seq,
          active,
          connections,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/frames") {
        const limit = Number(url.searchParams.get("limit") ?? "200");
        const direction = url.searchParams.get("direction") as "rx" | "tx" | "all" | null;
        const sinceSeq = Number(url.searchParams.get("sinceSeq") ?? "0");
        let list = frames.filter((f) => f.seq > sinceSeq);
        if (direction && direction !== "all") {
          list = list.filter((f) => f.direction === direction);
        }
        if (limit > 0) list = list.slice(-limit);
        json(res, 200, { ok: true, seq, frames: list });
        return;
      }

      if (req.method === "GET" && pathname === "/events/stream") {
        const sinceSeq = Number(url.searchParams.get("sinceSeq") ?? "0");
        const connectionId = url.searchParams.get("connectionId") ?? activeConnectionId;

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write("retry: 2000\n\n");

        const client: SseClient = { res, connectionId };
        sseClients.add(client);

        // Replay backlog
        for (const f of frames) {
          if (f.seq <= sinceSeq) continue;
          if (connectionId && f.connectionId !== connectionId) continue;
          try {
            res.write(`id: ${f.seq}\nevent: frame\ndata: ${JSON.stringify(f)}\n\n`);
          } catch {
            break;
          }
        }

        const ping = setInterval(() => {
          try {
            res.write(`event: ping\ndata: {"t":${Date.now()}}\n\n`);
          } catch {
            /* ignore */
          }
        }, 15000);

        const cleanup = () => {
          clearInterval(ping);
          sseClients.delete(client);
          try {
            res.end();
          } catch {
            /* ignore */
          }
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
        return;
      }

      if (req.method === "POST" && pathname === "/api/connect") {
        const body = await readJson<{
          path: string;
          baudRate?: number;
          dataBits?: number;
          stopBits?: number;
          parity?: string;
          flowControl?: string;
          encoding?: string;
          protocol?: string;
          delimiter?: string;
          frameStart?: string;
          frameEnd?: string;
          bufferSize?: number;
          dtr?: boolean;
          rts?: boolean;
        }>(req);

        if (!body.path) {
          json(res, 400, { ok: false, error: "path is required" });
          return;
        }

        // Single-connection policy: close previous first
        if (activeConnectionId) {
          await detachConnection(true).catch(() => undefined);
        }

        const config: SerialConfig = {
          path: body.path,
          baudRate: (body.baudRate ?? 115200) as SerialConfig["baudRate"],
          dataBits: (body.dataBits ?? 8) as SerialConfig["dataBits"],
          stopBits: (body.stopBits ?? 1) as SerialConfig["stopBits"],
          parity: (body.parity as SerialConfig["parity"]) ?? "none",
          flowControl: (body.flowControl as SerialConfig["flowControl"]) ?? "none",
          encoding: (body.encoding as SerialConfig["encoding"]) ?? "utf8",
          protocol: (body.protocol as SerialConfig["protocol"]) ?? "raw",
          delimiter: body.delimiter,
          frameStart: body.frameStart,
          frameEnd: body.frameEnd,
          bufferSize: body.bufferSize ?? 2000,
          dtr: body.dtr ?? true,
          rts: body.rts ?? true,
        };

        const opened = await backend.open(config);
        attachConnection(opened.connectionId, { ownsPort: true });
        const info = backend.getInfo(opened.connectionId);
        json(res, 200, { ok: true, connectionId: opened.connectionId, info });
        return;
      }

      if (req.method === "POST" && pathname === "/api/detach") {
        // Unmonitor without closing the serial port (MCP may still own it).
        await detachConnection(false);
        json(res, 200, { ok: true, detached: true, closedPort: false });
        return;
      }

      if (req.method === "POST" && pathname === "/api/disconnect") {
        if (!activeConnectionId) {
          json(res, 200, { ok: true, alreadyClosed: true });
          return;
        }
        const id = activeConnectionId;
        const owned = ownsPort;
        await detachConnection(true);
        json(res, 200, { ok: true, connectionId: id, closedPort: owned });
        return;
      }

      if (req.method === "POST" && pathname === "/api/write") {
        if (!activeConnectionId) {
          json(res, 409, { ok: false, error: "Not connected" });
          return;
        }
        const body = await readJson<{ data: string; encoding?: string }>(req);
        if (typeof body.data !== "string") {
          json(res, 400, { ok: false, error: "data is required" });
          return;
        }
        const result = await backend.write(activeConnectionId, body.data, body.encoding);
        json(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && pathname === "/api/config") {
        if (!activeConnectionId) {
          json(res, 409, { ok: false, error: "Not connected" });
          return;
        }
        const body = await readJson<Partial<SerialConfig>>(req);
        const info = await backend.reconfigure(activeConnectionId, body);
        json(res, 200, { ok: true, info });
        return;
      }

      if (req.method === "POST" && pathname === "/api/signals") {
        if (!activeConnectionId) {
          json(res, 409, { ok: false, error: "Not connected" });
          return;
        }
        const body = await readJson<{ break?: boolean; dtr?: boolean; rts?: boolean }>(req);
        await backend.setSignals(activeConnectionId, body);
        json(res, 200, { ok: true, signals: body });
        return;
      }

      json(res, 404, { ok: false, error: `Not found: ${req.method} ${pathname}` });
    } catch (err: any) {
      json(res, 500, { ok: false, error: err?.message ?? String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);

  return {
    url: `http://${host}:${port}`,
    port,
    server,
    attach: (connectionId: string) => attachConnection(connectionId, { ownsPort: false }),
    clear: () => { void detachConnection(false); },
    frameCount: () => frames.length,
    getActiveConnectionId: () => activeConnectionId,
    close: async () => {
      for (const client of [...sseClients]) {
        try {
          client.res.end();
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
      await detachConnection(true).catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Listen on preferredPort; if busy (e.g. scope host holds 8787), walk up
 * to preferredPort+span, then fall back to an ephemeral port (0).
 */
export type HubListenResult = HubHandle & {
  preferredPort: number;
  autoShifted: boolean;
};

export async function createHubWithFallback(
  opts: HubOptions & { preferredPort?: number; portSpan?: number }
): Promise<HubListenResult> {
  const preferredPort = opts.preferredPort ?? 8787;
  const span = opts.portSpan ?? 30;
  const tried: number[] = [];
  let lastErr: unknown;

  for (const port of [preferredPort, ...Array.from({ length: span }, (_, i) => preferredPort + i + 1), 0]) {
    if (tried.includes(port)) continue;
    tried.push(port);
    try {
      const hub = await createHub({ ...opts, port });
      return { ...hub, preferredPort, autoShifted: port !== preferredPort };
    } catch (err: any) {
      const code = err?.code;
      if (code === "EADDRINUSE" || code === "EACCES") {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error(`Could not bind any port from ${preferredPort}..${preferredPort + span}`);
}
