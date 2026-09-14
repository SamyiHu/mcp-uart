// Low-power wake test for W6729: the adapter's TX drives P2.1 (= INT25),
// so transmitting any byte creates the falling edge that wakes STOP.
import { SerialPort } from "serialport";

const port = process.argv[2] || "COM7";
const baud = Number(process.argv[3] || 757500);
const stopCmdHex = process.argv[4] || "020100fc"; // 0x02 STOP, 1 entry, IO level 0
const label = process.argv[5] || "STOP";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = (cmd, p1, p2) =>
  Buffer.from([cmd, p1, p2, (0xff - ((cmd + p1 + p2) & 0xff)) & 0xff]);

const p = new SerialPort({ path: port, baudRate: baud, autoOpen: false });
let rx = Buffer.alloc(0);
p.on("data", (d) => { rx = Buffer.concat([rx, d]); });

p.open(async (err) => {
  if (err) { console.error("open fail:", err.message); process.exit(1); }
  await sleep(100);

  // 1) 下发低功耗命令
  rx = Buffer.alloc(0);
  const c = Buffer.from(stopCmdHex, "hex");
  p.write(c);
  console.log(`[1] 发送 ${label} 命令: ${c.toString("hex").toUpperCase()}`);
  await sleep(300);
  console.log(`    期间收到: ${rx.toString("hex").toUpperCase() || "(无)"}  ← 回显`);

  // 2) 发唤醒字节：起始位 = P2.1 下降沿
  const before = rx.length;
  p.write(Buffer.from([0xff]));
  console.log(`[2] 发送唤醒字节 FF (P2.1 下降沿)`);
  await sleep(600);
  console.log(`    唤醒后收到: ${rx.subarray(before).toString("hex").toUpperCase() || "(无)"}`);

  // 3) 探活：freq_query 两段式
  const b2 = rx.length;
  p.write(frame(0x0f, 0x04, 0x00));
  await sleep(250);
  const echo = rx.subarray(b2).toString("hex").toUpperCase();
  p.write(frame(0x0f, 0x04, 0x00));
  await sleep(400);
  const all = rx.subarray(b2).toString("hex").toUpperCase();
  console.log(`[3] 探活: 第一段=${echo}  全部=${all}`);
  const ok = all.includes("0F00");
  console.log(`\n>>> ${label} 唤醒${ok ? "成功 ✓ (DUT 复位后正常应答)" : "失败 ✗ (无应答)"}`);

  p.close();
  process.exit(ok ? 0 : 1);
});
