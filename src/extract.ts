/**
 * Path-based extraction for agent-precise data pulls.
 *
 * Supported path examples:
 *   count | rx.count | tx.count | totalBytes | last | last.raw | last.data
 *   messages[2] | messages[2].raw | messages[-1].length | messages.length
 *   frames[1] | frames[1].bytes[2] | frames.length
 *   verdict | command | elapsedMs | failedChecks
 */
import type { SerialMessage } from "./types.js";

function resolveIndex(idx: number, len: number): number {
  return idx < 0 ? len + idx : idx;
}

function pickMessageField(m: SerialMessage, field: string): unknown {
  switch (field) {
    case "raw":
    case "hex":
      return m.raw ?? "";
    case "data":
    case "text":
      return m.data;
    case "length":
    case "len":
      return m.length;
    case "direction":
      return m.direction;
    case "timestamp":
    case "ts":
      return m.timestamp;
    default:
      throw new Error(`Unknown message field '${field}' (use raw|data|length|direction|timestamp)`);
  }
}

function walkFrameValue(frames: Array<{ bytes: number[]; timestamp?: string }>, token: string): unknown {
  const m = token.match(/^(\[(-?\d+)\])?(\.bytes(\[(-?\d+)\])?)?(\.timestamp)?$/);
  if (!m || (token.length > 1 && token[0] !== "[" && !token.startsWith("bytes"))) {
    // allow "frames[1].bytes[2]" as single token after "frames"
  }
  // tokens after "frames" look like "[1]", "[1].bytes[2]", ".bytes", "[1].timestamp"
  if (token.startsWith("[") || token.startsWith(".")) {
    let rest = token;
    let frameIdx = 0;
    const fm = rest.match(/^\[(-?\d+)\]/);
    if (fm) {
      frameIdx = resolveIndex(Number(fm[1]), frames.length);
      rest = rest.slice(fm[0].length);
    }
    if (rest === "") {
      const f = frames[frameIdx];
      if (!f) throw new Error(`Frame[${frameIdx}] not found (have ${frames.length})`);
      return f;
    }
    const bm = rest.match(/^\.bytes(\[(-?\d+)\])?$/);
    if (bm) {
      const f = frames[frameIdx];
      if (!f) throw new Error(`Frame[${frameIdx}] not found (have ${frames.length})`);
      if (bm[1]) {
        const bi = resolveIndex(Number(bm[2]), f.bytes.length);
        const b = f.bytes[bi];
        if (b === undefined) throw new Error(`Byte[${bi}] not found in frame[${frameIdx}]`);
        return b;
      }
      return f.bytes;
    }
    if (rest === ".timestamp" || rest === ".ts") {
      const f = frames[frameIdx];
      if (!f) throw new Error(`Frame[${frameIdx}] not found (have ${frames.length})`);
      return f.timestamp ?? "";
    }
  }
  throw new Error(`Cannot parse frame path segment '${token}'`);
}

export function extractFromMessages(
  messages: SerialMessage[],
  pathExpr: string
): unknown {
  const path = pathExpr.trim();
  if (!path) throw new Error("Empty extract path");

  if (path === "count" || path === "messages.length") return messages.length;
  if (path === "rx.count" || path === "rx") return messages.filter((m) => m.direction === "rx").length;
  if (path === "tx.count" || path === "tx") return messages.filter((m) => m.direction === "tx").length;
  if (path === "totalBytes") return messages.reduce((s, m) => s + m.length, 0);
  if (path === "rx.totalBytes") return messages.filter((m) => m.direction === "rx").reduce((s, m) => s + m.length, 0);

  if (path === "last") {
    if (!messages.length) throw new Error("No messages");
    return messages[messages.length - 1];
  }
  if (path === "first") {
    if (!messages.length) throw new Error("No messages");
    return messages[0];
  }

  if (path === "hex" || path === "allHex") {
    return messages.map((m) => m.raw || "").join("");
  }
  if (path === "rxHex") {
    return messages.filter((m) => m.direction === "rx").map((m) => m.raw || "").join("");
  }
  if (path === "text" || path === "allText") {
    return messages.map((m) => m.data).join("\n");
  }
  if (path === "rxText") {
    return messages.filter((m) => m.direction === "rx").map((m) => m.data).join("\n");
  }

  // last.raw / first.data
  const head = path.match(/^(last|first)\.(raw|data|hex|text|length|len|direction|timestamp|ts)$/);
  if (head) {
    const m = head[1] === "last" ? messages[messages.length - 1] : messages[0];
    if (!m) throw new Error("No messages");
    return pickMessageField(m, head[2] === "hex" ? "raw" : head[2] === "text" ? "data" : head[2]);
  }

  // messages[2].raw / messages[-1]
  const mm = path.match(/^messages\[(\-?\d+)\](?:\.(raw|data|hex|text|length|len|direction|timestamp|ts))?$/);
  if (mm) {
    if (!messages.length) throw new Error("No messages");
    const idx = resolveIndex(Number(mm[1]), messages.length);
    const m = messages[idx];
    if (!m) throw new Error(`messages[${idx}] not found (have ${messages.length})`);
    if (!mm[2]) return m;
    return pickMessageField(m, mm[2] === "hex" ? "raw" : mm[2] === "text" ? "data" : mm[2]);
  }

  throw new Error(
    `Unknown path '${path}'. Examples: last.raw, messages[0].data, rx.count, rxHex, totalBytes`
  );
}

export function extractFromObject(obj: Record<string, unknown>, pathExpr: string): unknown {
  const path = pathExpr.trim();
  if (!path) throw new Error("Empty extract path");

  // Fast paths for DUT result fields
  if (path === "verdict" || path === "command" || path === "elapsedMs" || path === "title" || path === "note") {
    return obj[path];
  }
  if (path === "failedChecks") return obj.failedChecks;
  if (path === "failedChecks.0") {
    const arr = obj.failedChecks as string[] | undefined;
    return arr?.[0] ?? null;
  }
  if (path === "sent" || path === "sent.0") {
    const arr = obj.sent as string[] | undefined;
    return path === "sent" ? arr : arr?.[0] ?? null;
  }
  if (path === "extras") return obj.extras;
  if (path === "frames.length") {
    const frames = obj.frames as unknown[] | undefined;
    return frames?.length ?? 0;
  }

  const frames = obj.frames as Array<{ bytes: number[]; timestamp?: string }> | undefined;
  if (frames && /^frames\[/.test(path)) {
    const rel = path.slice("frames".length);
    return walkFrameValue(frames, rel);
  }

  // Generic dotted walk
  let cur: unknown = obj;
  const parts = path.split(".");
  for (const part of parts) {
    const am = part.match(/^(\w+)\[(-?\d+)\]$/);
    if (am) {
      const arr = cur as unknown[] | undefined;
      if (!arr || !Array.isArray(arr)) throw new Error(`Not an array at '${part}'`);
      const idx = resolveIndex(Number(am[2]), arr.length);
      cur = arr[idx];
      if (cur === undefined) throw new Error(`Index ${idx} missing at '${part}'`);
      continue;
    }
    if (cur === null || typeof cur !== "object") throw new Error(`Cannot access '${part}'`);
    cur = (cur as Record<string, unknown>)[part];
    if (cur === undefined) throw new Error(`Missing field '${part}'`);
  }
  return cur;
}
