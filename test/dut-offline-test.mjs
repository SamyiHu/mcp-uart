/**
 * Offline logic test for the DUT protocol layer (no hardware needed).
 *
 * Uses the shipped `frame-demo` profile: a 4-byte frame (3 payload bytes + a
 * sum-complement checksum) with a two-phase handshake —
 *   write #1 of a frame → device echoes it; write #2 → device sends the result.
 * Raw byte writes are echoed back verbatim.
 */
import { DutSession, checksumOf } from "../dist/dut/session.js";
import { DutManager } from "../dist/dut/manager.js";
import { getProfile } from "../dist/dut/profiles/index.js";

class MockSerial {
  constructor() {
    this.hooks = new Set();
    this.writes = [];
  }
  getInfo() { return {}; }
  addDataHook(_id, cb) { this.hooks.add(cb); }
  removeDataHook(_id, cb) { this.hooks.delete(cb); }
  setSignals(_id, s) { this.signals = s; return Promise.resolve(); }
  write(_id, hex) { this.writes.push(hex); return Promise.resolve(); }
  rx(bytes) { for (const cb of this.hooks) cb(Buffer.from(bytes)); }
}

const profile = getProfile("frame-demo");
const assert = (cond, msg) => {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok:", msg);
};
/** Build a result frame for the given payload bytes (checksum filled in). */
const replyWith = (b3) => { const b = [...b3, 0]; b[3] = checksumOf(b, profile); return b; };

// ── 1. checksum + frame build ──
assert(checksumOf([0x01, 0x00, 0x00, 0x00], profile) === 0xFE, "read_value frame ck=0xFE");
assert(checksumOf([0x02, 0x00, 0x00, 0x00], profile) === 0xFD, "self_test frame ck=0xFD");
const s1 = new DutSession(profile, "c1", new MockSerial());
assert(s1.buildFrame(0x04, 0x50, 0x00).toString("hex").toUpperCase() === "045000AB", "echo_roundtrip full frame = 04 50 00 AB");

// ── 2. chunked RX + noise resync ──
const mock = new MockSerial();
const s2 = new DutSession(profile, "c2", mock);
s2.attach();
mock.rx([0x5A, 0x01]);            // noise byte, then the frame start, split across reads
mock.rx([0x00, 0x00]);
mock.rx([0xFE, 0x02, 0x00]);
mock.rx([0x00, 0xFD]);
const snap = s2.snapshot();
assert(snap.extras.length === 1 && snap.extras[0] === 0x5A, "noise byte lands in extras");
assert(snap.frames.length === 2 && snap.frames[1].bytes.join(",") === "2,0,0,253", "cross-chunk parse yields 2 frames");

// ── 3. bad checksum → resync by one byte ──
const mock3 = new MockSerial();
const s3 = new DutSession(profile, "c3", mock3);
s3.attach();
mock3.rx([0xFF, 0x01, 0x00, 0x00, 0xFE]);
const snap3 = s3.snapshot();
assert(snap3.extras.length === 1 && snap3.frames.length === 1, "bad byte skipped, sync recovered");

// ── 4. full command run: two-phase handshake over the mock ──
const mock4 = new MockSerial();
const dut = new DutManager(mock4);
const origWrite = mock4.write.bind(mock4);
const writeCount = {};
mock4.write = (id, hex) => {
  const p = origWrite(id, hex);
  writeCount[hex] = (writeCount[hex] || 0) + 1;
  const n = writeCount[hex];
  setTimeout(() => {
    if (hex.length === 2) { mock4.rx(Buffer.from(hex, "hex")); return; }  // raw byte echo
    if (n === 1) { mock4.rx(Buffer.from(hex, "hex")); return; }            // frame echo
    const key = hex.slice(0, 2);
    const reply = {
      "01": [0x01, 0x00, 0x00],   // read_value: status byte 0
      "02": [0x02, 0x00, 0x00],   // self_test: both codes 0
      "03": [0x03, 0x12, 0x34],   // device_id: two id bytes
      "04": [0x04, 0x00, 0x5A],   // echo_roundtrip: reports the test byte
    }[key];
    if (reply) mock4.rx(replyWith(reply));
  }, 5);
  return p;
};
dut.attach("c4", "frame-demo");

let r = await dut.runCommand("c4", "read_value");
assert(r.verdict === "PASS", `read_value PASS (got ${r.verdict}${r.failedChecks ? " — " + r.failedChecks : ""})`);
assert(r.frames.length === 2 && r.frames[0].bytes.join() === "1,0,0,254", "first frame is the echo");

r = await dut.runCommand("c4", "self_test");
assert(r.verdict === "PASS", `self_test PASS (got ${r.verdict})`);

r = await dut.runCommand("c4", "device_id");
assert(r.verdict === "PASS", `device_id PASS (got ${r.verdict})`);

r = await dut.runCommand("c4", "echo_roundtrip");
assert(r.verdict === "PASS", `echo_roundtrip (with 0x5A echo) PASS (got ${r.verdict}${r.failedChecks ? " — " + r.failedChecks : ""})`);
assert(r.extras.includes(0x5A), "0x5A appears in extras");

// ── 5. FAIL path: a non-zero status byte must fail the run ──
const mockFail = new MockSerial();
const dutFail = new DutManager(mockFail);
const origWriteF = mockFail.write.bind(mockFail);
let nF = 0;
mockFail.write = (id, hex) => {
  const p = origWriteF(id, hex);
  nF++;
  setTimeout(() => {
    if (nF === 1) mockFail.rx(Buffer.from(hex, "hex"));
    else mockFail.rx(Buffer.from(replyWith([0x01, 0x01, 0x00])));
  }, 5);
  return p;
};
dutFail.attach("cf", "frame-demo");
r = await dutFail.runCommand("cf", "read_value");
assert(r.verdict === "FAIL", `non-zero status fails the run (got ${r.verdict}${r.failedChecks ? " — " + r.failedChecks : ""})`);
dutFail.detach("cf");

// ── 6. TIMEOUT path: a silent device must not hang the runner ──
mock4.write = (id, hex) => origWrite(id, hex);
const t0 = Date.now();
r = await dut.runCommand("c4", "read_value");
assert(r.verdict === "TIMEOUT" && Date.now() - t0 >= 700, `silent device yields TIMEOUT (got ${r.verdict})`);

// ── 7. smoke over the mock ──
for (const k of Object.keys(writeCount)) delete writeCount[k];
mock4.write = (id, hex) => {
  const p = origWrite(id, hex);
  writeCount[hex] = (writeCount[hex] || 0) + 1;
  const n = writeCount[hex];
  setTimeout(() => {
    if (hex.length === 2) { mock4.rx(Buffer.from(hex, "hex")); return; }
    if (n === 1) { mock4.rx(Buffer.from(hex, "hex")); return; }
    const reply = { "01": [0x01, 0x00, 0x00], "02": [0x02, 0x00, 0x00] }[hex.slice(0, 2)];
    if (reply) mock4.rx(replyWith(reply));
  }, 5);
  return p;
};
const smoke = await dut.runSmoke("c4", false);
assert(smoke.passed === profile.smoke.length, `smoke PASS=${profile.smoke.length} (got ${smoke.passed})`);
assert(smoke.failed === 0, "smoke has no failures");

console.log("\n=== dut offline tests done ===");
