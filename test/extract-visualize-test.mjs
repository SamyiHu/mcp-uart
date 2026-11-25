/**
 * Offline tests for extract paths, message filters, and visualize HTML.
 */
import { extractFromMessages, extractFromObject } from "../dist/extract.js";
import { SerialManager } from "../dist/serial-manager.js";
import { renderTimelineHtml, renderSmokeHtml } from "../dist/visualize.js";

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

const msgs = [
  { timestamp: "2026-01-01T00:00:00.000Z", connectionId: "c1", data: "AA", raw: "4141", length: 2, direction: "tx" },
  { timestamp: "2026-01-01T00:00:00.100Z", connectionId: "c1", data: "OK", raw: "4F4B", length: 2, direction: "rx" },
  { timestamp: "2026-01-01T00:00:00.200Z", connectionId: "c1", data: "PING", raw: "50494E47", length: 4, direction: "rx" },
];

assert(extractFromMessages(msgs, "last.raw") === "50494E47", "last.raw");
assert(extractFromMessages(msgs, "messages[0].data") === "AA", "messages[0].data");
assert(extractFromMessages(msgs, "messages[-1].length") === 4, "messages[-1].length");
assert(extractFromMessages(msgs, "rx.count") === 2, "rx.count");
assert(extractFromMessages(msgs, "tx.count") === 1, "tx.count");
assert(extractFromMessages(msgs, "totalBytes") === 8, "totalBytes");
assert(extractFromMessages(msgs, "rxHex") === "4F4B50494E47", "rxHex");
assert(extractFromMessages(msgs, "rxText") === "OK\nPING", "rxText");

const filtered = SerialManager.applyFilter(msgs, { direction: "rx", matchText: "PING" });
assert(filtered.length === 1 && filtered[0].data === "PING", "filter direction+matchText");
assert(SerialManager.applyFilter(msgs, { matchHex: "50494E" }).length === 1, "filter matchHex");
assert(SerialManager.applyFilter(msgs, { lastOnly: true }).length === 1, "filter lastOnly");
assert(SerialManager.applyFilter(msgs, { minLength: 4 }).length === 1, "filter minLength");

const run = {
  command: "io_output",
  title: "t",
  verdict: "PASS",
  sent: ["0F1555A0"],
  frames: [
    { bytes: [0x0f, 0x15, 0x55, 0xa0], timestamp: "t1" },
    { bytes: [0x0f, 0x15, 0x55, 0xa1], timestamp: "t2" },
  ],
  extras: [],
  failedChecks: [],
  elapsedMs: 12,
};
assert(extractFromObject(run, "verdict") === "PASS", "extract verdict");
assert(extractFromObject(run, "frames[1].bytes[2]") === 0x55, "extract frames[1].bytes[2]");
assert(extractFromObject(run, "frames[-1].bytes[0]") === 0x0f, "extract frames[-1].bytes[0]");
assert(extractFromObject(run, "frames.length") === 2, "extract frames.length");
assert(extractFromObject(run, "sent.0") === "0F1555A0", "extract sent.0");

const html = renderTimelineHtml({ title: "T", meta: "m", messages: msgs });
assert(
  html.includes("TX") && html.includes("RX") && html.includes("50 49 4E 47"),
  "timeline html contains frames"
);

const smoke = renderSmokeHtml({
  profile: "frame-demo",
  steps: [run],
  passed: 1,
  failed: 0,
  report: 0,
  allPassed: true,
});
assert(smoke.includes("PASS") && smoke.includes("io_output"), "smoke html");

console.log("\nextract/filter/visualize offline tests done");
