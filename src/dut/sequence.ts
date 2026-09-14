/**
 * dut_sequence engine — free-form DutAction[] on top of DutSession.
 */
import type {
  DutAction,
  DutSequenceOptions,
  DutSequenceResult,
  DutSequenceStepLog,
  ParsedFrame,
} from "./types.js";
import { DutSession, num, sleep } from "./session.js";

const DEFAULT_BUDGET_MS = 25_000;

type SignalPatch = { dtr?: boolean; rts?: boolean; break?: boolean };

function hexByte(b: number): string {
  return (b & 0xff).toString(16).padStart(2, "0").toUpperCase();
}

function frameHex(bytes: number[]): string {
  return bytes.map(hexByte).join("");
}

export function validateMatchHex(matchHex: string, probeFrameHex?: string): void {
  const h = matchHex.replace(/\s+/g, "").toUpperCase();
  if (!/^[0-9A-F]+$/.test(h) || h.length < 4 || h.length % 2 !== 0) {
    throw new Error(`poll.matchHex must be even-length hex with ≥4 chars (got "${matchHex}")`);
  }
  if (probeFrameHex && probeFrameHex.includes(h)) {
    throw new Error(
      `poll.matchHex "${h}" is a substring of probe echo "${probeFrameHex}" — would match the echo. Use the result-frame pattern (e.g. 0F00).`
    );
  }
}

function isHardAbort(err: unknown): boolean {
  const m = String((err as any)?.message ?? err);
  return /not open|not found|closed|ECONN|Access|Access/i.test(m);
}

export async function runDutSequence(
  session: DutSession,
  actions: DutAction[],
  options: DutSequenceOptions = {}
): Promise<DutSequenceResult> {
  const budget = options.totalBudgetMs ?? DEFAULT_BUDGET_MS;
  const abortOnError = options.abortOnError === true;
  const capture = options.captureFrames ?? "match";
  const t0 = Date.now();

  const steps: DutSequenceStepLog[] = [];
  let lastFrame: { cmd: number; p1: number; p2: number } | null = null;
  let firstRxLatencyMs: number | undefined;
  let firstRxSeen = false;
  let baselineAtMs: number | undefined;
  let recoveryMs: number | undefined;
  let stopped: DutSequenceResult["stopped"] = null;
  let abortReason: string | undefined;

  const stats0 = { ...session.stats };
  session.reset();

  const sigSnapshot: SignalPatch = { dtr: true, rts: true, break: false };
  const sigTouched: SignalPatch = {};

  const elapsed = () => Date.now() - t0;
  const remaining = () => budget - elapsed();
  const outOfBudget = () => remaining() <= 0;
  const isAborted = () => stopped === "aborted";

  async function setSignals(patch: SignalPatch): Promise<void> {
    const mgr = (session as unknown as { manager: { setSignals(id: string, s: SignalPatch): Promise<void> } }).manager;
    await mgr.setSignals(session.connectionId, patch);
  }

  async function restoreSignals(): Promise<void> {
    const restore: SignalPatch = {};
    if (sigTouched.dtr !== undefined && sigSnapshot.dtr !== undefined) restore.dtr = sigSnapshot.dtr;
    if (sigTouched.rts !== undefined && sigSnapshot.rts !== undefined) restore.rts = sigSnapshot.rts;
    if (sigTouched.break !== undefined) restore.break = false;
    if (Object.keys(restore).length === 0) return;
    try {
      await setSignals(restore);
    } catch {
      /* ignore */
    }
  }

  function slimFrames(newFrames: ParsedFrame[], matchedHex?: string): string[] | undefined {
    if (capture === "none") return undefined;
    if (capture === "all") return newFrames.map((f) => frameHex(f.bytes));
    if (matchedHex) return [matchedHex];
    const hx = newFrames.map((f) => frameHex(f.bytes));
    return hx.slice(-2);
  }

  async function noteFirstRx(baselineFrames: number, waitMs: number): Promise<void> {
    if (firstRxSeen) return;
    await session.waitForFrames(1, waitMs);
    const snap = session.snapshot();
    if (snap.frames.length > baselineFrames) {
      firstRxLatencyMs = elapsed();
      firstRxSeen = true;
    }
  }

  async function runPoll(
    act: Extract<DutAction, { type: "poll" }>,
    log: DutSequenceStepLog
  ): Promise<void> {
    if (!act.send.frame && !act.send.hex) {
      throw new Error("poll.send requires frame or hex");
    }
    let probeHex: string;
    if (act.send.frame) {
      probeHex = session
        .buildFrame(num(act.send.frame.cmd), num(act.send.frame.p1), num(act.send.frame.p2))
        .toString("hex")
        .toUpperCase();
    } else {
      probeHex = act.send.hex!.replace(/\s+/g, "").toUpperCase();
    }

    const matchMode = act.matchMode ?? "frame-hex";
    const match = act.matchHex ? act.matchHex.replace(/\s+/g, "").toUpperCase() : undefined;
    if (match) {
      if (matchMode === "frame-hex") {
        validateMatchHex(match, probeHex);
      } else {
        validateMatchHex(match, undefined);
      }
    }

    const ignoreExisting = act.ignoreExisting !== false;
    const deadline = elapsed() + Math.min(act.timeoutMs, Math.max(0, remaining()));
    const pollStart = elapsed();
    let attempts = 0;
    let frameBase = session.snapshot().frames.length;
    let extrasBase = session.snapshot().extras.length;
    let matchedFrameHex: string | undefined;
    let newFrames: ParsedFrame[] = [];

    if (!ignoreExisting) {
      // baseline 0 means match may see old frames — still reset for poll cleanliness of log
    } else {
      // Keep physical frames; matching only looks at frames after baseline
      frameBase = session.snapshot().frames.length;
      extrasBase = session.snapshot().extras.length;
    }

    const checkFrameHex = (hx: string): boolean => (match ? hx.includes(match) : false);

    async function probeOnce(): Promise<boolean> {
      attempts++;
      let sentHex: string;
      if (act.send.frame) {
        lastFrame = {
          cmd: num(act.send.frame.cmd),
          p1: num(act.send.frame.p1),
          p2: num(act.send.frame.p2),
        };
        sentHex = await session.sendFrame(lastFrame.cmd, lastFrame.p1, lastFrame.p2);
      } else {
        sentHex = await session.sendRaw(act.send.hex!);
      }
      if (!log.sent) log.sent = [];
      log.sent.push(sentHex);

      // twoPhase: after short wait, resend as handshake
      if (act.twoPhase) {
        const shortWait = Math.min(2, Math.max(0, remaining()));
        if (shortWait > 0) await sleep(shortWait);
        // check match before handshake
        if (scan()) return true;
        if (lastFrame) {
          const hs = await session.sendFrame(lastFrame.cmd, lastFrame.p1, lastFrame.p2);
          log.sent.push(hs);
        }
      }
      return false;
    }

    function scan(): boolean {
      const snap = session.snapshot();
      const recent = snap.frames.slice(frameBase);
      if (act.framesCount && recent.length >= act.framesCount) {
        newFrames = recent;
        matchedFrameHex = recent.length ? frameHex(recent[recent.length - 1].bytes) : undefined;
        return true;
      }
      if (!match) return false;
      if (matchMode === "raw-hex") {
        const extras = snap.extras.slice(extrasBase);
        const raw = frameHex(extras) + recent.map((f) => frameHex(f.bytes)).join("");
        if (raw.includes(match)) {
          newFrames = recent;
          const hit = recent.find((f) => frameHex(f.bytes).includes(match));
          matchedFrameHex = hit ? frameHex(hit.bytes) : match;
          return true;
        }
        return false;
      }
      for (const f of recent) {
        const hx = frameHex(f.bytes);
        if (checkFrameHex(hx)) {
          newFrames = recent;
          matchedFrameHex = hx;
          return true;
        }
      }
      return false;
    }

    const finishMatch = (): void => {
      log.attempts = attempts;
      log.firstMatchAtMs = elapsed() - pollStart;
      log.matchedFrameHex = matchedFrameHex;
      log.verdict = "matched";
      log.frames = slimFrames(newFrames, matchedFrameHex);
      if (baselineAtMs !== undefined) recoveryMs = elapsed() - baselineAtMs;
    };

    while (elapsed() < deadline && stopped === null && !outOfBudget()) {
      const attemptStart = elapsed();
      if ((await probeOnce()) || scan()) {
        finishMatch();
        return;
      }
      // Slice-wait until next interval so late result frames still match.
      const intervalEnd = attemptStart + Math.max(act.intervalMs, 1);
      while (elapsed() < intervalEnd && elapsed() < deadline && stopped === null) {
        if (scan()) {
          finishMatch();
          return;
        }
        const left = Math.min(intervalEnd - elapsed(), remaining(), 1);
        if (left > 0) await sleep(left);
      }
    }

    log.attempts = attempts;
    log.verdict = "timeout";
    log.frames = slimFrames(session.snapshot().frames.slice(frameBase));
  }

  async function runOne(act: DutAction, log: DutSequenceStepLog): Promise<void> {
    switch (act.type) {
      case "send-frame": {
        const cmd = num(act.cmd);
        const p1 = num(act.p1);
        const p2 = num(act.p2);
        lastFrame = { cmd, p1, p2 };
        const hx = await session.sendFrame(cmd, p1, p2);
        log.sent = [hx];
        await noteFirstRx(session.snapshot().frames.length, Math.min(20, Math.max(5, remaining())));
        log.verdict = "ok";
        return;
      }
      case "send-raw": {
        const hx = await session.sendRaw(act.hex);
        log.sent = [hx];
        await noteFirstRx(session.snapshot().frames.length, Math.min(20, Math.max(5, remaining())));
        log.verdict = "ok";
        return;
      }
      case "handshake": {
        if (!lastFrame) throw new Error("handshake before any send-frame");
        const hx = await session.sendFrame(lastFrame.cmd, lastFrame.p1, lastFrame.p2);
        log.sent = [hx];
        log.verdict = "ok";
        return;
      }
      case "wait": {
        await sleep(Math.min(act.ms, Math.max(0, remaining())));
        log.verdict = "ok";
        return;
      }
      case "clear-state": {
        session.reset();
        log.verdict = "ok";
        return;
      }
      case "signals": {
        const patch: SignalPatch = {};
        if (act.dtr !== undefined) {
          patch.dtr = act.dtr;
          sigTouched.dtr = act.dtr;
        }
        if (act.rts !== undefined) {
          patch.rts = act.rts;
          sigTouched.rts = act.rts;
        }
        if (act.break !== undefined) {
          patch.break = act.break;
          sigTouched.break = act.break;
        }
        await setSignals(patch);
        if (act.holdMs !== undefined) {
          await sleep(Math.min(act.holdMs, Math.max(0, remaining())));
          const restore: SignalPatch = {};
          if (act.dtr !== undefined && sigSnapshot.dtr !== undefined) restore.dtr = sigSnapshot.dtr;
          if (act.rts !== undefined && sigSnapshot.rts !== undefined) restore.rts = sigSnapshot.rts;
          if (act.break !== undefined) restore.break = false;
          await setSignals(restore);
        }
        log.verdict = "ok";
        return;
      }
      case "wake-pulse": {
        await session.wakePulse(act.ms ?? 2);
        sigTouched.break = true;
        log.verdict = "ok";
        return;
      }
      case "repeat": {
        const times = Math.max(1, act.times | 0);
        const each = act.logRepeat === "each";
        let completed = 0;
        let anyFail = false;
        for (let n = 0; n < times; n++) {
          if (outOfBudget() || isAborted()) {
            log.stopped = isAborted() ? "aborted" : "budget";
            if (!isAborted()) stopped = "budget";
            break;
          }
          let stepFail = false;
          for (const child of act.steps) {
            if (outOfBudget() || isAborted()) {
              if (outOfBudget()) log.stopped = "budget";
              break;
            }
            const childLog: DutSequenceStepLog = {
              i: steps.length,
              action: child.type,
              atMs: elapsed(),
            };
            if ((child as any).mark) childLog.mark = (child as any).mark;
            if ((child as any).baseline) {
              childLog.baseline = true;
              baselineAtMs = elapsed();
            }
            try {
              await runOne(child, childLog);
              if (childLog.verdict === "timeout") stepFail = true;
            } catch (err: any) {
              childLog.verdict = "failed";
              childLog.note = err?.message ?? String(err);
              stepFail = true;
              if (isHardAbort(err)) {
                stopped = "aborted";
                abortReason = childLog.note;
                if (each) steps.push(childLog);
                break;
              }
              if (abortOnError) {
                stopped = "aborted";
                abortReason = childLog.note;
                if (each) steps.push(childLog);
                break;
              }
            }
            if (each) steps.push(childLog);
          }
          if (stepFail) {
            anyFail = true;
            if (act.abortOnFail) break;
          } else {
            completed++;
          }
        }
        log.completed = completed;
        log.times = times;
        log.verdict = anyFail && completed < times ? "failed" : "ok";
        return;
      }
      case "poll": {
        await runPoll(act, log);
        return;
      }
      case "expect-echo":
      case "get-result":
      case "collect-frames":
      case "expect-extra": {
        // Reuse profile engine for these
        await session.runActions([act]);
        log.verdict = "ok";
        return;
      }
      default: {
        throw new Error(`Unsupported action in sequence: ${(act as any).type}`);
      }
    }
  }

  try {
    for (let idx = 0; idx < actions.length; idx++) {
      if (outOfBudget()) {
        stopped = "budget";
        break;
      }
      if (stopped === "aborted") break;

      const act = actions[idx];
      const log: DutSequenceStepLog = { i: idx, action: act.type, atMs: elapsed() };
      if ((act as any).mark) log.mark = (act as any).mark;
      if ((act as any).baseline) {
        log.baseline = true;
        baselineAtMs = elapsed();
      }

      try {
        await runOne(act, log);
      } catch (err: any) {
        log.verdict = "failed";
        log.note = err?.message ?? String(err);
        if (isHardAbort(err) || abortOnError) {
          stopped = "aborted";
          abortReason = log.note;
        }
      }
      steps.push(log);
    }
  } finally {
    await restoreSignals();
  }

  const snap = session.snapshot();
  void snap;

  return {
    ok: stopped === null,
    elapsedMs: elapsed(),
    stopped,
    abortReason,
    steps,
    summary: {
      firstRxLatencyMs,
      recoveryMs,
      framesParsed: session.stats.framesParsed - stats0.framesParsed,
      extras: session.stats.noiseBytes - stats0.noiseBytes,
      framesSent: session.stats.framesSent - stats0.framesSent,
    },
  };
}
