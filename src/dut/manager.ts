/**
 * DUT session manager + generic judge. Chip knowledge lives only in the
 * loaded profile; everything here works for any profile.
 */
import type { SerialManager } from "../serial-manager.js";
import type { DutAction, DutCommandDef, DutProfile, DutRunResult, DutSequenceOptions, DutSequenceResult } from "./types.js";
import { DutSession, num } from "./session.js";
import { getProfile } from "./profiles/index.js";
import { runDutSequence } from "./sequence.js";

export class DutManager {
  private sessions = new Map<string, DutSession>();

  constructor(private serial: SerialManager) {}

  /** Attach a DUT session (profile protocol layer) to an open serial connection. */
  attach(connectionId: string, profileName: string): { profile: DutProfile } {
    // Fail early if the connection doesn't exist.
    this.serial.getInfo(connectionId);
    if (this.sessions.has(connectionId)) {
      throw new Error(
        `Connection ${connectionId} already has a DUT session (${this.sessions.get(connectionId)!.profile.name}). Detach first.`
      );
    }
    const profile = getProfile(profileName);
    const session = new DutSession(profile, connectionId, this.serial);
    session.attach();
    this.sessions.set(connectionId, session);
    return { profile };
  }

  detach(connectionId: string): void {
    const s = this.sessions.get(connectionId);
    if (!s) throw new Error(`No DUT session on ${connectionId}`);
    s.detach();
    this.sessions.delete(connectionId);
  }

  hasSession(connectionId: string): boolean {
    return this.sessions.has(connectionId);
  }

  /** Every attached session, in attach order (panel discovery, diagnostics). */
  listSessions(): Array<{ connectionId: string; profile: DutProfile; stats: DutSession["stats"] }> {
    return [...this.sessions.entries()].map(([connectionId, session]) => ({
      connectionId,
      profile: session.profile,
      stats: session.stats,
    }));
  }

  getSession(connectionId: string): DutSession {
    const s = this.sessions.get(connectionId);
    if (!s) throw new Error(`No DUT session on ${connectionId}. Call dut_connect first.`);
    return s;
  }

  /** Run one named command from the profile (with optional cmd/p1/p2 overrides). */
  async runCommand(
    connectionId: string,
    commandName: string,
    overrides?: { cmd?: number; p1?: number; p2?: number }
  ): Promise<DutRunResult> {
    const session = this.getSession(connectionId);
    const def = session.profile.commands.find((c) => c.name === commandName);
    if (!def) {
      throw new Error(
        `Command '${commandName}' not in profile '${session.profile.name}'. Available: ${session.profile.commands.map((c) => c.name).join(", ")}`
      );
    }
    const started = Date.now();
    const out = await session.runActions(def.actions, overrides);
    return this.judge(def, out, started);
  }

  /** Run a free-form action sequence (dut_sequence). */
  async runSequence(
    connectionId: string,
    actions: DutAction[],
    options?: DutSequenceOptions
  ): Promise<DutSequenceResult> {
    const session = this.getSession(connectionId);
    return runDutSequence(session, actions, options);
  }

  /**
   * Run the profile's smoke sequence; returns per-step results + summary.
   * `listeners` lets a UI follow the run live (one callback per finished step).
   */
  async runSmoke(
    connectionId: string,
    includeLowPower = false,
    listeners?: {
      onStart?: (total: number, profile: string) => void;
      onStep?: (step: DutRunResult, index: number, total: number) => void;
    }
  ): Promise<{
    profile: string;
    steps: DutRunResult[];
    passed: number;
    failed: number;
    report: number;
    allPassed: boolean;
  }> {
    const session = this.getSession(connectionId);
    const names = [...(session.profile.smoke ?? [])];
    // Low-power coverage is a profile decision, never a hardcoded command list.
    if (includeLowPower) names.push(...(session.profile.lowPower ?? []));
    const planned = names.filter((n) => session.profile.commands.some((c) => c.name === n));

    listeners?.onStart?.(planned.length, session.profile.name);
    const steps: DutRunResult[] = [];
    for (let i = 0; i < planned.length; i++) {
      const step = await this.runCommand(connectionId, planned[i]);
      steps.push(step);
      listeners?.onStep?.(step, i, planned.length);
    }
    const passed = steps.filter((s) => s.verdict === "PASS").length;
    const failed = steps.filter((s) => s.verdict === "FAIL" || s.verdict === "TIMEOUT").length;
    return {
      profile: session.profile.name,
      steps,
      passed,
      failed,
      report: steps.length - passed - failed,
      allPassed: failed === 0 && passed > 0,
    };
  }

  // ── Judging (generic, driven purely by profile judge rules) ──

  private judge(
    def: DutCommandDef,
    out: {
      sent: string[];
      frames: Array<{ bytes: number[]; timestamp: string }>;
      extras: number[];
      firstCmd: number | null;
      timedOut: boolean;
    },
    started: number
  ): DutRunResult {
    const failedChecks: string[] = [];
    let verdict: DutRunResult["verdict"] = "REPORT";

    const j = def.judge;
    if (j) {
      verdict = "PASS";
      if (out.timedOut) {
        verdict = "TIMEOUT";
        failedChecks.push("应答帧/超时未满足");
      }
      if (verdict !== "TIMEOUT") {
        const resultIdx = j.resultIdx ?? 1;
        if (j.echoMatches) {
          const e = out.frames[0];
          const sentBytes = out.sent[0] ? Buffer.from(out.sent[0], "hex") : null;
          const okEcho = !!(e && sentBytes && Buffer.from(e.bytes).equals(sentBytes));
          if (!okEcho) {
            verdict = "FAIL";
            failedChecks.push(
              `回显帧不符: ${e ? e.bytes.map(hex).join(" ") : "无"} (期望 ${out.sent[0] ?? "?"})`
            );
          }
        }
        if (j.resultEchoesCmd) {
          const f = out.frames[resultIdx];
          if (!f || f.bytes[0] !== out.firstCmd) {
            verdict = "FAIL";
            failedChecks.push(
              `结果帧首字节 ${f ? hex(f.bytes[0]) : "无"} != 命令 ${hex(out.firstCmd ?? 0)}`
            );
          }
        }
        if (j.bytes) {
          const f = out.frames[resultIdx];
          if (f) {
            for (const [idx, want] of Object.entries(j.bytes)) {
              const got = f.bytes[Number(idx)];
              if (got !== num(want)) {
                verdict = "FAIL";
                failedChecks.push(`结果帧字节${idx}=${hex(got)}，期望${hex(num(want))}`);
              }
            }
          } else {
            verdict = "FAIL";
            failedChecks.push(`未收到结果帧(帧${resultIdx + 1})`);
          }
        }
        if (j.framesBytes) {
          j.framesBytes.forEach((want, i) => {
            const f = out.frames[i];
            if (!want) return;
            if (!f) {
              verdict = "FAIL";
              failedChecks.push(`未收到帧${i + 1}`);
              return;
            }
            for (const [idx, wv] of Object.entries(want)) {
              if (f.bytes[Number(idx)] !== num(wv)) {
                verdict = "FAIL";
                failedChecks.push(`帧${i + 1}字节${idx}=${hex(f.bytes[Number(idx)])}，期望${hex(num(wv))}`);
              }
            }
          });
        }
        if (j.extraContains) {
          const need = j.extraContains.replace(/\s+/g, "").toUpperCase();
          const have = out.extras.map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, "0")).join("");
          if (!have.includes(need)) {
            verdict = "FAIL";
            failedChecks.push(`回显字节流中未找到 ${need}（收到: ${have || "无"}）`);
          }
        }
      }
    } else if (out.timedOut) {
      // No judge rules but the profile expected frames that never came.
      const wantsFrames = def.actions.some((a) => a.type === "collect-frames" && a.count > 0);
      if (wantsFrames) verdict = "TIMEOUT";
    }

    return {
      command: def.name,
      title: def.title,
      verdict,
      sent: out.sent,
      frames: out.frames,
      extras: out.extras,
      failedChecks,
      elapsedMs: Date.now() - started,
      note: def.note,
    };
  }
}

export function hex(v: number): string {
  return "0x" + (v & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

export function formatRun(r: DutRunResult): string {
  const lines: string[] = [];
  lines.push(`【${r.command}】${r.title}`);
  lines.push(`判定: ${r.verdict}  (${r.elapsedMs}ms)`);
  if (r.sent.length) lines.push(`发送: ${r.sent.join(" ")}`);
  if (r.frames.length) {
    lines.push(
      `回帧: ${r.frames
        .map((f) => f.bytes.map(hex).join(" ") + " @" + f.timestamp.slice(11, 23))
        .join("  |  ")}`
    );
  } else {
    lines.push("回帧: (无)");
  }
  if (r.extras.length) lines.push(`额外字节: ${r.extras.map(hex).join(" ")}`);
  if (r.failedChecks.length) lines.push(`未过项: ${r.failedChecks.join("; ")}`);
  if (r.note) lines.push(`备注: ${r.note}`);
  return lines.join("\n");
}
