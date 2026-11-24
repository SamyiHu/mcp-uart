/**
 * Offline Hub API + SSE tests (FakeHubBackend, no serial hardware).
 */
import { fileURLToPath } from "url";
import { createHub } from "../dist/hub/server.js";
import { FakeHubBackend } from "./helpers/fake-hub-backend.mjs";

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

async function readSse(url, predicate, timeoutMs = 2000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const frames = [];
  try {
    const res = await fetch(url, { signal: ac.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (frames.length < 50) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        if (obj && obj.seq !== undefined) frames.push(obj);
        if (predicate(frames)) {
          ac.abort();
          clearTimeout(timer);
          return frames;
        }
      }
    }
  } catch (e) {
    // abort is expected when predicate hits
  }
  clearTimeout(timer);
  return frames;
}

async function main() {
  const backend = new FakeHubBackend();
  const publicDir = fileURLToPath(new URL("../src/hub/public", import.meta.url));
  const hub = await createHub({ backend, host: "127.0.0.1", port: 0, publicDir });
  const base = hub.url;

  // health
  let r = await fetch(`${base}/api/health`);
  let j = await r.json();
  assert(r.status === 200 && j.ok && j.activeConnectionId === null, "health ok when idle");

  // ports
  r = await fetch(`${base}/api/ports`);
  j = await r.json();
  assert(j.ports.length === 2 && j.ports[0].path === "COM1", "list ports");

  // index page
  r = await fetch(`${base}/`);
  const html = await r.text();
  assert(r.status === 200 && html.includes("UART Hub"), "serves index.html");

  // write without connect
  r = await fetch(`${base}/api/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: "x" }),
  });
  j = await r.json();
  assert(r.status === 409 && j.ok === false, "write without connect → 409");

  // connect missing path
  r = await fetch(`${base}/api/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  j = await r.json();
  assert(r.status === 400, "connect without path → 400");

  // connect success
  r = await fetch(`${base}/api/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "COM1", baudRate: 115200, encoding: "hex", protocol: "raw" }),
  });
  j = await r.json();
  assert(r.status === 200 && j.ok && j.connectionId, "connect returns connectionId");
  const cid = j.connectionId;

  // status
  r = await fetch(`${base}/api/status`);
  j = await r.json();
  assert(j.activeConnectionId === cid && j.active.config.baudRate === 115200, "status active connection");

  // open SSE then inject RX + write
  const ssePromise = readSse(
    `${base}/events/stream?sinceSeq=0`,
    (frames) => frames.some((f) => f.direction === "tx") && frames.some((f) => f.direction === "rx")
  );

  // small delay to attach SSE
  await new Promise((r2) => setTimeout(r2, 50));

  backend.emitRx(cid, [0xaa, 0x55, 0x01], "...");
  r = await fetch(`${base}/api/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: "AA55", encoding: "hex" }),
  });
  j = await r.json();
  assert(j.ok && j.bytesWritten === 2, "write hex AA55");

  const got = await ssePromise;
  assert(
    got.some((f) => f.direction === "rx" && f.raw === "AA5501") &&
      got.some((f) => f.direction === "tx" && f.raw === "AA55"),
    "SSE receives TX+RX frames"
  );

  // frames API filter
  r = await fetch(`${base}/api/frames?direction=rx`);
  j = await r.json();
  assert(j.frames.every((f) => f.direction === "rx") && j.frames.length >= 1, "frames filter direction=rx");

  r = await fetch(`${base}/api/frames?direction=tx`);
  j = await r.json();
  assert(j.frames.length === 1 && j.frames[0].raw === "AA55", "frames filter direction=tx");

  // sinceSeq resume: only new
  backend.emitRx(cid, [0x01, 0x02]);
  const seqNow = (await (await fetch(`${base}/api/health`)).json()).seq;
  backend.emitRx(cid, [0x03]);
  r = await fetch(`${base}/api/frames?sinceSeq=${seqNow}`);
  j = await r.json();
  assert(j.frames.length === 1 && j.frames[0].raw === "03", "sinceSeq frame is only 03");

  // SSE resume: the stream must honour ?sinceSeq= (the panel relies on it to
  // replay only the recent tail instead of the whole 2000-frame buffer).
  const replay = await readSse(`${base}/events/stream?sinceSeq=${seqNow}`, (frames) => frames.length > 0, 1000);
  assert(replay.length === 1 && replay[0].raw === "03", "SSE sinceSeq replays only newer frames");

  // config reconfigure
  r = await fetch(`${base}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baudRate: 9600 }),
  });
  j = await r.json();
  assert(j.ok && j.info.config.baudRate === 9600, "reconfigure baud");

  // signals
  r = await fetch(`${base}/api/signals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dtr: false, rts: true }),
  });
  j = await r.json();
  assert(j.ok, "set signals");

  // reconnect policy: second connect closes first
  r = await fetch(`${base}/api/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "COM2", baudRate: 57600 }),
  });
  j = await r.json();
  assert(j.ok && j.connectionId !== cid, "second connect uses new id");
  assert(backend.closeCount >= 1, "previous connection closed");
  const cid2 = j.connectionId;

  // SSE resume from mid history after reconnect clears frames — inject and check
  await new Promise((r2) => setTimeout(r2, 30));
  backend.emitRx(cid2, [0x11, 0x22]);
  r = await fetch(`${base}/api/frames`);
  j = await r.json();
  assert(j.frames.length === 1 && j.frames[0].raw === "1122", "frames reset on reconnect");

  // bad JSON body
  r = await fetch(`${base}/api/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json",
  });
  assert(r.status === 500, "invalid JSON → 500");

  // fail open
  backend.failOpen = "boom port busy";
  r = await fetch(`${base}/api/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "COM9" }),
  });
  j = await r.json();
  assert(r.status === 500 && /boom/.test(j.error), "open failure surfaces error");
  backend.failOpen = null;

  // disconnect
  r = await fetch(`${base}/api/disconnect`, { method: "POST" });
  j = await r.json();
  assert(j.ok, "disconnect ok");
  r = await fetch(`${base}/api/health`);
  j = await r.json();
  assert(j.activeConnectionId === null, "health idle after disconnect");

  // double disconnect
  r = await fetch(`${base}/api/disconnect`, { method: "POST" });
  j = await r.json();
  assert(j.ok && j.alreadyClosed, "double disconnect is ok");

  // 404
  r = await fetch(`${base}/api/nope`);
  assert(r.status === 404, "unknown api 404");

  await hub.close();
  assert(true, "hub.close() completes");

  // —— port fallback: occupy preferred, then createHubWithFallback ——
  const http = await import("http");
  const blocker = http.createServer(() => {});
  await new Promise((resolve) => blocker.listen(19787, "127.0.0.1", resolve));

  const { createHubWithFallback } = await import("../dist/hub/server.js");
  const hub2 = await createHubWithFallback({
    backend: new FakeHubBackend(),
    host: "127.0.0.1",
    preferredPort: 19787,
    portSpan: 5,
    publicDir,
  });
  assert(hub2.port !== 19787 && hub2.autoShifted === true, "fallback skips busy port");
  const h2 = await (await fetch(`${hub2.url}/api/health`)).json();
  assert(h2.ok === true, "fallback hub serves health");
  await hub2.close();
  await new Promise((resolve) => blocker.close(resolve));

  // when free, preferred is used
  const hub3 = await createHubWithFallback({
    backend: new FakeHubBackend(),
    host: "127.0.0.1",
    preferredPort: 19787,
    portSpan: 2,
    publicDir,
  });
  assert(hub3.port === 19787 && hub3.autoShifted === false, "uses preferred port when free");
  await hub3.close();

  // attach from MCP (no ownership) + detach must not close port
  {
    const backend4 = new FakeHubBackend();
    const hub4 = await createHub({
      backend: backend4,
      host: "127.0.0.1",
      port: 0,
      publicDir,
    });
    const opened = await backend4.open({
      path: "COM3",
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
      encoding: "utf8",
      protocol: "raw",
    });
    hub4.attach(opened.connectionId);
    const health = await (await fetch(`${hub4.url}/api/health`)).json();
    assert(
      health.activeConnectionId === opened.connectionId && health.ownsPort === false,
      "attach marks MCP-owned (ownsPort=false)"
    );
    await fetch(`${hub4.url}/api/detach`, { method: "POST" });
    assert(backend4.closeCount === 0, "detach does not close MCP port");
    assert(hub4.getActiveConnectionId() === null, "detach clears monitor");

    // hub-owned disconnect closes
    await fetch(`${hub4.url}/api/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "COM4" }),
    });
    await fetch(`${hub4.url}/api/disconnect`, { method: "POST" });
    assert(backend4.closeCount === 1, "hub-owned disconnect closes port");
    await hub4.close();
  }

  console.log("\n=== hub offline tests done ===");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
