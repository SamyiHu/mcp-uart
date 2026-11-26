#!/usr/bin/env node
/**
 * Hub HTTP contract — one suite, two hosts.
 *
 * The standalone browser UI and the DSH panel are two front ends over the same
 * API. This file pins that API so neither front end can drift from the other:
 *
 *   node test/hub-contract-test.mjs http://127.0.0.1:8787/
 *   node test/hub-contract-test.mjs http://127.0.0.1:50031/uart/ <dsh-token>
 *
 * Pass a base URL that ends with a slash; every path below is resolved against
 * it, so a path-prefixed mount (the DSH plugin proxy) is tested exactly like a
 * root mount. Under DSH the route sits behind the web auth cookie, so pass the
 * token printed by `dsh web` as the second argument.
 */
const base = (process.argv[2] || "http://127.0.0.1:8787/").replace(/\/*$/, "/");
const token = process.argv[3] || process.env.DSH_TOKEN || "";
const results = [];

let cookie = "";

async function authenticate() {
  if (!token) return;
  const response = await fetch(new URL(`/?token=${encodeURIComponent(token)}`, base), { redirect: "manual" });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  cookie = setCookie.map((value) => value.split(";")[0]).join("; ");
  if (cookie.length === 0) throw new Error("the token did not establish a DSH session cookie");
}

function headers(extra) {
  return cookie.length > 0 ? { cookie, ...extra } : extra;
}

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  process.stdout.write(`${mark}  ${name}${ok || !detail ? "" : ` — ${detail}`}\n`);
}

async function get(path) {
  const res = await fetch(new URL(path, base), { headers: headers({}) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { res, text, json };
}

async function post(path, body) {
  const res = await fetch(new URL(path, base), {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { res, text, json };
}

async function main() {
  await authenticate();

  const health = await get("api/health");
  check("GET api/health returns 200 JSON", health.res.ok && health.json?.ok === true, health.res.status);
  check("health exposes the active connection", "activeConnectionId" in (health.json ?? {}));

  const ports = await get("api/ports");
  check("GET api/ports lists an array", ports.res.ok && Array.isArray(ports.json?.ports), ports.res.status);

  const status = await get("api/status");
  check("GET api/status lists connections", status.res.ok && Array.isArray(status.json?.connections), status.res.status);

  const orchestrator = await get("api/orchestrator");
  check(
    "GET api/orchestrator reports the Orchestrator layer",
    orchestrator.res.ok && typeof orchestrator.json?.available === "boolean" && Array.isArray(orchestrator.json?.profiles),
    orchestrator.res.status,
  );

  const frames = await get("api/frames?limit=5");
  check("GET api/frames returns a seq cursor", frames.res.ok && typeof frames.json?.seq === "number" && Array.isArray(frames.json?.frames), frames.res.status);

  const index = await get("");
  check("GET / serves the UART page", index.res.ok && /<title>UART Hub<\/title>/.test(index.text), index.res.status);

  const asset = await get("static/app.js");
  check(
    "GET static/app.js serves the page bootstrap",
    asset.res.ok && asset.text.includes("uart-ui.js"),
    asset.res.status,
  );

  const shared = await get("static/uart-ui.js");
  check(
    "GET static/uart-ui.js serves the shared console module",
    shared.res.ok && shared.text.includes("events/stream") && shared.text.includes("createUartUi") && shared.text.includes("api/orchestrator"),
    shared.res.status,
  );

  const badConnect = await post("api/connect", {});
  check("POST api/connect without a path is rejected with 400", badConnect.res.status === 400, badConnect.res.status);

  const write = await post("api/write", { data: "00" });
  if (health.json?.activeConnectionId) {
    check("POST api/write without a connection is skipped (a session is active)", true);
  } else {
    check("POST api/write without a connection is rejected with 409", write.res.status === 409, write.res.status);
  }

  const missing = await get("api/does-not-exist");
  check("Unknown API routes answer 404", missing.res.status === 404, missing.res.status);

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed against ${base}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`contract test could not reach ${base}: ${err?.message ?? err}\n`);
  process.exit(1);
});
