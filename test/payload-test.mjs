/**
 * Message payload shape tests.
 *
 * Regression: a connection opened with `encoding: "hex"` (the DUT profile path
 * did exactly that) returns `data` as a HEX STRING identical to `raw`. The
 * console then printed hex twice and the real text never appeared. This pins
 * both halves: the backend must hand back decoded text, and the console must
 * still cope when it is handed hex.
 */
import { dutSerialConfig } from "../dist/hub/dut-backend.js";
import { decode } from "../dist/encodings.js";

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

/** Mirror of the console's textOf(): if data is the same hex as raw, decode it. */
function textOf(frame) {
  const data = String(frame?.data ?? "");
  const raw = String(frame?.raw ?? "");
  const looksHex = data.length > 0 && /^[0-9A-Fa-f]+$/.test(data) && data.length === raw.length;
  if (!looksHex || raw.length % 2 !== 0) return data;
  const bytes = new Uint8Array(raw.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function main() {
  // The exact frame from the user's report.
  const raw = "4C4952435F4F66663A457272";
  const expected = "LIRC_Off:Err";

  // ── 1. what the backend produces for each encoding ──
  const bytes = Buffer.from(raw, "hex");
  assert(decode(bytes, "hex") === raw, "encoding=hex makes data identical to raw (the bug)");
  assert(decode(bytes, "utf8") === expected, `encoding=utf8 makes data readable text (got ${decode(bytes, "utf8")})`);

  // ── 2. the DUT profile connection must no longer use hex ──
  const cfg = dutSerialConfig("COM6", Object.keys(profileNames())[0] ?? "w6729");
  assert(cfg.encoding !== "hex", `dut_connect uses a text encoding, not hex (got ${cfg.encoding})`);

  // ── 3. the console repairs a legacy hex-shaped frame ──
  assert(textOf({ data: raw, raw }) === expected, `console decodes a hex-shaped frame to text (got ${textOf({ data: raw, raw })})`);

  // ── 4. normal frames are left alone ──
  assert(textOf({ data: expected, raw }) === expected, "already-decoded text is not re-decoded");
  assert(textOf({ data: "123", raw: "313233" }) === "123", "a short numeric string is not mistaken for hex");
  assert(textOf({ data: "温度", raw: "E6B8A9E5BAA6" }) === "温度", "CJK text passes through unchanged");

  console.log("\n=== payload shape tests done ===");
}

/** Profile names are only used to build a config; any known name works. */
function profileNames() {
  try {
    return { w6729: true };
  } catch {
    return {};
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
