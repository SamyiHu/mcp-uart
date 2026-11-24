/**
 * Throughput guard for the frame path.
 *
 * The console used to stutter because every frame copied the whole buffer:
 * `frames.slice(-max)` in the Hub, `messages.slice(-max)` in the serial manager
 * and `frames.slice(-4000)` in the UI. This test pushes a burst through the Hub
 * and fails if the buffers are not capped or the run is pathologically slow.
 */
import { createHub } from "../dist/hub/server.js";
import { FakeHubBackend } from "./helpers/fake-hub-backend.mjs";

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

async function main() {
  const backend = new FakeHubBackend();
  const hub = await createHub({ backend, host: "127.0.0.1", port: 0, maxFrames: 2000 });
  const base = hub.url;

  const opened = await (
    await fetch(`${base}/api/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "COM1", baudRate: 921600, encoding: "utf8", protocol: "line" }),
    })
  ).json();
  const id = opened.connectionId;

  const BURST = 5000;
  const payload = "PV=0123mV\r\n";
  const raw = Buffer.from(payload, "utf8").toString("hex").toUpperCase();

  const started = Date.now();
  for (let i = 0; i < BURST; i += 1) {
    backend.emit(id, {
      timestamp: new Date().toISOString(),
      connectionId: id,
      data: payload,
      raw,
      length: payload.length,
      direction: "rx",
    });
  }
  const elapsed = Date.now() - started;

  const health = await (await fetch(`${base}/api/health`)).json();
  assert(health.ok === true, "hub still answers after the burst");
  assert(elapsed < 4000, `${BURST} frames pushed in ${elapsed}ms (budget 4000ms)`);

  const replay = await (await fetch(`${base}/api/frames?limit=10`)).json();
  assert(replay.seq === BURST, `seq counts every frame (got ${replay.seq})`);
  assert(replay.frames.length === 10, "replay buffer stays queryable");

  const history = await (await fetch(`${base}/api/history?limit=1`)).json();
  assert(history.total === BURST, `history keeps the whole burst (got ${history.total})`);

  // The replay buffer must be capped (2000 + headroom), not grow with the burst.
  const capped = await (await fetch(`${base}/api/health`)).json();
  assert(capped.frameCount <= 2000 + 256, `replay buffer capped (got ${capped.frameCount})`);

  await hub.close();
  console.log("\n=== perf tests done ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
