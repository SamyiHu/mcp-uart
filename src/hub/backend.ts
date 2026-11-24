/**
 * Minimal serial backend interface the Hub needs.
 * SerialManager satisfies this; tests inject a fake.
 */
import type { ConnectionInfo, MessageFilter, SerialConfig, SerialMessage } from "../types.js";
import type { DutRunResult } from "../dut/types.js";

export type HubFrame = SerialMessage & { seq: number };

export interface HubBackend {
  listPorts(): Promise<Array<{ path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string; pnpId?: string }>>;
  open(config: SerialConfig): Promise<{ connectionId: string; status: string }>;
  close(connectionId: string): Promise<void>;
  write(connectionId: string, data: string, encoding?: string): Promise<{ bytesWritten: number; raw: string }>;
  getInfo(connectionId: string): ConnectionInfo;
  listConnections(): ConnectionInfo[];
  peekMessages(connectionId: string, filter?: MessageFilter): SerialMessage[];
  readFiltered(connectionId: string, filter?: MessageFilter, opts?: { advanceCursor?: boolean }): SerialMessage[];
  reconfigure(connectionId: string, updates: Partial<SerialConfig>): Promise<ConnectionInfo>;
  setSignals(connectionId: string, signals: { break?: boolean; dtr?: boolean; rts?: boolean }): Promise<void>;
  onMessage(connectionId: string, cb: (msg: SerialMessage) => void): () => void;
}

/**
 * DUT façade the Hub offers when a DUT manager is present.
 *
 * The Hub itself only knows ports and frames; a DUT session adds a profile
 * (frame format, command table, judge rules) on top of one connection. Every
 * call names a connection or inherits the Hub's active one, so the panel and
 * the agent keep working on the same session.
 */
export type DutProfileSummary = {
  name: string;
  chip: string;
  description: string;
  serial: {
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: string;
    wiring?: string;
  };
  frame: { length: number; checksumIndex: number; checksum: string };
  commands: Array<{ name: string; title: string; fpgaSuitable: boolean; note?: string }>;
  smoke: string[];
};

export type DutStats = {
  framesParsed: number;
  framesSent: number;
  rawBytesSent: number;
  noiseBytes: number;
};

export type DutStatus = {
  connected: boolean;
  connectionId: string | null;
  profile: string | null;
  chip: string | null;
  port: string | null;
  baudRate: number | null;
  stats: DutStats | null;
};

export type DutSmokeSummary = {
  profile: string;
  passed: number;
  failed: number;
  report: number;
  allPassed: boolean;
  elapsedMs: number;
};

export type DutSmokeResult = DutSmokeSummary & { steps: DutRunResult[] };

/** Progress an SSE client can watch while a smoke run is in flight. */
export type DutEvent =
  | { kind: "smoke-start"; profile: string; total: number }
  | { kind: "smoke-step"; index: number; total: number; step: DutRunResult }
  | { kind: "smoke-done"; summary: DutSmokeSummary };

export interface HubDut {
  /** True while a long-running run holds the serial line. */
  busy(): boolean;
  profiles(): DutProfileSummary[];
  status(connectionId?: string | null): DutStatus;
  connect(options: {
    profile: string;
    path?: string;
    baudRate?: number;
    connectionId?: string | null;
  }): Promise<{ connectionId: string; opened: boolean; status: DutStatus }>;
  disconnect(options?: { connectionId?: string | null; closePort?: boolean }): Promise<void>;
  runCommand(name: string, connectionId?: string | null): Promise<DutRunResult>;
  runSmoke(
    options: { includeLowPower?: boolean; connectionId?: string | null },
    onEvent?: (event: DutEvent) => void
  ): Promise<DutSmokeResult>;
}
