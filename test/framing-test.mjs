/**
 * Framing tests: a frame must be a complete line / delimited frame, never an
 * arbitrary USB read chunk.
 *
 * The regression this pins down: with protocol "raw" every serial `data` event
 * became one frame, so one logical message arrived split into several rows and
 * the console looked like it was slicing by time.
 */
import { createParser } from "../dist/protocols.js";

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

/** Feed byte chunks through a parser and collect the frames it emits. */
function collect(parser, chunks) {
  return new Promise((resolve, reject) => {
    const frames = [];
    parser.on("data", (buf) => frames.push(buf.toString("utf8")));
    parser.on("error", reject);
    parser.on("end", () => resolve(frames));
    for (const chunk of chunks) parser.write(Buffer.from(chunk, "utf8"));
    parser.end();
  });
}

const cfg = (over) => ({ protocol: "line", baudRate: 115200, encoding: "utf8", ...over });

async function main() {
  // ── line: CRLF / LF / CR all split, and a chunk boundary does not ──
  let frames = await collect(createParser(cfg()), ["alpha\r\nbeta\r\ngamma"]);
  assert(
    JSON.stringify(frames) === JSON.stringify(["alpha", "beta", "gamma"]),
    `line splits on CRLF and keeps a trailing unterminated line (got ${JSON.stringify(frames)})`,
  );

  frames = await collect(createParser(cfg()), ["one\n", "two\n"]);
  assert(JSON.stringify(frames) === JSON.stringify(["one", "two"]), `LF-only device splits (got ${JSON.stringify(frames)})`);

  frames = await collect(createParser(cfg()), ["a\rb\r"]);
  assert(JSON.stringify(frames) === JSON.stringify(["a", "b"]), `CR-only device splits (got ${JSON.stringify(frames)})`);

  // The important one: one logical line delivered in three USB chunks must be
  // ONE frame, not three.
  frames = await collect(createParser(cfg()), ["TEMP=2", "7.5C VDD", "=3.30V\r\n"]);
  assert(
    JSON.stringify(frames) === JSON.stringify(["TEMP=27.5C VDD=3.30V"]),
    `a line split across chunks is rejoined into one frame (got ${JSON.stringify(frames)})`,
  );

  // CRLF must not produce an empty frame between the CR and the LF.
  frames = await collect(createParser(cfg()), ["x\r\n\r\ny\r\n"]);
  assert(JSON.stringify(frames) === JSON.stringify(["x", "y"]), `blank lines are dropped (got ${JSON.stringify(frames)})`);

  // ── raw: still one frame per chunk (documented behaviour, now opt-in) ──
  assert(createParser(cfg({ protocol: "raw" })) === null, "raw mode installs no parser (chunk == frame)");

  // ── delimiter: custom hex terminator ──
  frames = await collect(createParser(cfg({ protocol: "delimiter", delimiter: "00" })), ["aa\u0000bb\u0000"]);
  assert(
    JSON.stringify(frames) === JSON.stringify(["aa", "bb"]),
    `delimiter mode splits on the configured byte (got ${JSON.stringify(frames)})`,
  );

  // ── hex-frame: start/end markers, junk between frames ignored ──
  const hexFrames = await new Promise((resolve, reject) => {
    const parser = createParser(cfg({ protocol: "hex-frame", frameStart: "AA55", frameEnd: "0D0A" }));
    const out = [];
    parser.on("data", (buf) => out.push(buf.toString("hex").toUpperCase()));
    parser.on("error", reject);
    parser.write(Buffer.from("FFFFAA5501020304" + "0D0A", "hex"));
    parser.write(Buffer.from("AA55AABB0D0A", "hex"));
    setTimeout(() => resolve(out), 50);
  });
  assert(
    JSON.stringify(hexFrames) === JSON.stringify(["01020304", "AABB"]),
    `hex-frame extracts payloads between markers (got ${JSON.stringify(hexFrames)})`,
  );

  console.log("\n=== framing tests done ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
