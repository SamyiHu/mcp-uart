/**
 * History archive tests.
 *
 * The live tape is cleared whenever the monitored connection changes, so the
 * console used to forget everything on reconnect. The Hub now keeps a session
 * archive behind GET /api/history; these tests pin its ordering and filters.
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
  const hub = await createHub({ backend, host: "127.0.0.1", port: 0 });
  const base = hub.url;

  const opened = await (
    await fetch(`${base}/api/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "COM1", baudRate: 115200, encoding: "utf8" }),
    })
  ).json();
  const id = opened.connectionId;

  const emit = (text, direction = "rx") =>
    backend.emit(id, {
      timestamp: new Date().toISOString(),
      connectionId: id,
      data: text,
      raw: Buffer.from(text, "utf8").toString("hex").toUpperCase(),
      length: Buffer.byteLength(text),
      direction,
    });

  emit("BOOT ready\r\n");
  emit("TEMP=27.5C\r\n");
  emit("CMD READ?", "tx");
  emit("LIRC_Off:Err\r\n");

  // ── archive content ──
  let data = await (await fetch(`${base}/api/history`)).json();
  assert(data.ok === true && data.total === 4, `history holds every frame (got total=${data.total})`);
  assert(data.frames[0].data.includes("LIRC_Off"), "history is newest-first");
  assert(data.frames.at(-1).data.includes("BOOT"), "history ends with the oldest frame");

  // ── filters ──
  data = await (await fetch(`${base}/api/history?direction=tx`)).json();
  assert(data.total === 1 && data.frames[0].data === "CMD READ?", "direction filter works");

  data = await (await fetch(`${base}/api/history?text=TEMP`)).json();
  assert(data.total === 1 && data.frames[0].data.includes("27.5"), "text filter works");

  data = await (await fetch(`${base}/api/history?hex=${Buffer.from("LIRC").toString("hex")}`)).json();
  assert(data.total === 1, "hex filter works");

  // ── survives a reconnect (the whole point) ──
  await fetch(`${base}/api/disconnect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const reopened = await (
    await fetch(`${base}/api/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "COM2", baudRate: 115200 }),
    })
  ).json();
  emit.call(null, "AFTER reconnect\r\n");
  // emit() above targets the old id; push through the new connection instead.
  backend.emit(reopened.connectionId, {
    timestamp: new Date().toISOString(),
    connectionId: reopened.connectionId,
    data: "AFTER reconnect\r\n",
    raw: Buffer.from("AFTER reconnect\r\n", "utf8").toString("hex").toUpperCase(),
    length: 17,
    direction: "rx",
  });

  data = await (await fetch(`${base}/api/history`)).json();
  assert(data.total >= 5, `history survives a reconnect (got total=${data.total})`);
  assert(data.frames[0].data.includes("AFTER"), "the new connection's frames land on top");

  // ── paging ──
  const page = await (await fetch(`${base}/api/history?limit=2&offset=1`)).json();
  assert(page.frames.length === 2, "limit/offset paging works");
  assert(page.total === data.total, "paging reports the full total");

  await hub.close();
  console.log("\n=== history tests done ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
