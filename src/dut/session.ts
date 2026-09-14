/**
 * Chip-agnostic DUT protocol session.
 *
 * Owns the byte-stream state machine for one connection: appends every raw
 * RX byte, extracts frames of `profile.frame.length` whose checksum
 * validates (resynchronizing one byte at a time past noise), and records
 * non-frame bytes as "extras" (UART echo bytes etc.). Executes generic
 * action lists from the profile.
 */
import type { SerialManager } from "../serial-manager.js";
import type {
  DutAction,
  DutProfile,
  ParsedFrame,
} from "./types.js";

/** Accept 10, "0x0F", "15" — profiles use hex strings for readability. */
export function num(v: number | string | undefined, fallback = 0): number {
  if (v === undefined) return fallback;
  if (typeof v === "number") return v & 0xff;
  const n = parseInt(v, v.toLowerCase().startsWith("0x") ? 16 : 10);
  return (isNaN(n) ? fallback : n) & 0xff;
}

export function checksumOf(bytes: number[], profile: DutProfile): number {
  const f = profile.frame;
  let acc = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (i !== f.checksumIndex) acc = (acc + bytes[i]) & 0xff;
  }
  switch (f.checksum) {
    case "sum-complement":
      return (0xff - acc) & 0xff;
    case "sum":
      return acc;
    case "xor":
      acc = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (i !== f.checksumIndex) acc ^= bytes[i];
      }
      return acc;
  }
}

type FrameWaiter = {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
  targetCount: number;
};
type ExtraWaiter = {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
  startIdx: number;
  hex: string;
};

export class DutSession {
  readonly profile: DutProfile;
  readonly connectionId: string;
  private manager: SerialManager;
  private buf: number[] = [];
  private frames: ParsedFrame[] = [];
  private extras: number[] = [];
  private frameWaiter: FrameWaiter | null = null;
  private extraWaiter: ExtraWaiter | null = null;
  private rxHook = (data: Buffer) => this.onRx(data);
  stats = { framesParsed: 0, noiseBytes: 0, framesSent: 0, rawBytesSent: 0 };

  constructor(profile: DutProfile, connectionId: string, manager: SerialManager) {
    this.profile = profile;
    this.connectionId = connectionId;
    this.manager = manager;
  }

  attach(): void {
    this.manager.addDataHook(this.connectionId, this.rxHook);
  }

  detach(): void {
    this.manager.removeDataHook(this.connectionId, this.rxHook);
    this.settleWaiters();
  }

  /** Drop pending stream state before starting a new command. */
  reset(): void {
    this.buf = [];
    this.frames = [];
    this.extras = [];
  }

  // ── RX stream ──

  private onRx(chunk: Buffer): void {
    for (const b of chunk) {
      this.buf.push(b);
      this.drain();
    }
    this.checkExtraWaiter();
  }

  private drain(): void {
    const len = this.profile.frame.length;
    while (this.buf.length >= len) {
      const head = this.buf.slice(0, len);
      if (head[this.profile.frame.checksumIndex] === checksumOf(head, this.profile)) {
        this.buf.splice(0, len);
        this.frames.push({ bytes: head, timestamp: new Date().toISOString() });
        this.stats.framesParsed++;
        const w = this.frameWaiter;
        if (w && this.frames.length >= w.targetCount) {
          clearTimeout(w.timer);
          this.frameWaiter = null;
          w.resolve();
        }
      } else {
        this.extras.push(this.buf.shift()!);
        this.stats.noiseBytes++;
        if (this.extras.length > 256) this.extras.splice(0, this.extras.length - 256);
      }
    }
  }

  private notifyFrameWaiter(): void {
    const w = this.frameWaiter;
    if (!w) return;
    if (this.frames.length >= w.targetCount) {
      clearTimeout(w.timer);
      this.frameWaiter = null;
      w.resolve();
    }
  }

  private checkExtraWaiter(): void {
    const w = this.extraWaiter;
    if (!w) return;
    const need = Buffer.from(w.hex.replace(/\s+/g, ""), "hex");
    // Search extras since the waiter started PLUS bytes still sitting in the
    // frame buffer (a lone echo byte never reaches `extras` on its own).
    const window = Buffer.concat([
      Buffer.from(this.extras.slice(w.startIdx)),
      Buffer.from(this.buf),
    ]);
    if (window.indexOf(need) !== -1) {
      clearTimeout(w.timer);
      this.extraWaiter = null;
      w.resolve();
    }
  }

  private settleWaiters(): void {
    if (this.frameWaiter) this.notifyFrameWaiter();
    const w = this.extraWaiter;
    if (w) {
      clearTimeout(w.timer);
      this.extraWaiter = null;
      w.resolve();
    }
  }

  // ── TX ──

  buildFrame(cmd: number, p1: number, p2: number): Buffer {
    const bytes = [cmd, p1, p2, 0];
    bytes[this.profile.frame.checksumIndex] = checksumOf(bytes, this.profile);
    return Buffer.from(bytes);
  }

  async sendFrame(cmd: number, p1: number, p2: number): Promise<string> {
    const buf = this.buildFrame(cmd, p1, p2);
    await this.manager.write(this.connectionId, buf.toString("hex").toUpperCase(), "hex");
    this.stats.framesSent++;
    return buf.toString("hex").toUpperCase();
  }

  async sendRaw(hex: string): Promise<string> {
    const buf = Buffer.from(hex.replace(/\s+/g, ""), "hex");
    await this.manager.write(this.connectionId, buf.toString("hex").toUpperCase(), "hex");
    this.stats.rawBytesSent += buf.length;
    return buf.toString("hex").toUpperCase();
  }

  /** Break pulse on TX = falling edge on the DUT's RX wake pin. */
  async wakePulse(ms = 2): Promise<void> {
    await this.manager.setSignals(this.connectionId, { break: true });
    await sleep(ms);
    await this.manager.setSignals(this.connectionId, { break: false });
  }

  // ── Waiting ──

  /**
   * Wait until `count` NEW frames have arrived since this call (relative to
   * frames already collected by earlier steps, e.g. the echo).
   * Resolves with the number of new frames actually received.
   */
  waitForFrames(count: number, timeoutMs: number): Promise<number> {
    const baseline = this.frames.length;
    if (count <= 0) return Promise.resolve(0);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.frameWaiter && this.frameWaiter.timer === timer) this.frameWaiter = null;
        resolve(this.frames.length - baseline);
      }, timeoutMs);
      // A command run only ever waits for one thing at a time.
      this.frameWaiter = {
        resolve: () => resolve(this.frames.length - baseline),
        timer,
        targetCount: baseline + count,
      };
    });
  }

  waitForExtra(hex: string, timeoutMs: number): Promise<boolean> {
    const need = Buffer.from(hex.replace(/\s+/g, ""), "hex");
    const window = Buffer.concat([Buffer.from(this.extras), Buffer.from(this.buf)]);
    if (window.indexOf(need) !== -1) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.extraWaiter && this.extraWaiter.timer === timer) this.extraWaiter = null;
        resolve(false);
      }, timeoutMs);
      this.extraWaiter = {
        resolve: () => resolve(true),
        timer,
        startIdx: this.extras.length,
        hex,
      };
    });
  }

  /** Copy of current parsed frames and non-frame bytes (for status/tools). */
  snapshot(): { frames: ParsedFrame[]; extras: number[] } {
    return { frames: this.frames.slice(), extras: this.extras.slice() };
  }

  // ── Action executor ──

  /**
   * Run a command's action list. `overrides` replace the first send-frame's
   * cmd/p1/p2 (how dut_test parameterizes profile commands).
   * Returns collected frames + extras and the hex of everything we sent.
   */
  async runActions(
    actions: DutAction[],
    overrides?: { cmd?: number; p1?: number; p2?: number }
  ): Promise<{ sent: string[]; frames: ParsedFrame[]; extras: number[]; firstCmd: number | null; timedOut: boolean }> {
    this.reset();
    const sent: string[] = [];
    let firstCmd: number | null = null;
    let lastFrame: { cmd: number; p1: number; p2: number } | null = null;
    let timedOut = false;

    for (const act of actions) {
      switch (act.type) {
        case "send-frame": {
          let cmd = num(act.cmd);
          let p1 = num(act.p1);
          let p2 = num(act.p2);
          if (firstCmd === null && overrides) {
            if (overrides.cmd !== undefined) cmd = overrides.cmd & 0xff;
            if (overrides.p1 !== undefined) p1 = overrides.p1 & 0xff;
            if (overrides.p2 !== undefined) p2 = overrides.p2 & 0xff;
          }
          if (firstCmd === null) firstCmd = cmd;
          lastFrame = { cmd, p1, p2 };
          sent.push(await this.sendFrame(cmd, p1, p2));
          break;
        }
        case "expect-echo": {
          // Wait for the frame that byte-equals what we dispatched. Stale
          // frames from a desynced DUT are DISCARDED (moved to extras) so
          // frame indexes stay stable (0=echo, 1+=results). If nothing
          // matches, re-dispatch — the original may have been swallowed as
          // a leftover handshake by a previous test.
          if (!lastFrame) throw new Error("expect-echo action before any send-frame");
          const resendMs = act.resendMs ?? 800;
          const deadline = Date.now() + act.timeoutMs;
          const want = this.buildFrame(lastFrame.cmd, lastFrame.p1, lastFrame.p2);
          let resent = false;
          for (;;) {
            const wait = Math.min(resendMs, Math.max(50, deadline - Date.now()));
            const got = await this.waitForFrames(1, wait);
            if (got >= 1) {
              const f = this.frames[this.frames.length - 1];
              if (f && Buffer.from(f.bytes).equals(want)) break;
              // stale frame — discard to extras, keep waiting
              this.frames.pop();
              for (const b of f!.bytes) this.extras.push(b);
              if (this.extras.length > 256) this.extras.splice(0, this.extras.length - 256);
            }
            if (Date.now() >= deadline) { timedOut = true; break; }
            if (!resent) {
              // one resend helps when the dispatch was consumed as a stale handshake
              resent = true;
              sent.push(await this.sendFrame(lastFrame.cmd, lastFrame.p1, lastFrame.p2));
            }
          }
          break;
        }
        case "handshake": {
          // Resend the last dispatched frame: the DUT reads it inside
          // Send_Read_N_Byte and only then replies with the result.
          if (!lastFrame) throw new Error("handshake action before any send-frame");
          sent.push(await this.sendFrame(lastFrame.cmd, lastFrame.p1, lastFrame.p2));
          break;
        }
        case "get-result": {
          // Retry loop: long tests hold their Send_Read unread while frames
          // sent meanwhile are lost — keep re-handshaking until the result
          // frame arrives or the total deadline passes.
          if (!lastFrame) throw new Error("get-result action before any send-frame");
          const retryMs = act.retryMs ?? 400;
          const deadline = Date.now() + act.timeoutMs;
          for (;;) {
            sent.push(await this.sendFrame(lastFrame.cmd, lastFrame.p1, lastFrame.p2));
            const got = await this.waitForFrames(1, retryMs);
            if (got >= 1) break;
            if (Date.now() + retryMs >= deadline) {
              timedOut = true;
              break;
            }
          }
          break;
        }
        case "send-raw":
          sent.push(await this.sendRaw(act.hex));
          break;
        case "wait":
          await sleep(act.ms);
          break;
        case "wake-pulse":
          await this.wakePulse(act.ms ?? 2);
          break;
        case "collect-frames": {
          if (act.count > 0) {
            const got = await this.waitForFrames(act.count, act.timeoutMs);
            if (got < act.count) timedOut = true;
          }
          break;
        }
        case "expect-extra": {
          const ok = await this.waitForExtra(act.hex, act.timeoutMs);
          if (!ok) timedOut = true;
          break;
        }
      }
    }
    return {
      sent,
      frames: this.frames.slice(),
      extras: this.extras.slice(),
      firstCmd,
      timedOut,
    };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
