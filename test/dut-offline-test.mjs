/**
 * Offline logic test for the DUT protocol layer (no hardware needed).
 * Models the VERIFIED two-phase W6729 handshake:
 *   write#1 of a frame → echo;  write#2 → result  (ram: write#3 → result2)
 * Raw byte writes are echoed back verbatim (ISR echo).
 */
import { DutSession, checksumOf } from "../dist/dut/session.js";
import { DutManager, formatRun } from "../dist/dut/manager.js";
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

const profile = getProfile("w6729");
const assert = (cond, msg) => {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok:", msg);
};
const replyWith = (b3) => { const b = [...b3, 0]; b[3] = checksumOf(b, profile); return b; };

// ── 1. checksum + frame build ──
assert(checksumOf([0x06, 0, 0, 0], profile) === 0xF9, "instruction 帧 ck=0xF9");
assert(checksumOf([0x0F, 0x00, 0xFF, 0], profile) === 0xF1, "freq 结果帧 ck=0xF1(硬件实测值)");
const s1 = new DutSession(profile, "c1", new MockSerial());
assert(s1.buildFrame(0x0F, 0x04, 0x00).toString("hex").toUpperCase() === "0F0400EC", "freq_query 完整帧=0F0400EC");

// ── 2. chunked RX + noise resync ──
const mock = new MockSerial();
const s2 = new DutSession(profile, "c2", mock);
s2.attach();
mock.rx([0x5A, 0x03]);            // noise + frame start split
mock.rx([0x00, 0x00]);
mock.rx([0xFC, 0x03, 0xCB]);
mock.rx([0x00, 0x31]);
const snap = s2.snapshot();
assert(snap.extras.length === 1 && snap.extras[0] === 0x5A, "噪声字节进入extras");
assert(snap.frames.length === 2 && snap.frames[1].bytes.join(",") === "3,203,0,49", "跨chunk解析2帧");

// ── 3. bad checksum → resync by 1 byte ──
const mock3 = new MockSerial();
const s3 = new DutSession(profile, "c3", mock3);
s3.attach();
mock3.rx([0xFF, 0x06, 0x00, 0x00, 0xF9]);
const snap3 = s3.snapshot();
assert(snap3.extras.length === 1 && snap3.frames.length === 1, "坏字节跳过后恢复同步");

// ── 4. full command run: 两段式握手 mock ──
const mock4 = new MockSerial();
const dut = new DutManager(mock4);
const origWrite = mock4.write.bind(mock4);
const writeCount = {};
mock4.write = (id, hex) => {
  const p = origWrite(id, hex);
  writeCount[hex] = (writeCount[hex] || 0) + 1;
  const n = writeCount[hex];
  setTimeout(() => {
    if (hex.length === 2) { mock4.rx(Buffer.from(hex, "hex")); return; }  // raw byte ISR echo
    if (n === 1) { mock4.rx(Buffer.from(hex, "hex")); return; }            // frame echo
    const key = hex.slice(0, 2);
    if (key === "03") {   // ram: 2 result frames across 2 handshakes
      if (n === 2) mock4.rx(replyWith([0x03, 0x00, 0x00]));
      else if (n === 3) mock4.rx(replyWith([0x03, 0xCB, 0x00]));
      return;
    }
    const r = {
      "0F": [0x0F, 0x00, 0xFF],
      "06": [0x06, 0x00, 0x00],
      "0E": [0x0E, 0x55, 0x55],
      "F0": [0xF0, 0xAC, 0xCA],
      "05": [0x05, 0x00, 0x00],
      "EF": [0xEF, 0x00, 0x00],
      "A0": [0xA0, 0x50, 0x5A],
    }[key];
    if (r) mock4.rx(replyWith(r));
  }, 5);
  return p;
};
dut.attach("c4", "w6729");

let r = await dut.runCommand("c4", "freq_query");
assert(r.verdict === "PASS", `freq_query PASS (got ${r.verdict}${r.failedChecks ? " — " + r.failedChecks : ""})`);
assert(r.frames.length === 2 && r.frames[0].bytes.join() === "15,4,0,236", "帧1=回显原帧");

r = await dut.runCommand("c4", "instruction");
assert(r.verdict === "PASS", `instruction PASS (got ${r.verdict})`);

r = await dut.runCommand("c4", "ram");
assert(r.verdict === "PASS", `ram 两段握手+双结果 PASS (got ${r.verdict}${r.failedChecks ? " — " + r.failedChecks : ""})`);

r = await dut.runCommand("c4", "crc");
assert(r.verdict === "PASS", `crc PASS (got ${r.verdict})`);

r = await dut.runCommand("c4", "uart0_echo");
assert(r.verdict === "PASS", `uart0_echo(含0x5A回显) PASS (got ${r.verdict}${r.failedChecks ? " — " + r.failedChecks : ""})`);
assert(r.extras.includes(0x5A), "0x5A 出现在额外字节");

// FAIL path: instruction 错误返回 — use a FRESH session to avoid leftover frame state
const mockFail = new MockSerial();
const dutFail = new DutManager(mockFail);
const origWriteF = mockFail.write.bind(mockFail);
let nF = 0;
mockFail.write = (id, hex) => {
  const p = origWriteF(id, hex);
  nF++;
  setTimeout(() => {
    if (nF === 1) mockFail.rx(Buffer.from(hex, "hex"));
    else if (hex.startsWith("06")) mockFail.rx(Buffer.from(replyWith([0x06, 0x01, 0x00])));
  }, 5);
  return p;
};
dutFail.attach("cf", "w6729");
r = await dutFail.runCommand("cf", "instruction");
assert(r.verdict === "FAIL", `instruction 错误结果判定 FAIL (got ${r.verdict}${r.failedChecks ? " — " + r.failedChecks : ""})`);
dutFail.detach("cf");

// TIMEOUT path: 完全无应答
mock4.write = (id, hex) => origWrite(id, hex);
const t0 = Date.now();
r = await dut.runCommand("c4", "freq_query");
assert(r.verdict === "TIMEOUT" && Date.now() - t0 >= 700, `无应答判定 TIMEOUT (got ${r.verdict})`);

// ── 5. smoke over mock ──
for (const k of Object.keys(writeCount)) delete writeCount[k];
mock4.write = (id, hex) => {
  const p = origWrite(id, hex);
  writeCount[hex] = (writeCount[hex] || 0) + 1;
  const n = writeCount[hex];
  setTimeout(() => {
    if (hex.length === 2) { mock4.rx(Buffer.from(hex, "hex")); return; }
    if (n === 1) { mock4.rx(Buffer.from(hex, "hex")); return; }
    const key = hex.slice(0, 2);
    if (key === "03") {
      if (n === 2) mock4.rx(replyWith([0x03, 0x00, 0x00]));
      else if (n === 3) mock4.rx(replyWith([0x03, 0xCB, 0x00]));
      return;
    }
    const m = { "0F": [0x0F, 0x00, 0xFF], "06": [0x06, 0x00, 0x00], "0E": [0x0E, 0x55, 0x55], "F0": [0xF0, 0xAC, 0xCA], "05": [0x05, 0x00, 0x00], "EF": [0xEF, 0x00, 0x00], "A0": [0xA0, 0x50, 0x5A] }[key];
    if (m) mock4.rx(replyWith(m));
  }, 5);
  return p;
};
const smoke = await dut.runSmoke("c4");
assert(smoke.steps.length === 7, `smoke 序列7步 (got ${smoke.steps.length})`);
console.log(`smoke: PASS=${smoke.passed} FAIL=${smoke.failed} REPORT=${smoke.report}`);
assert(smoke.allPassed, "smoke 整体通过");

console.log("\n=== 全部离线测试完成 ===");
