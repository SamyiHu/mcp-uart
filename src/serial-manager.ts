import { SerialPort } from "serialport";
import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import type {
  SerialConfig,
  SerialMessage,
  ConnectionInfo,
  ConnectionEntry,
  ReadResult,
  MessageFilter,
} from "./types.js";
import { decode, encode, toHexDump } from "./encodings.js";
import { createParser } from "./protocols.js";

// --- Waiter types ---

type FrameWaiterEntry = {
  resolve: (messages: SerialMessage[]) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ResponseWaiterEntry = {
  resolve: (result: { messages: SerialMessage[]; reason: "silence" | "timeout" }) => void;
  collected: SerialMessage[];
  silenceTimer: ReturnType<typeof setTimeout> | null;
  totalTimer: ReturnType<typeof setTimeout>;
  silenceTimeout: number;
};

type MonitorEntry = {
  logPath: string;
  stream: fs.WriteStream;
  startedAt: Date;
  messageCount: number;
};

export class SerialManager {
  private connections = new Map<string, ConnectionEntry>();
  private frameWaiters = new Map<string, FrameWaiterEntry[]>();
  private responseWaiters = new Map<string, ResponseWaiterEntry>();
  private monitors = new Map<string, MonitorEntry>();
  private dataHooks = new Map<string, Set<(data: Buffer) => void>>();
  private messageListeners = new Map<string, Set<(msg: SerialMessage) => void>>();

  /**
   * Subscribe to every message (TX/RX) on a connection after it is stored.
   * Returns an unsubscribe function.
   */
  onMessage(connectionId: string, cb: (msg: SerialMessage) => void): () => void {
    if (!this.messageListeners.has(connectionId)) {
      this.messageListeners.set(connectionId, new Set());
    }
    this.messageListeners.get(connectionId)!.add(cb);
    return () => {
      this.messageListeners.get(connectionId)?.delete(cb);
    };
  }

  /**
   * Register a raw-RX-bytes hook for a connection. The hook receives every
   * incoming chunk BEFORE any parser/encoding handling — protocol layers
   * (e.g. W6729 framing) use this for byte-accurate frame extraction.
   */
  addDataHook(connectionId: string, cb: (data: Buffer) => void): void {
    if (!this.connections.has(connectionId)) {
      throw new Error(`Connection ${connectionId} not found`);
    }
    if (!this.dataHooks.has(connectionId)) {
      this.dataHooks.set(connectionId, new Set());
    }
    this.dataHooks.get(connectionId)!.add(cb);
  }

  removeDataHook(connectionId: string, cb: (data: Buffer) => void): void {
    this.dataHooks.get(connectionId)?.delete(cb);
  }

  /**
   * Set modem control signals on a connection. Used e.g. to generate a
   * break pulse on the TX line, which the W6729 board sees as a falling
   * edge on its RX wake pin (STOP/IDLE wake).
   */
  setSignals(
    connectionId: string,
    signals: { break?: boolean; dtr?: boolean; rts?: boolean }
  ): Promise<void> {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`Connection ${connectionId} not found`);
    if (entry.status !== "open") throw new Error(`Connection ${connectionId} is ${entry.status}`);

    return new Promise((resolve, reject) => {
      entry.port.set(signals as any, (err: any) => {
        if (err) reject(new Error(`Failed to set signals: ${err.message}`));
        else resolve();
      });
    });
  }

  async listPorts(): Promise<Array<{ path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string; pnpId?: string }>> {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      vendorId: p.vendorId,
      productId: p.productId,
      pnpId: p.pnpId,
    }));
  }

  async open(config: SerialConfig): Promise<{ connectionId: string; status: string }> {
    const id = uuidv4().slice(0, 8);

    const port = new SerialPort({
      path: config.path,
      baudRate: config.baudRate,
      dataBits: config.dataBits as 5 | 6 | 7 | 8,
      stopBits: config.stopBits as 1 | 2,
      parity: config.parity as "none" | "even" | "odd" | "mark" | "space",
      rtscts: config.flowControl === "hardware",
      xon: config.flowControl === "software",
      xoff: config.flowControl === "software",
      autoOpen: false,
    });

    const entry: ConnectionEntry = {
      port,
      config,
      messages: [],
      status: "open",
      openedAt: new Date(),
      lastActivity: null,
      error: null,
      messageCount: 0,
      lastReadIndex: 0,
      rawListener: undefined,
      reconnectTimer: undefined,
      reconnectAttempts: 0,
      manualClose: false,
    };

    this.connections.set(id, entry);

    return new Promise((resolve, reject) => {
      port.open((err) => {
        if (err) {
          entry.status = "error";
          entry.error = err.message;
          reject(new Error(`Failed to open ${config.path}: ${err.message}`));
          return;
        }

        port.set({ dtr: config.dtr ?? true, rts: config.rts ?? true });
        this.setupDataHandlers(id);

        port.on("error", (err) => {
          entry.status = "error";
          entry.error = err.message;
        });

        port.on("close", () => {
          entry.status = "closed";
          if (entry.config.autoReconnect && !entry.manualClose) {
            this.tryReconnect(id);
          }
        });

        resolve({ connectionId: id, status: "open" });
      });
    });
  }

  /**
   * Set up or re-set data handlers for a connection.
   * Cleans up any existing parser or raw listener before creating new ones.
   */
  private setupDataHandlers(connectionId: string) {
    const entry = this.connections.get(connectionId);
    if (!entry) return;

    // Clean up existing parser
    if (entry.parser) {
      entry.port.unpipe(entry.parser);
      entry.parser.removeAllListeners();
      entry.parser = undefined;
    }

    // Clean up existing raw listener
    if (entry.rawListener) {
      entry.port.removeListener("data", entry.rawListener);
      entry.rawListener = undefined;
    }

    const parser = createParser(entry.config);
    if (parser) {
      entry.parser = parser;
      entry.port.pipe(parser);
      parser.on("data", (data: Buffer) => {
        this.handleData(connectionId, data, "rx");
      });
    } else {
      const listener = (data: Buffer) => {
        this.handleData(connectionId, data, "rx");
      };
      entry.rawListener = listener;
      entry.port.on("data", listener);
    }
  }

  private handleData(connectionId: string, data: Buffer, direction: "rx" | "tx") {
    const entry = this.connections.get(connectionId);
    if (!entry) return;

    // Raw RX hooks first (protocol layers need unframed bytes)
    if (direction === "rx") {
      const hooks = this.dataHooks.get(connectionId);
      if (hooks) {
        for (const cb of hooks) {
          try { cb(data); } catch { /* hook errors must not kill the stream */ }
        }
      }
    }

    const decoded = decode(data, entry.config.encoding);
    const msg: SerialMessage = {
      timestamp: new Date().toISOString(),
      connectionId,
      data: decoded,
      raw: data.toString("hex").toUpperCase(),
      length: data.length,
      direction,
    };

    entry.messages.push(msg);
    entry.messageCount++;
    entry.lastActivity = new Date();

    const listeners = this.messageListeners.get(connectionId);
    if (listeners) {
      for (const cb of listeners) {
        try { cb(msg); } catch { /* listener errors must not kill the stream */ }
      }
    }

    const maxBuffer = entry.config.bufferSize ?? 1000;
    // Trim in bulk: `slice(-maxBuffer)` on every frame copied the whole message
    // buffer once per frame, which is pure overhead at high baud rates.
    const headroom = Math.max(64, maxBuffer >> 2);
    if (entry.messages.length > maxBuffer + headroom) {
      const trimmed = entry.messages.length - maxBuffer;
      entry.messages.splice(0, trimmed);
      entry.lastReadIndex = Math.max(0, entry.lastReadIndex - trimmed);
    }

    if (direction === "rx") {
      this.notifyFrameWaiters(connectionId);
      this.feedResponseWaiter(connectionId, msg);
    }

    this.writeMonitorLog(connectionId, msg);
  }

  async write(
    connectionId: string,
    data: string,
    inputEncoding?: string
  ): Promise<{ bytesWritten: number; raw: string }> {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`Connection ${connectionId} not found`);
    if (entry.status !== "open") throw new Error(`Connection ${connectionId} is ${entry.status}`);

    const enc = (inputEncoding || entry.config.encoding) as any;
    const buf = encode(data, enc);

    return new Promise((resolve, reject) => {
      entry.port.write(buf, (err) => {
        if (err) {
          reject(new Error(`Write failed: ${err.message}`));
          return;
        }
        this.handleData(connectionId, buf, "tx");
        resolve({
          bytesWritten: buf.length,
          raw: buf.toString("hex").toUpperCase(),
        });
      });
    });
  }

  read(
    connectionId: string,
    count?: number,
    since?: string
  ): SerialMessage[] {
    return this.readFiltered(connectionId, { count, since });
  }

  /** Apply a MessageFilter to an in-memory list (pure; no connection). */
  static applyFilter(messages: SerialMessage[], filter: MessageFilter = {}): SerialMessage[] {
    let out = messages;
    if (filter.direction && filter.direction !== "all") {
      out = out.filter((m) => m.direction === filter.direction);
    }
    if (filter.since) {
      const sinceTime = new Date(filter.since).getTime();
      out = out.filter((m) => new Date(m.timestamp).getTime() > sinceTime);
    }
    if (typeof filter.minLength === "number") {
      out = out.filter((m) => m.length >= filter.minLength!);
    }
    if (typeof filter.maxLength === "number") {
      out = out.filter((m) => m.length <= filter.maxLength!);
    }
    if (filter.matchHex) {
      const needle = filter.matchHex.replace(/\s+/g, "").toUpperCase();
      out = out.filter((m) => (m.raw || "").toUpperCase().includes(needle));
    }
    if (filter.matchText) {
      const needle = filter.matchText;
      out = out.filter((m) => m.data.includes(needle));
    }
    if (typeof filter.offset === "number" && filter.offset > 0) {
      out = out.slice(filter.offset);
    }
    if (filter.lastOnly) {
      out = out.length ? [out[out.length - 1]] : [];
    } else if (typeof filter.count === "number" && filter.count > 0) {
      out = out.slice(-filter.count);
    }
    return out;
  }

  getMessages(connectionId: string, filter: MessageFilter = {}, opts: { advanceCursor?: boolean } = {}): SerialMessage[] {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`Connection ${connectionId} not found`);

    const messages = SerialManager.applyFilter(entry.messages, filter);

    if (opts.advanceCursor !== false) {
      entry.lastReadIndex = entry.messages.length;
    }
    return messages;
  }

  readFiltered(
    connectionId: string,
    filter: MessageFilter = {},
    opts: { advanceCursor?: boolean } = {}
  ): SerialMessage[] {
    return this.getMessages(connectionId, filter, opts);
  }

  /** Snapshot of buffered messages without advancing the read cursor. */
  peekMessages(connectionId: string, filter: MessageFilter = {}): SerialMessage[] {
    return this.getMessages(connectionId, filter, { advanceCursor: false });
  }

  async reconfigure(
    connectionId: string,
    updates: Partial<SerialConfig>
  ): Promise<ConnectionInfo> {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`Connection ${connectionId} not found`);

    const oldProtocol = entry.config.protocol;

    // For baud rate changes, use port.update()
    if (updates.baudRate && updates.baudRate !== entry.config.baudRate) {
      await new Promise<void>((resolve, reject) => {
        entry.port.update({ baudRate: updates.baudRate! }, (err) => {
          if (err) reject(new Error(`Failed to update baud rate: ${err.message}`));
          else resolve();
        });
      });
    }

    // Update config
    entry.config = { ...entry.config, ...updates };

    // If protocol changed, re-create data handlers
    if (updates.protocol && updates.protocol !== oldProtocol) {
      this.setupDataHandlers(connectionId);
    }

    return this.getInfo(connectionId);
  }

  async close(connectionId: string): Promise<void> {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`Connection ${connectionId} not found`);

    // Prevent auto-reconnect
    entry.manualClose = true;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = undefined;
    }

    return new Promise((resolve, reject) => {
      if (entry.parser) {
        entry.port.unpipe(entry.parser);
      }
      this.dataHooks.delete(connectionId);
      this.messageListeners.delete(connectionId);
      entry.port.close((err) => {
        if (err) {
          reject(new Error(`Failed to close: ${err.message}`));
          return;
        }
        entry.status = "closed";
        resolve();
      });
    });
  }

  // ── Auto-reconnect ──

  private tryReconnect(connectionId: string) {
    const entry = this.connections.get(connectionId);
    if (!entry || entry.manualClose) return;

    const maxAttempts = 10;
    if (entry.reconnectAttempts >= maxAttempts) {
      entry.status = "error";
      entry.error = `Auto-reconnect failed after ${maxAttempts} attempts`;
      return;
    }

    entry.reconnectAttempts++;
    entry.status = "reconnecting";

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...
    const delay = Math.min(1000 * Math.pow(2, entry.reconnectAttempts - 1), 30000);

    entry.reconnectTimer = setTimeout(async () => {
      try {
        const newPort = new SerialPort({
          path: entry.config.path,
          baudRate: entry.config.baudRate,
          dataBits: entry.config.dataBits as 5 | 6 | 7 | 8,
          stopBits: entry.config.stopBits as 1 | 2,
          parity: entry.config.parity as "none" | "even" | "odd" | "mark" | "space",
          rtscts: entry.config.flowControl === "hardware",
          xon: entry.config.flowControl === "software",
          xoff: entry.config.flowControl === "software",
          autoOpen: false,
        });

        await new Promise<void>((resolve, reject) => {
          newPort.open((err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Success — swap port
        entry.port = newPort;
        entry.status = "open";
        entry.error = null;
        entry.reconnectAttempts = 0;
        entry.reconnectTimer = undefined;

        newPort.set({ dtr: entry.config.dtr ?? true, rts: entry.config.rts ?? true });
        this.setupDataHandlers(connectionId);

        newPort.on("error", (err) => {
          entry.status = "error";
          entry.error = err.message;
        });

        newPort.on("close", () => {
          entry.status = "closed";
          if (entry.config.autoReconnect && !entry.manualClose) {
            this.tryReconnect(connectionId);
          }
        });
      } catch {
        // Failed — try again
        this.tryReconnect(connectionId);
      }
    }, delay);
  }

  // ── Info & status ──

  getInfo(connectionId: string): ConnectionInfo {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`Connection ${connectionId} not found`);

    return {
      id: connectionId,
      config: entry.config,
      status: entry.status,
      openedAt: entry.openedAt.toISOString(),
      messageCount: entry.messageCount,
      lastActivity: entry.lastActivity?.toISOString() ?? null,
      error: entry.error,
    };
  }

  listConnections(): ConnectionInfo[] {
    const result: ConnectionInfo[] = [];
    for (const [id] of this.connections) {
      result.push(this.getInfo(id));
    }
    return result;
  }

  getHexDump(connectionId: string, count?: number): string {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`Connection ${connectionId} not found`);

    const messages = count ? entry.messages.slice(-count) : entry.messages;
    return messages
      .map((m) => {
        const hex = m.raw || "";
        return `[${m.timestamp}] ${m.direction.toUpperCase()} (${m.length}B): ${hex}`;
      })
      .join("\n");
  }

  // ── Frame waiters: resolve on first RX frame ──

  private notifyFrameWaiters(connectionId: string) {
    const waiters = this.frameWaiters.get(connectionId);
    if (!waiters || waiters.length === 0) return;

    const entry = this.connections.get(connectionId);
    if (!entry) return;

    const messages = entry.messages.slice(entry.lastReadIndex);
    entry.lastReadIndex = entry.messages.length;

    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(messages);
    }
    this.frameWaiters.set(connectionId, []);
  }

  waitForFrame(connectionId: string, timeoutMs: number = 5000): Promise<SerialMessage[]> {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`Connection ${connectionId} not found`);
    if (entry.status !== "open") throw new Error(`Connection ${connectionId} is ${entry.status}`);

    const unread = entry.messages.slice(entry.lastReadIndex);
    const rxUnread = unread.filter((m) => m.direction === "rx");
    if (rxUnread.length > 0) {
      entry.lastReadIndex = entry.messages.length;
      return Promise.resolve(rxUnread);
    }

    return new Promise<SerialMessage[]>((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.frameWaiters.get(connectionId) || [];
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) waiters.splice(idx, 1);
        resolve([]);
      }, timeoutMs);

      if (!this.frameWaiters.has(connectionId)) {
        this.frameWaiters.set(connectionId, []);
      }
      this.frameWaiters.get(connectionId)!.push({ resolve, timer });
    });
  }

  // ── Response waiter: collect until silence or total timeout ──

  private feedResponseWaiter(connectionId: string, msg: SerialMessage) {
    const waiter = this.responseWaiters.get(connectionId);
    if (!waiter) return;

    waiter.collected.push(msg);

    if (waiter.silenceTimer) clearTimeout(waiter.silenceTimer);
    waiter.silenceTimer = setTimeout(() => {
      this.resolveResponseWaiter(connectionId, "silence");
    }, waiter.silenceTimeout);
  }

  private resolveResponseWaiter(connectionId: string, reason: "silence" | "timeout") {
    const waiter = this.responseWaiters.get(connectionId);
    if (!waiter) return;

    if (waiter.silenceTimer) clearTimeout(waiter.silenceTimer);
    clearTimeout(waiter.totalTimer);
    this.responseWaiters.delete(connectionId);

    waiter.resolve({ messages: waiter.collected, reason });
  }

  waitForResponse(
    connectionId: string,
    silenceTimeout: number = 500,
    totalTimeout: number = 10000
  ): Promise<{ messages: SerialMessage[]; reason: "silence" | "timeout" }> {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`Connection ${connectionId} not found`);
    if (entry.status !== "open") throw new Error(`Connection ${connectionId} is ${entry.status}`);

    if (this.responseWaiters.has(connectionId)) {
      throw new Error(`Response wait already in progress for ${connectionId}`);
    }

    return new Promise((resolve) => {
      const waiter: ResponseWaiterEntry = {
        resolve,
        collected: [],
        silenceTimer: null,
        totalTimer: null as any,
        silenceTimeout,
      };

      waiter.totalTimer = setTimeout(() => {
        this.resolveResponseWaiter(connectionId, "timeout");
      }, totalTimeout);

      waiter.silenceTimer = setTimeout(() => {
        this.resolveResponseWaiter(connectionId, "silence");
      }, silenceTimeout);

      this.responseWaiters.set(connectionId, waiter);
    });
  }

  readSinceLastRead(connectionId: string): ReadResult {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`Connection ${connectionId} not found`);

    const messages = entry.messages.slice(entry.lastReadIndex);
    entry.lastReadIndex = entry.messages.length;

    const now = Date.now();
    const lastActivity = entry.lastActivity ? entry.lastActivity.toISOString() : null;
    const dataAge = entry.lastActivity ? now - entry.lastActivity.getTime() : null;

    return {
      messages,
      lastActivity,
      dataAge,
      newMessageCount: messages.length,
      totalBuffered: entry.messages.length,
    };
  }

  // ── Monitor log ──

  startMonitor(connectionId: string, logPath?: string): { logPath: string } {
    const entry = this.connections.get(connectionId);
    if (!entry) throw new Error(`Connection ${connectionId} not found`);
    if (this.monitors.has(connectionId)) throw new Error(`Monitor already running for ${connectionId}. Stop it first.`);

    const resolvedPath = logPath || `serial_${connectionId}_${Date.now()}.log`;
    const stream = fs.createWriteStream(resolvedPath, { flags: "a" });

    const header = `=== Serial Monitor Started ===\nConnection: ${connectionId}\nPort: ${entry.config.path}\nBaud: ${entry.config.baudRate}\nEncoding: ${entry.config.encoding}\nTime: ${new Date().toISOString()}\n${"─".repeat(60)}\n\n`;
    stream.write(header);

    const monitor: MonitorEntry = {
      logPath: resolvedPath,
      stream,
      startedAt: new Date(),
      messageCount: 0,
    };
    this.monitors.set(connectionId, monitor);

    return { logPath: resolvedPath };
  }

  stopMonitor(connectionId: string): { logPath: string; duration: number; messageCount: number } {
    const monitor = this.monitors.get(connectionId);
    if (!monitor) throw new Error(`No monitor running for ${connectionId}`);

    const footer = `\n${"─".repeat(60)}\n=== Monitor Stopped ===\nMessages logged: ${monitor.messageCount}\nDuration: ${Math.round((Date.now() - monitor.startedAt.getTime()) / 1000)}s\n`;
    monitor.stream.write(footer);
    monitor.stream.end();
    this.monitors.delete(connectionId);

    return {
      logPath: monitor.logPath,
      duration: Date.now() - monitor.startedAt.getTime(),
      messageCount: monitor.messageCount,
    };
  }

  isMonitoring(connectionId: string): boolean {
    return this.monitors.has(connectionId);
  }

  getMonitorInfo(connectionId: string): { logPath: string; startedAt: string; messageCount: number } | null {
    const monitor = this.monitors.get(connectionId);
    if (!monitor) return null;
    return {
      logPath: monitor.logPath,
      startedAt: monitor.startedAt.toISOString(),
      messageCount: monitor.messageCount,
    };
  }

  private writeMonitorLog(connectionId: string, msg: SerialMessage) {
    const monitor = this.monitors.get(connectionId);
    if (!monitor) return;

    const dir = msg.direction === "rx" ? "RX" : "TX";
    // Escape newlines so each message is exactly one line in the log file
    const escapedData = msg.data.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
    const line = `[${msg.timestamp}] ${dir} (${msg.length}B): ${escapedData} | HEX: ${msg.raw}\n`;
    monitor.stream.write(line);
    monitor.messageCount++;
  }
}
