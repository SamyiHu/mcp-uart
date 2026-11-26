// IDLE 唤醒定时判别：发 0x01 进 IDLE 后高频轮询，测 Orchestrator 首次应答延迟。
// 判据：~15.6ms 边界 → BTM 真唤醒；<3ms → IDLE 根本没睡；>500ms → BTM 周期档配错。
import { SerialPort } from "serialport";

const port = process.argv[2] || "COM7";
const baud = Number(process.argv[3] || 727000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDLE = Buffer.from([0x01, 0x00, 0x00, 0xfe]);
const PROBE = Buffer.from([0x0f, 0x04, 0x00, 0xec]);

const p = new SerialPort({ path: port, baudRate: baud, autoOpen: false });
let rx = [];
let firstRxAt = null;
let t0 = 0;
p.on("data", (d) => {
  if (firstRxAt === null) firstRxAt = Date.now();
  rx.push(d);
});

p.open(async (err) => {
  if (err) { console.error("open fail:", err.message); process.exit(1); }
  await sleep(150);

  // 清状态
  firstRxAt = null; rx = [];
  t0 = Date.now();
  p.write(IDLE);
  // 等 IDLE 命令回显过去（这本身是字节，会触发 firstRxAt —— 需要区分回显与唤醒后应答）
  await sleep(8); // 8ms: 回显 4B@727k ≈ 55µs，早已到
  const echoSeen = firstRxAt !== null;
  rx = []; firstRxAt = null;
  const tIdle = Date.now();
  console.log(`[t=0] IDLE 命令已发，回显${echoSeen ? "正常" : "未见"}`);

  // 高频轮询: 每 1.5ms 发探活帧
  for (let i = 0; i < 400; i++) {
    p.write(PROBE);
    await sleep(1.5);
    if (firstRxAt !== null) break;
  }
  const wakeDelay = firstRxAt !== null ? firstRxAt - tIdle : null;
  const got = Buffer.concat(rx).toString("hex").toUpperCase();
  console.log(`首次应答延迟: ${wakeDelay === null ? "无（未醒）" : wakeDelay + " ms"}`);
  console.log(`收到的字节: ${got.slice(0, 60) || "(无)"}`);

  if (wakeDelay === null) {
    console.log("\n>>> 判定: 未唤醒 ✗");
  } else if (wakeDelay < 3) {
    console.log("\n>>> 判定: <3ms 即应答 → IDLE 根本没有睡眠（时钟未停）");
  } else if (wakeDelay > 10 && wakeDelay < 25) {
    console.log("\n>>> 判定: ≈15.6ms → BTM 真实唤醒 IDLE ✓（1个BTM周期）");
  } else if (wakeDelay >= 25 && wakeDelay < 70) {
    console.log("\n>>> 判定: 25~70ms → BTM 多周期唤醒（周期偏长或错过首个沿）");
  } else {
    console.log(`\n>>> 判定: ${wakeDelay}ms → 偏长，BTM 周期档可疑（15.625ms 假设不符）`);
  }
  p.close();
  process.exit(0);
});
