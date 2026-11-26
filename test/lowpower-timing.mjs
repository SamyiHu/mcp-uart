// 低功耗时序测试：发命令后轮询，测出 Orchestrator 静默多久后恢复
// 0x07 = WDT+STOP（WDT 500ms 溢出复位）; 0x0A = BTM+STOP
import { SerialPort } from "serialport";

const port = process.argv[2] || "COM7";
const baud = Number(process.argv[3] || 727000);
const cmd = parseInt(process.argv[4] || "7", 16);
const p1 = parseInt(process.argv[5] || "1", 16);
const label = process.argv[6] || "WDT+STOP";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = (c, a, b) => Buffer.from([c, a, b, (0xff - ((c + a + b) & 0xff)) & 0xff]);

const p = new SerialPort({ path: port, baudRate: baud, autoOpen: false });
let rx = Buffer.alloc(0);
p.on("data", (d) => { rx = Buffer.concat([rx, d]); });

p.open(async (err) => {
  if (err) { console.error("open fail:", err.message); process.exit(1); }
  await sleep(150);

  // 基线
  rx = Buffer.alloc(0);
  p.write(frame(0x0f, 0x04, 0x00)); await sleep(120);
  p.write(frame(0x0f, 0x04, 0x00)); await sleep(200);
  console.log("基线探活:", rx.toString("hex").toUpperCase().includes("0F00") ? "存活 ✓" : "无应答 ✗");

  const t0 = Date.now();
  rx = Buffer.alloc(0);
  p.write(frame(cmd, p1, 0x00));
  await sleep(120);
  console.log(`[t=${Date.now()-t0}ms] 发 ${label} 命令=${frame(cmd,p1,0).toString("hex").toUpperCase()}，回显=${rx.toString("hex").toUpperCase()}`);

  // 轮询探活
  let recoveredAt = null;
  for (let i = 0; i < 30; i++) {
    const b = rx.length;
    p.write(frame(0x0f, 0x04, 0x00));
    await sleep(110);
    p.write(frame(0x0f, 0x04, 0x00));
    await sleep(140);
    const seg = rx.subarray(b).toString("hex").toUpperCase();
    if (seg.includes("0F00")) { recoveredAt = Date.now() - t0; console.log(`[t=${recoveredAt}ms] 恢复应答 ✓  ${seg}`); break; }
    if (i === 5) console.log(`[t=${Date.now()-t0}ms] 仍静默（符合已进 STOP）`);
  }
  if (recoveredAt === null) console.log(`[t=${Date.now()-t0}ms] 30 次轮询内未恢复 ✗ → Orchestrator 仍卡在 STOP`);
  console.log(`\n>>> ${label}: ${recoveredAt !== null ? `静默约 ${recoveredAt}ms 后恢复` : "未恢复（需复位）"}`);
  p.close();
  process.exit(0);
});
