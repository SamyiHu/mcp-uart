/**
 * Fake Orchestrator backend for offline Hub tests: same facade a real OrchestratorManager
 * produces, but the runs are synthetic and instant. It opens ports through the
 * supplied fake serial backend, so connection ids line up with the Hub's.
 */
const PROFILES = [
  {
    name: "fake-orchestrator",
    chip: "FAKE-1",
    description: "Synthetic profile for offline UI and API tests.",
    serial: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", wiring: "TX→RX, common ground" },
    frame: { length: 4, checksumIndex: 3, checksum: "sum-complement" },
    commands: [
      { name: "ping", title: "Ping", fpgaSuitable: true },
      { name: "adc", title: "ADC readback", fpgaSuitable: false, note: "needs 3.3V" },
      { name: "fail_me", title: "Always fails", fpgaSuitable: true },
    ],
    smoke: ["ping", "adc"],
  },
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class FakeOrchestratorBackend {
  constructor(serial) {
    this.serial = serial;
    this.connectionId = null;
    this.profile = null;
    this.running = false;
    this.stats = { framesParsed: 0, framesSent: 0, rawBytesSent: 0, noiseBytes: 0 };
    this.runs = [];
  }

  busy() {
    return this.running;
  }

  profiles() {
    return PROFILES.map((profile) => ({ ...profile, commands: [...profile.commands], smoke: [...profile.smoke] }));
  }

  status(connectionId) {
    const connected = this.connectionId !== null && (connectionId === null || connectionId === undefined || connectionId === this.connectionId);
    if (!connected) {
      return { connected: false, connectionId: null, profile: null, chip: null, port: null, baudRate: null, stats: null };
    }
    let port = null;
    let baudRate = null;
    try {
      const info = this.serial.getInfo(this.connectionId);
      port = info.config.path;
      baudRate = info.config.baudRate;
    } catch {
      /* ignore */
    }
    return {
      connected: true,
      connectionId: this.connectionId,
      profile: this.profile,
      chip: PROFILES.find((p) => p.name === this.profile)?.chip ?? null,
      port,
      baudRate,
      stats: { ...this.stats },
    };
  }

  async connect({ profile, path, baudRate, connectionId }) {
    if (!PROFILES.some((p) => p.name === profile)) throw new Error("Unknown Orchestrator profile '" + profile + "'");
    if (connectionId) {
      this.connectionId = connectionId;
      this.profile = profile;
      return { connectionId, opened: false, status: this.status(connectionId) };
    }
    if (!path) throw new Error("path is required to open a Orchestrator port");
    const opened = await this.serial.open({ path, baudRate: baudRate ?? 115200, encoding: "hex", protocol: "raw" });
    this.connectionId = opened.connectionId;
    this.profile = profile;
    return { connectionId: opened.connectionId, opened: true, status: this.status(opened.connectionId) };
  }

  async disconnect({ connectionId, closePort } = {}) {
    const id = this.connectionId;
    this.connectionId = null;
    this.profile = null;
    if (closePort && id) await this.serial.close(id);
    void connectionId;
  }

  async runCommand(name) {
    if (this.connectionId === null) throw new Error("No Orchestrator session. Pick a profile and connect first.");
    const profile = PROFILES.find((p) => p.name === this.profile);
    const command = profile?.commands.find((c) => c.name === name);
    if (!command) throw new Error("Command '" + name + "' not in profile '" + this.profile + "'");
    const wasRunning = this.running;
    this.running = true;
    try {
      await delay(15);
      this.stats.framesSent += 1;
      this.stats.framesParsed += name === "fail_me" ? 0 : 1;
      this.runs.push(name);
      return {
        command: name,
        title: command.title,
        verdict: name === "fail_me" ? "FAIL" : "PASS",
        sent: ["AA00"],
        frames: name === "fail_me" ? [] : [{ bytes: [0xaa, 0x00, 0x00, 0x56], timestamp: new Date().toISOString() }],
        extras: [],
        failedChecks: name === "fail_me" ? ["no reply frame"] : [],
        elapsedMs: 15,
      };
    } finally {
      this.running = wasRunning;
    }
  }

  async runSmoke({ includeLowPower, connectionId } = {}, onEvent) {
    if (this.connectionId === null) throw new Error("No Orchestrator session. Pick a profile and connect first.");
    void connectionId;
    const names = ["ping", "adc", ...(includeLowPower ? ["fail_me"] : [])];
    this.running = true;
    const started = Date.now();
    const steps = [];
    try {
      onEvent?.({ kind: "smoke-start", profile: this.profile, total: names.length });
      for (let index = 0; index < names.length; index += 1) {
        const step = await this.runCommand(names[index]);
        steps.push(step);
        onEvent?.({ kind: "smoke-step", index, total: names.length, step });
      }
      const passed = steps.filter((s) => s.verdict === "PASS").length;
      const failed = steps.filter((s) => s.verdict === "FAIL" || s.verdict === "TIMEOUT").length;
      const summary = {
        profile: this.profile,
        passed,
        failed,
        report: steps.length - passed - failed,
        allPassed: failed === 0 && passed > 0,
        elapsedMs: Date.now() - started,
      };
      onEvent?.({ kind: "smoke-done", summary });
      return { ...summary, steps };
    } finally {
      this.running = false;
    }
  }
}
