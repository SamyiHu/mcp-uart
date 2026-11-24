/**
 * Encoding + display fidelity tests (offline, no hardware).
 *
 * Two regressions this pins down:
 *  1. The Hub decodes frames with the connection's encoding (iconv-lite), so a
 *     GBK device must arrive as real Chinese text.
 *  2. The console's ASCII column must RENDER that text. It used to keep only
 *     0x20-0x7E and replace everything else with ".", which turned every CJK
 *     frame into ".." and made GBK look broken.
 */
import iconv from "iconv-lite";
import { createHub } from "../dist/hub/server.js";
import { FakeHubBackend } from "./helpers/fake-hub-backend.mjs";

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

/** Mirror of the UI's asciiOf(): keep printable glyphs, dot real controls only. */
function asciiOf(text) {
  let out = "";
  for (const character of String(text ?? "")) {
    const code = character.codePointAt(0);
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfffd;
    out += control ? "." : character;
  }
  return out;
}

async function main() {
  // ── 1. iconv round-trip: the backend really understands GBK ──
  const chinese = "温度过高，请检查散热";
  const gbk = iconv.encode(chinese, "gbk");
  assert(gbk.length === chinese.length * 2, "GBK encodes each CJK char as 2 bytes");
  assert(iconv.decode(gbk, "gbk") === chinese, "GBK decode round-trips");
  assert(iconv.decode(iconv.encode("中", "gb2312"), "gb2312") === "中", "GB2312 round-trips");
  assert(iconv.decode(iconv.encode("中", "gb18030"), "gb18030") === "中", "GB18030 round-trips");

  // ── 2. the display layer must not eat it ──
  assert(asciiOf(chinese) === chinese, "console shows CJK text verbatim");
  assert(asciiOf("a\r\nb") === "a..b", "control characters still render as dots");
  assert(asciiOf("Ω≈ç") === "Ω≈ç", "non-ASCII Latin/symbols survive");
  assert(asciiOf("\uFFFD") === ".", "replacement char (bad decode) shows as a dot");

  // ── 3. end-to-end through the Hub with a GBK connection ──
  const backend = new FakeHubBackend();
  const hub = await createHub({ backend, host: "127.0.0.1", port: 0 });
  const base = hub.url;

  const open = await (
    await fetch(`${base}/api/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "COM1", baudRate: 115200, encoding: "gbk" }),
    })
  ).json();
  assert(open.ok === true, "connect with encoding=gbk succeeds");

  // Simulate the device: bytes are GBK, decoded by the backend with the
  // connection's encoding, exactly as a real port would.
  const id = open.connectionId;
  const payload = Buffer.from(gbk);
  backend.emit(id, {
    timestamp: new Date().toISOString(),
    connectionId: id,
    data: iconv.decode(payload, "gbk"),
    raw: payload.toString("hex").toUpperCase(),
    length: payload.length,
    direction: "rx",
  });

  const frames = await (await fetch(`${base}/api/frames?limit=5`)).json();
  const frame = frames.frames.at(-1);
  assert(frame.data === chinese, `Hub delivers decoded GBK text (got ${JSON.stringify(frame.data)})`);
  assert(asciiOf(frame.data) === chinese, "console renders the decoded GBK text");
  assert(frame.raw.length === gbk.length * 2, "raw hex keeps the original bytes");

  // ── 4. live encoding switch reaches the backend ──
  const switched = await (
    await fetch(`${base}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encoding: "utf8" }),
    })
  ).json();
  assert(switched.ok === true && switched.info.config.encoding === "utf8", "POST /api/config switches encoding live");

  const status = await (await fetch(`${base}/api/status`)).json();
  assert(status.active.config.encoding === "utf8", "status reflects the new encoding");

  await hub.close();
  console.log("\n=== encoding tests done ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
