/**
 * Orchestrator page contract — the Hub's /api/orchestrator surface (fake serial + fake Orchestrator).
 *
 * Pins what the panel's Orchestrator page relies on: profile discovery, connecting over
 * the shared session, single-command runs, live smoke progress over SSE, and
 * the clean 501 a serial-only Hub returns.
 */
import { fileURLToPath } from "url";
import { createHub } from "../dist/hub/server.js";
import { FakeHubBackend } from "./helpers/fake-hub-backend.mjs";
import { FakeOrchestratorBackend } from "./helpers/fake-orchestrator-backend.mjs";

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

const post = async (base, path, body) => {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { res, json: await res.json().catch(() => null) };
};

/** Collect named SSE events until the predicate is happy. */
async function readEvents(url, predicate, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const response = await fetch(url, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const nameLine = chunk.split("\n").find((line) => line.startsWith("event:"));
        const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
        if (!nameLine || !dataLine) continue;
        let payload;
        try {
          payload = JSON.parse(dataLine.slice(5).trim());
        } catch {
          continue;
        }
        events.push({ event: nameLine.slice(6).trim(), payload });
        if (predicate(events)) {
          controller.abort();
          clearTimeout(timer);
          return events;
        }
      }
    }
  } catch {
    /* abort when the predicate matched */
  }
  clearTimeout(timer);
  return events;
}

async function main() {
  const publicDir = fileURLToPath(new URL("../src/hub/public", import.meta.url));

  // ── serial-only Hub: Orchestrator routes must advertise themselves as absent ──
  {
    const serialOnly = await createHub({ backend: new FakeHubBackend(), host: "127.0.0.1", port: 0, publicDir });
    const health = await (await fetch(serialOnly.url + "/api/health")).json();
    assert(health.orchestrator === false, "health reports no Orchestrator layer without one");

    const discovery = await (await fetch(serialOnly.url + "/api/orchestrator")).json();
    assert(discovery.available === false && Array.isArray(discovery.profiles) && discovery.profiles.length === 0, "serial-only hub: /api/orchestrator says not available");

    const refused = await post(serialOnly.url, "/api/orchestrator/connect", { profile: "x", path: "COM1" });
    assert(refused.res.status === 501, "serial-only hub: connect answers 501");
    await serialOnly.close();
  }

  // ── full stack ──
  const backend = new FakeHubBackend();
  const orchestrator = new FakeOrchestratorBackend(backend);
  const hub = await createHub({ backend, orchestrator, host: "127.0.0.1", port: 0, publicDir });
  const base = hub.url;

  const health = await (await fetch(base + "/api/health")).json();
  assert(health.orchestrator === true, "health reports the Orchestrator layer");

  const discovery = await (await fetch(base + "/api/orchestrator")).json();
  assert(discovery.available === true && discovery.profiles.length === 1, "profile list is exposed");
  assert(discovery.profiles[0].name === "fake-orchestrator" && discovery.profiles[0].smoke.length === 2, "profile carries smoke plan");
  assert(discovery.status.connected === false && discovery.active === null, "idle Orchestrator status");

  const earlyRun = await post(base, "/api/orchestrator/run", { name: "ping" });
  assert(earlyRun.res.status === 409, "run without a session → 409");

  const earlySmoke = await post(base, "/api/orchestrator/smoke", {});
  assert(earlySmoke.res.status === 409, "smoke without a session → 409");

  const noProfile = await post(base, "/api/orchestrator/connect", { path: "COM9" });
  assert(noProfile.res.status === 400, "connect without a profile → 400");

  const connect = await post(base, "/api/orchestrator/connect", { profile: "fake-orchestrator", path: "COM9" });
  assert(connect.res.status === 200 && connect.json.opened === true, "connect opens the port");
  const connectionId = connect.json.connectionId;
  assert(connect.json.status.connected === true && connect.json.status.port === "COM9", "connect returns a live status");

  const healthAfter = await (await fetch(base + "/api/health")).json();
  assert(healthAfter.activeConnectionId === connectionId, "the Hub monitors the Orchestrator connection");

  const status = await (await fetch(base + "/api/orchestrator/status")).json();
  assert(status.status.connected === true && status.status.profile === "fake-orchestrator", "status follows the session");

  const run = await post(base, "/api/orchestrator/run", { name: "ping" });
  assert(run.res.status === 200 && run.json.result.verdict === "PASS", "single command passes");
  assert(typeof run.json.result.elapsedMs === "number", "single command reports elapsedMs");

  const failing = await post(base, "/api/orchestrator/run", { name: "fail_me" });
  assert(failing.res.status === 200 && failing.json.result.verdict === "FAIL", "a FAIL verdict is a 200 with a verdict, not an HTTP error");

  const unknown = await post(base, "/api/orchestrator/run", { name: "nope" });
  assert(unknown.res.status === 500 && /not in profile/.test(unknown.json.error), "unknown command surfaces the profile error");

  // Live smoke: subscribe first, then run; the events must arrive in order.
  const eventsPromise = readEvents(base + "/events/stream", (events) =>
    events.some((entry) => entry.event === "orchestrator" && entry.payload.kind === "smoke-done")
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  const smoke = await post(base, "/api/orchestrator/smoke", { includeLowPower: false });
  const events = await eventsPromise;
  const orchestratorEvents = events.filter((entry) => entry.event === "orchestrator").map((entry) => entry.payload);
  assert(smoke.res.status === 200 && smoke.json.result.allPassed === true, "smoke returns an all-pass summary");
  assert(smoke.json.result.steps.length === 2, "smoke returns one step per command");
  assert(orchestratorEvents[0]?.kind === "smoke-start" && orchestratorEvents[0].total === 2, "SSE smoke-start announces the plan");
  assert(orchestratorEvents.filter((event) => event.kind === "smoke-step").length === 2, "SSE smoke-step arrives per command");
  assert(orchestratorEvents.at(-1)?.kind === "smoke-done" && orchestratorEvents.at(-1).summary.passed === 2, "SSE smoke-done carries the summary");

  const disconnect = await post(base, "/api/orchestrator/disconnect", { closePort: true });
  assert(disconnect.res.status === 200 && disconnect.json.status.connected === false, "disconnect clears the session");
  const idleHealth = await (await fetch(base + "/api/health")).json();
  assert(idleHealth.activeConnectionId === null, "disconnecting an owned Orchestrator port unmonitors it");
  assert(backend.closeCount > 0, "disconnecting an owned Orchestrator port closes it");

  // ── attach to a port the Agent already opened ──
  const plain = await post(base, "/api/connect", { path: "COM2", baudRate: 115200 });
  assert(plain.res.status === 200, "plain serial connect works");
  const attach = await post(base, "/api/orchestrator/connect", { profile: "fake-orchestrator" });
  assert(attach.res.status === 200 && attach.json.opened === false, "connect attaches to the open session instead of reopening");
  assert(attach.json.connectionId === plain.json.connectionId, "the attached session is the same connection");
  const attachRun = await post(base, "/api/orchestrator/run", { name: "adc" });
  assert(attachRun.json.result.verdict === "PASS", "commands run on the attached session");

  await hub.close();

  const failed = process.exitCode === 1;
  console.log(failed ? "\n=== Orchestrator hub tests FAILED ===" : "\n=== Orchestrator hub tests done ===");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Orchestrator hub test crashed:", err);
  process.exit(1);
});
