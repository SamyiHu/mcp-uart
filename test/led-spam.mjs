// Spam the LED-ON command so the Orchestrator keeps re-entering the LED test
// (the test exits as soon as any 4 RX bytes arrive, so it must be retriggered).
import { SerialPort } from "serialport";

const port = process.argv[2] || "COM7";
const baud = Number(process.argv[3] || 757500);
const ms = Number(process.argv[4] || 40000);
const p1 = Number(process.argv[5] ?? 0xff);
const p2 = Number(process.argv[6] ?? 0x1f);

const frame = Buffer.from([0x91, p1, p2, (0xff - ((0x91 + p1 + p2) & 0xff)) & 0xff]);
const p = new SerialPort({ path: port, baudRate: baud, autoOpen: false });

p.open((err) => {
  if (err) {
    console.error("open fail:", err.message);
    process.exit(1);
  }
  console.error("LED spam start, frame =", frame.toString("hex").toUpperCase());
  let n = 0;
  const t = setInterval(() => {
    p.write(frame);
    n++;
  }, 30);
  setTimeout(() => {
    clearInterval(t);
    console.error("sent", n, "frames");
    p.close();
  }, ms);
});
