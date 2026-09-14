import * as fs from "fs";
import * as path from "path";
import type { SerialMessage } from "./types.js";
import type { DutRunResult } from "./dut/types.js";

export function toHex(v: number): string {
  return "0x" + (v & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

export function plainHex(v: number): string {
  return (v & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function t0(messages: SerialMessage[]): number {
  return messages.length ? new Date(messages[0].timestamp).getTime() : 0;
}

function frameBlocks(messages: SerialMessage[], kind: "TX" | "RX"): string {
  const tOrigin = t0(messages);
  const parts: string[] = [];
  for (const m of messages) {
    if ((m.direction === "tx" ? "TX" : "RX") !== kind) continue;
    const t = new Date(m.timestamp).getTime() - tOrigin;
    const w = Math.max(48, Math.min(220, 24 + m.length * 9));
    const hex = (m.raw || "").replace(/(.{2})/g, "$1 ").trim();
    const short = hex.length > 40 ? hex.slice(0, 40) + "…" : hex;
    parts.push(
      `<div class="blk ${kind.toLowerCase()}" style="left:${t * 0.12}px;width:${w}px" title="[${esc(m.timestamp)}] ${esc(hex)}">` +
        `<span class="t">${t}ms</span><span class="hx">${esc(short)}</span>` +
        `</div>`
    );
  }
  return parts.join("\n");
}

export function renderTimelineHtml(opts: {
  title: string;
  meta?: string;
  messages: SerialMessage[];
  logPath?: string;
}): string {
  const { title, meta, messages, logPath } = opts;
  const txN = messages.filter((m) => m.direction === "tx").length;
  const rxN = messages.length - txN;
  const duration = messages.length
    ? new Date(messages[messages.length - 1].timestamp).getTime() -
      new Date(messages[0].timestamp).getTime()
    : 0;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<style>
  :root { --bg:#0f1419; --panel:#1a2332; --ink:#e7ecf3; --muted:#8b9bb4; --tx:#3d9cf0; --rx:#3ecf8e; --line:#2a3548; }
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.45 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--ink); }
  header { padding:20px 28px 12px; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 6px; font-size:18px; font-weight:600; }
  .meta { color:var(--muted); font-size:12px; }
  .stats { display:flex; gap:16px; margin-top:12px; flex-wrap:wrap; }
  .stat { background:var(--panel); border-radius:8px; padding:8px 14px; min-width:96px; }
  .stat b { display:block; font-size:16px; }
  .stat span { color:var(--muted); font-size:11px; }
  .lane { margin:16px 28px; }
  .lane h2 { margin:0 0 8px; font-size:13px; font-weight:600; letter-spacing:.04em; }
  .lane .rail { position:relative; height:72px; background:var(--panel); border-radius:10px; overflow:auto hidden; border:1px solid var(--line); }
  .blk { position:absolute; top:14px; height:44px; border-radius:6px; padding:4px 8px; overflow:hidden; white-space:nowrap; font-family:ui-monospace,Consolas,monospace; font-size:11px; cursor:default; }
  .blk.tx { background:rgba(61,156,240,.18); border:1px solid rgba(61,156,240,.55); color:#9fd0ff; }
  .blk.rx { background:rgba(62,207,142,.18); border:1px solid rgba(62,207,142,.55); color:#8ef0c2; }
  .blk .t { display:block; color:var(--muted); font-size:10px; }
  .empty { color:var(--muted); padding:24px; text-align:center; }
  footer { margin:20px 28px 28px; color:var(--muted); font-size:12px; }
  code { color:#c5d0e0; }
</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  <div class="meta">${esc(meta || "")}${logPath ? ` · log: <code>${esc(logPath)}</code>` : ""}</div>
  <div class="stats">
    <div class="stat"><b>${messages.length}</b><span>frames</span></div>
    <div class="stat"><b>${txN}</b><span>TX</span></div>
    <div class="stat"><b>${rxN}</b><span>RX</span></div>
    <div class="stat"><b>${duration}ms</b><span>span</span></div>
  </div>
</header>
${
  messages.length === 0
    ? `<div class="empty">没有消息</div>`
    : `<div class="lane"><h2>TX</h2><div class="rail">${frameBlocks(messages, "TX")}</div></div>
       <div class="lane"><h2>RX</h2><div class="rail">${frameBlocks(messages, "RX")}</div></div>`
}
<footer>时间轴按相对毫秒横向展开（约 0.12px/ms，可横向滚动）。悬停块可看完整 hex。</footer>
</body>
</html>`;
}

export function renderSmokeHtml(opts: {
  profile: string;
  steps: DutRunResult[];
  passed: number;
  failed: number;
  report: number;
  allPassed: boolean;
}): string {
  const { profile, steps, passed, failed, report, allPassed } = opts;
  const rows = steps
    .map((s) => {
      const cls =
        s.verdict === "PASS" ? "pass" : s.verdict === "FAIL" ? "fail" : s.verdict === "TIMEOUT" ? "timeout" : "report";
      const frames = s.frames
        .map((f) => f.bytes.map(plainHex).join(" "))
        .join("  |  ");
      const extras = s.extras.map(plainHex).join(" ");
      return `<tr class="${cls}">
        <td>${esc(s.command)}</td>
        <td>${esc(s.title)}</td>
        <td><span class="badge ${cls}">${s.verdict}</span></td>
        <td>${s.elapsedMs}ms</td>
        <td class="mono">${esc(s.sent.join(" ") || "-")}</td>
        <td class="mono">${esc(frames || "-")}${extras ? `<div class="muted">extras: ${esc(extras)}</div>` : ""}</td>
        <td>${esc(s.failedChecks.join("; ") || "")}</td>
      </tr>`;
    })
    .join("\n");

  const total = steps.length || 1;
  const passW = Math.round((passed / total) * 100);
  const failW = Math.round((failed / total) * 100);
  const repW = Math.max(0, 100 - passW - failW);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>DUT Smoke — ${esc(profile)}</title>
<style>
  :root { --bg:#0f1419; --panel:#1a2332; --ink:#e7ecf3; --muted:#8b9bb4; --line:#2a3548; --pass:#3ecf8e; --fail:#f07178; --to:#e6c07b; --rep:#7aa2f7; }
  * { box-sizing:border-box; }
  body { margin:0; font:13px/1.45 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--ink); }
  header { padding:20px 28px 8px; }
  h1 { margin:0 0 8px; font-size:18px; }
  .sum { color:var(--muted); }
  .bar { display:flex; height:10px; border-radius:99px; overflow:hidden; margin:16px 28px; background:var(--line); }
  .bar i { display:block; height:100%; }
  .bar .p { background:var(--pass); width:${passW}%; }
  .bar .f { background:var(--fail); width:${failW}%; }
  .bar .r { background:var(--rep); width:${repW}%; }
  table { width:calc(100% - 56px); margin:0 28px 28px; border-collapse:collapse; background:var(--panel); border-radius:10px; overflow:hidden; }
  th, td { padding:10px 12px; text-align:left; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; }
  .mono { font-family:ui-monospace,Consolas,monospace; font-size:12px; }
  .muted { color:var(--muted); }
  .badge { display:inline-block; padding:2px 8px; border-radius:99px; font-size:11px; font-weight:600; }
  .badge.pass { background:rgba(62,207,142,.15); color:var(--pass); }
  .badge.fail { background:rgba(240,113,120,.15); color:var(--fail); }
  .badge.timeout { background:rgba(230,192,123,.15); color:var(--to); }
  .badge.report { background:rgba(122,162,247,.15); color:var(--rep); }
  .headline { margin:8px 28px 16px; font-size:15px; font-weight:600; color:${allPassed ? "var(--pass)" : "var(--fail)"}; }
</style>
</head>
<body>
<header>
  <h1>DUT Smoke Report — ${esc(profile)}</h1>
  <div class="sum">PASS ${passed} · FAIL/TIMEOUT ${failed} · REPORT ${report} · total ${steps.length}</div>
</header>
<div class="bar" title="PASS / FAIL / REPORT"><i class="p"></i><i class="f"></i><i class="r"></i></div>
<div class="headline">${allPassed ? "整体通过 ✓" : "存在失败项 ✗"}</div>
<table>
  <thead><tr><th>命令</th><th>说明</th><th>判定</th><th>耗时</th><th>发送</th><th>回帧</th><th>未过项</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="7">无步骤</td></tr>`}</tbody>
</table>
</body>
</html>`;
}

export function writeHtmlReport(outPath: string, html: string): string {
  const resolved = path.resolve(outPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, html, "utf8");
  return resolved;
}
