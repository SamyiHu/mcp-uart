/**
 * Minimal serial backend interface the Hub needs.
 * SerialManager satisfies this; tests inject a fake.
 */
import type { ConnectionInfo, MessageFilter, SerialConfig, SerialMessage } from "../types.js";

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
