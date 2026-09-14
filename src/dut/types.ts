/**
 * DUT (device-under-test) profile types.
 *
 * A profile is pure DATA describing how to talk to one chip's FT firmware:
 * serial settings, frame format (length + checksum algorithm), a table of
 * named test commands (each a sequence of generic actions), pass/fail
 * judgment rules, and a smoke-test sequence. The engine in session.ts /
 * manager.ts is chip-agnostic — supporting a new chip means adding a new
 * profile JSON, not touching core code.
 */

export type ChecksumAlgorithm =
  | "sum-complement" // ck = 0xFF - (sum of payload bytes)        (W6729 FT fw)
  | "sum"            // ck = sum of payload bytes
  | "xor";           // ck = XOR of payload bytes

export interface FrameDescriptor {
  /** Total frame length in bytes, including the checksum byte. */
  length: number;
  /** Byte index of the checksum within the frame. */
  checksumIndex: number;
  /** How the checksum byte is computed over the remaining bytes. */
  checksum: ChecksumAlgorithm;
}

/**
 * Generic action primitives a command is built from. Values accept decimal
 * numbers or hex strings ("0x5A") for readability in profile JSON files.
 *
 * W6729 handshake protocol (verified on hardware):
 *   send-frame → DUT echoes the frame → resend (handshake) → DUT sends result.
 * The DUT's Send_Read_N_Byte always READS the next frame before replying, so
 * every command needs its frame sent twice (dispatch + handshake).
 */
export type DutActionBase =
  | { type: "send-frame"; cmd: number | string; p1?: number | string; p2?: number | string }
  /**
   * Wait for the DUT echo that byte-equals the dispatched frame, resending
   * the frame periodically. Stale frames from a desynced DUT are skipped,
   * which self-heals the pipeline.
   */
  | { type: "expect-echo"; timeoutMs: number; resendMs?: number }
  /** Resend the last send-frame as the DUT's handshake (triggers the result). */
  | { type: "handshake" }
  /**
   * Robust result collection: repeatedly resend the handshake frame until one
   * new result frame arrives, or timeoutMs elapses. Absorbs variable test
   * durations (long tests hold the handshake unread; frames sent while the
   * DUT is busy are simply lost and retried).
   */
  | { type: "get-result"; timeoutMs: number; retryMs?: number }
  | { type: "send-raw"; hex: string; note?: string }
  | { type: "wait"; ms: number }
  /** Break pulse on our TX line = falling edge on the DUT wake pin (STOP/IDLE wake). */
  | { type: "wake-pulse"; ms?: number }
  | { type: "collect-frames"; count: number; timeoutMs: number }
  /** Wait for raw bytes outside of valid frames (e.g. UART echo byte). */
  | { type: "expect-extra"; hex: string; timeoutMs: number }
  /** Drop buf/frames/extras — align state before a timing probe (avoid echo pollution). */
  | { type: "clear-state" }
  /**
   * Set DTR/RTS/Break. If holdMs is set, restore the changed lines after the hold.
   * Sequence engine also restores a full snapshot on finish.
   */
  | { type: "signals"; dtr?: boolean; rts?: boolean; break?: boolean; holdMs?: number }
  /** Repeat nested steps N times (LED keep-alive spam etc.). */
  | {
      type: "repeat";
      times: number;
      steps: DutAction[];
      abortOnFail?: boolean;
      logRepeat?: "aggregate" | "each";
    }
  /**
   * Poll: send probe on an interval until match or timeout.
   * matchHex is matched against NEW frame hex (frame-hex) or raw stream (raw-hex).
   */
  | {
      type: "poll";
      send: { frame?: { cmd: number | string; p1?: number | string; p2?: number | string }; hex?: string };
      intervalMs: number;
      timeoutMs: number;
      matchHex?: string;
      matchMode?: "frame-hex" | "raw-hex";
      framesCount?: number;
      twoPhase?: boolean;
      ignoreExisting?: boolean;
      mark?: string;
    };

/** Runtime annotation fields (sequence log / baseline). */
export type DutAction = DutActionBase & {
  mark?: string;
  /** Marks this step as the recovery-time baseline (recoveryMs = match - this.atMs). */
  baseline?: boolean;
};

export interface DutJudge {
  /** Collected frame 0 must byte-equal the dispatched frame (DUT echo). */
  echoMatches?: boolean;
  /** Collected frame[resultIdx] byte0 must equal the dispatched cmd byte. */
  resultEchoesCmd?: boolean;
  /** Which collected frame is "the result" (0 = echo at index 0, result at 1). */
  resultIdx?: number;
  /** Expected byte values on the result frame, e.g. {"1": 0, "2": 0}. */
  bytes?: Record<string, number | string>;
  /** Per-frame byte expectations (index aligned with ALL collected frames); null = report only. */
  framesBytes?: Array<Record<string, number | string> | null>;
  /** Hex sequence expected among extra (non-frame) bytes. */
  extraContains?: string;
}

export interface DutCommandDef {
  name: string;
  /** Human-readable description shown to the AI agent. */
  title: string;
  actions: DutAction[];
  judge?: DutJudge;
  /** Meaning of overridable p1/p2/cmd parameters. */
  params?: { cmd?: string; p1?: string; p2?: string };
  note?: string;
  /** Whether this test is meaningful on FPGA (digital-only) vs real silicon. */
  fpgaSuitable?: boolean;
}

export interface DutProfile {
  name: string;
  chip: string;
  description: string;
  serial: {
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: string;
    /** Wiring hints for the test board. */
    wiring?: string;
  };
  frame: FrameDescriptor;
  commands: DutCommandDef[];
  /** Command names run by dut_smoke. */
  smoke?: string[];
}

/** A frame successfully parsed out of the RX byte stream. */
export interface ParsedFrame {
  bytes: number[];
  timestamp: string;
}

export interface DutRunResult {
  command: string;
  title: string;
  verdict: "PASS" | "FAIL" | "REPORT" | "TIMEOUT";
  sent: string[];              // hex strings of frames/bytes we sent
  frames: ParsedFrame[];       // valid frames received
  extras: number[];            // raw bytes outside frames (echo bytes, noise)
  failedChecks: string[];
  elapsedMs: number;
  note?: string;
}

/** One step log entry from dut_sequence. */
export interface DutSequenceStepLog {
  i: number;
  action: string;
  atMs: number;
  mark?: string;
  baseline?: boolean;
  sent?: string[];
  frames?: string[];
  extras?: number[];
  attempts?: number;
  firstMatchAtMs?: number;
  matchedFrameHex?: string;
  verdict?: "ok" | "timeout" | "matched" | "failed" | "skipped";
  note?: string;
  stopped?: "budget" | "aborted";
  completed?: number;
  times?: number;
}

export interface DutSequenceResult {
  ok: boolean;
  elapsedMs: number;
  stopped: null | "budget" | "aborted";
  abortReason?: string;
  steps: DutSequenceStepLog[];
  summary: {
    firstRxLatencyMs?: number;
    recoveryMs?: number;
    framesParsed: number;
    extras: number;
    framesSent: number;
  };
}

export interface DutSequenceOptions {
  totalBudgetMs?: number;
  abortOnError?: boolean;
  captureFrames?: "match" | "all" | "none";
}
