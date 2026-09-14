/**
 * CLI driver for the DUT protocol layer — same code path as the dut_* MCP
 * tools (SerialManager + DutManager + profile), for use before the MCP is
 * (re)loaded in the client.
 *
 * Usage:
 *   node test/dut-run.mjs COM7 smoke            # FPGA smoke sequence
 *   node test/dut-run.mjs COM7 smoke --lp       # + STOP/WDT wake tests
 *   node test/dut-run.mjs COM7 test instruction # single named test
 *   node test/dut-run.mjs COM7 cmd 0F 04 00     # raw framed command
 */
import { SerialManager } from "../dist/serial-manager.js";
import { DutManager, formatRun } from "../dist/dut/manager.js";

const [port, mode, ...rest] = process.argv.slice(2);
if (!port || !mode) {
  console.error("usage: node test/dut-run.mjs <COMx> <smoke|test|cmd> [...]");
  process.exit(2);
}

const serial = new SerialManager();
const dut = new DutManager(serial);

const open = await serial.open({
  path: port,
  baudRate: 727000,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
  encoding: "hex",
  protocol: "raw",
  bufferSize: 4000,
  autoReconnect: false,
  dtr: true,
  rts: true,
});
dut.attach(open.connectionId, "w6729");
console.log(`[connected] ${port} @727000 8N1, id=${open.connectionId}`);

try {
  if (mode === "smoke") {
    const lp = rest.includes("--lp");
    // quick alive check first
    const alive = await dut.runCommand(open.connectionId, "freq_query");
    console.log(formatRun(alive) + "\n");
    if (alive.verdict === "TIMEOUT") {
      console.error("!! DUT 无应答：检查接线(TX→P2.1,RX→P2.0)、供电、波特率(32M/727000)");
      process.exit(1);
    }
    const r = await dut.runSmoke(open.connectionId, lp);
    console.log(`=== DUT smoke (w6729) ===`);
    for (const s of r.steps) {
      const mark = s.verdict === "PASS" ? "✓" : s.verdict === "FAIL" ? "✗" : s.verdict === "TIMEOUT" ? "⏱" : "○";
      console.log(`${mark} ${s.command.padEnd(20)} ${s.verdict}  ${s.failedChecks.length ? "— " + s.failedChecks.join("; ") : ""}`);
    }
    console.log(`\n总计 ${r.steps.length} 项 — PASS ${r.passed} / FAIL+T ${r.failed} / REPORT ${r.report} → ${r.allPassed ? "整体通过 ✓" : "存在失败项 ✗"}`);
    for (const s of r.steps.filter(s => s.verdict !== "PASS")) {
      console.log("\n" + formatRun(s));
    }
    process.exitCode = r.allPassed ? 0 : 1;
  } else if (mode === "test") {
    const [name, ...ov] = rest;
    const o = {};
    if (ov[0] !== undefined) o.cmd = parseInt(ov[0], 16);
    if (ov[1] !== undefined) o.p1 = parseInt(ov[1], 16);
    if (ov[2] !== undefined) o.p2 = parseInt(ov[2], 16);
    const r = await dut.runCommand(open.connectionId, name, o);
    console.log(formatRun(r));
    process.exitCode = r.verdict === "FAIL" || r.verdict === "TIMEOUT" ? 1 : 0;
  } else if (mode === "cmd") {
    const [c, p1 = "00", p2 = "00", n = "1"] = rest;
    const session = dut.getSession(open.connectionId);
    session.reset();
    const sent = await session.sendFrame(parseInt(c, 16), parseInt(p1, 16), parseInt(p2, 16));
    const got = await session.waitForFrames(parseInt(n, 16), 3000);
    const { frames, extras } = session.snapshot();
    console.log(`发送: ${sent}`);
    console.log(`回帧(${got}): ${frames.map(f => f.bytes.map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")).join("  |  ") || "(无)"}`);
    if (extras.length) console.log(`额外字节: ${extras.map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")}`);
  }
} finally {
  dut.detach(open.connectionId);
  await serial.close(open.connectionId);
}
