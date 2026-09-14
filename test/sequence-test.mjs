/**
 * Offline tests for dut_sequence (no hardware).
 * Mocks DutSession-like manager the same way dut-offline-test does.
 */
import { DutSession, checksumOf } from "../dist/dut/session.js";
import { DutManager } from "../dist/dut/manager.js";
import { getProfile } from "../dist/dut/profiles/index.js";
import { runDutSequence, validateMatchHex } from "../dist/dut/sequence.js";

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

const profile = getProfile("w6729");
const replyWith = (b3) => {
  const b = [...b3, 0];
  b[3] = checksumOf(b, profile);
  return b;
};

class MockSerial {
  constructor() {
    this.hooks = new Set();
    this.writes = [];
    this.signals = [];
    this.failWrite = false;
  }
  getInfo() { return {}; }
  addDataHook(_id, cb) { this.hooks.add(cb); }
  removeDataHook(_id, cb) { this.hooks.delete(cb); }
  setSignals(_id, s) { this.signals.push(s); return Promise.resolve(); }
  write(_id, hex) {
    if (this.failWrite) throw new Error("write failed: port closed");
    this.writes.push(hex);
    return Promise.resolve();
  }
  rx(bytes) {
    for (const cb of this.hooks) cb(Buffer.from(bytes));
  }
}

async function withEchoResult(mock, session, { delayEcho = 2, delayResult = 8 } = {}) {
  const orig = mock.write.bind(mock);
  mock.write = async (id, hex) => {
    await orig(id, hex);
    setTimeout(() => {
      mock.rx(Buffer.from(hex, "hex"));
      if (hex.length > 2) {
        setTimeout(() => {
          const cmd = parseInt(hex.slice(0, 2), 16);
          if (cmd === 0x0f) mock.rx(Buffer.from(replyWith([0x0f, 0x00, 0xff])));
        }, delayResult);
      }
    }, delayEcho);
  };
  void session;
}

// ── 1. validateMatchHex ──
let threw = false;
try {
  validateMatchHex("0F04", "0F0400EC");
} catch {
  threw = true;
}
assert(threw, "matchHex rejects echo substring");
threw = false;
try {
  validateMatchHex("0F00", "0F0400EC");
} catch {
  threw = true;
}
assert(!threw, "matchHex allows result pattern 0F00");
threw = false;
try {
  validateMatchHex("AB");
} catch {
  threw = true;
}
assert(threw, "matchHex requires ≥4 chars");

// ── 2. IDLE-style: send + clear-state + poll twoPhase ──
{
  const mock = new MockSerial();
  const s = new DutSession(profile, "c-idle", mock);
  s.attach();
  await withEchoResult(mock, s, { delayEcho: 1, delayResult: 12 });

  // Manual echo of IDLE will come async; sequence will clear-state before poll
  const r = await runDutSequence(s, [
    { type: "send-frame", cmd: "0x01" },
    { type: "wait", ms: 8 },
    { type: "clear-state" },
    {
      type: "poll",
      send: { frame: { cmd: "0x0F", p1: 4 } },
      intervalMs: 3,
      timeoutMs: 400,
      matchHex: "0F00",
      twoPhase: true,
      mark: "IDLE探活",
    },
  ]);
  const pollStep = r.steps.find((x) => x.action === "poll");
  assert(r.ok, "IDLE sequence ok");
  assert(pollStep && pollStep.verdict === "matched", "IDLE poll matched");
  assert(
    pollStep && pollStep.matchedFrameHex && pollStep.matchedFrameHex.startsWith("0F00"),
    "matchedFrameHex is result frame"
  );
  assert(
    pollStep && typeof pollStep.firstMatchAtMs === "number" && pollStep.firstMatchAtMs >= 0,
    "firstMatchAtMs present"
  );
}

// ── 3. LED spam: repeat send + delay, budget stop ──
{
  const mock = new MockSerial();
  const s = new DutSession(profile, "c-led", mock);
  s.attach();
  const r = await runDutSequence(
    s,
    [
      {
        type: "repeat",
        times: 1000,
        steps: [
          { type: "send-frame", cmd: "0x91", p1: "0xFF", p2: "0x1F" },
          { type: "wait", ms: 5 },
        ],
        logRepeat: "aggregate",
      },
    ],
    { totalBudgetMs: 80 }
  );
  assert(r.stopped === "budget" || r.ok === false, "LED spam hits budget");
  const rep = r.steps.find((x) => x.action === "repeat");
  assert(rep && rep.completed > 0 && rep.completed < 1000, `repeat partially completed (${rep?.completed})`);
  assert(mock.writes.length > 0, "LED spam sent frames");
}

// ── 4. signals finally restores break ──
{
  const mock = new MockSerial();
  const s = new DutSession(profile, "c-sig", mock);
  s.attach();
  const r = await runDutSequence(s, [
    { type: "signals", break: true, holdMs: 15 },
    { type: "wait", ms: 5 },
  ]);
  assert(r.ok, "signals sequence ok");
  assert(mock.signals.some((x) => x.break === true), "break was set");
  assert(mock.signals.some((x) => x.break === false), "break was restored");
}

// ── 5. baseline + recoveryMs ──
{
  const mock = new MockSerial();
  const s = new DutSession(profile, "c-rec", mock);
  s.attach();
  await withEchoResult(mock, s, { delayEcho: 1, delayResult: 20 });
  const r = await runDutSequence(s, [
    { type: "send-frame", cmd: "0x0A", p1: 1, baseline: true },
    { type: "wait", ms: 5 },
    { type: "clear-state" },
    {
      type: "poll",
      send: { frame: { cmd: "0x0F", p1: 4 } },
      intervalMs: 4,
      timeoutMs: 300,
      matchHex: "0F00",
      twoPhase: true,
    },
  ]);
  assert(
    r.summary.recoveryMs !== undefined && r.summary.recoveryMs >= 0,
    "recoveryMs from baseline to match"
  );
}

// ── 6. hard abort on write failure ──
{
  const mock = new MockSerial();
  const s = new DutSession(profile, "c-abort", mock);
  s.attach();
  mock.failWrite = true;
  const r = await runDutSequence(s, [
    { type: "send-frame", cmd: "0x0F" },
    { type: "wait", ms: 10 },
  ]);
  assert(r.stopped === "aborted", "write failure aborts sequence");
  assert(r.ok === false, "aborted is not ok");
}

// ── 7. delay alias via manager ──
{
  const mock = new MockSerial();
  const dut = new DutManager(mock);
  dut.attach("c-mgr", "w6729");
  const r = await dut.runSequence("c-mgr", [
    { type: "wait", ms: 5 },
    { type: "send-raw", hex: "5A" },
  ]);
  assert(r.ok, "manager.runSequence works");
  assert(mock.writes.includes("5A"), "raw sent through manager");
  dut.detach("c-mgr");
}

console.log("\n=== dut_sequence offline tests done ===");
