/**
 * Fake HubBackend for offline HTTP/SSE tests (no serial hardware).
 * Pure JS — no TypeScript syntax.
 */
export class FakeHubBackend {
  constructor() {
    this.listeners = new Map();
    this.messages = new Map();
    this.info = new Map();
    this.nextId = 1;
    this.openCount = 0;
    this.closeCount = 0;
    this.writes = [];
    this.signals = [];
    this.reconfigs = [];
    this.failOpen = null;
  }

  async listPorts() {
    return [
      { path: "COM1", manufacturer: "FakeA" },
      { path: "COM2", manufacturer: "FakeB" },
    ];
  }

  async open(config) {
    if (this.failOpen) throw new Error(this.failOpen);
    const id = `c${this.nextId++}`;
    this.openCount++;
    this.messages.set(id, []);
    this.info.set(id, {
      id,
      config,
      status: "open",
      openedAt: new Date().toISOString(),
      messageCount: 0,
      lastActivity: null,
      error: null,
    });
    return { connectionId: id, status: "open" };
  }

  async close(id) {
    this.closeCount++;
    const i = this.info.get(id);
    if (i) i.status = "closed";
    this.listeners.delete(id);
  }

  async write(id, data, encoding) {
    if (!this.info.has(id) || this.info.get(id).status !== "open") {
      throw new Error(`Connection ${id} not open`);
    }
    this.writes.push({ id, data, encoding });
    const raw =
      encoding === "hex"
        ? data.replace(/\s+/g, "").toUpperCase()
        : Buffer.from(data, "utf8").toString("hex").toUpperCase();
    const len = raw.length / 2;
    this.emit(id, {
      timestamp: new Date().toISOString(),
      connectionId: id,
      data: encoding === "hex" ? raw : data,
      raw,
      length: len,
      direction: "tx",
    });
    return { bytesWritten: len, raw };
  }

  getInfo(id) {
    const i = this.info.get(id);
    if (!i) throw new Error(`Connection ${id} not found`);
    return i;
  }

  listConnections() {
    return [...this.info.values()];
  }

  peekMessages(id, filter = {}) {
    let list = this.messages.get(id) ?? [];
    if (filter.direction && filter.direction !== "all") {
      list = list.filter((m) => m.direction === filter.direction);
    }
    if (filter.count && filter.count > 0) list = list.slice(-filter.count);
    return list;
  }

  async readFiltered(id, filter = {}) {
    return this.peekMessages(id, filter);
  }

  async reconfigure(id, updates) {
    this.reconfigs.push({ id, updates });
    const i = this.getInfo(id);
    i.config = { ...i.config, ...updates };
    return i;
  }

  async setSignals(id, signals) {
    this.signals.push({ id, signals });
  }

  onMessage(id, cb) {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id).add(cb);
    return () => this.listeners.get(id)?.delete(cb);
  }

  /** Test helper: inject an RX frame (simulates device data). */
  emitRx(id, bytes, text) {
    const raw = bytes
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    this.emit(id, {
      timestamp: new Date().toISOString(),
      connectionId: id,
      data:
        text ??
        bytes
          .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "."))
          .join(""),
      raw,
      length: bytes.length,
      direction: "rx",
    });
  }

  emit(id, msg) {
    this.messages.get(id)?.push(msg);
    const i = this.info.get(id);
    if (i) {
      i.messageCount++;
      i.lastActivity = msg.timestamp;
    }
    for (const cb of this.listeners.get(id) ?? []) cb(msg);
  }
}
