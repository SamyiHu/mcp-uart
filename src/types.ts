import { SerialPort } from "serialport";

export type BaudRate =
  | 110 | 300 | 600 | 1200 | 2400 | 4800 | 9600 | 14400
  | 19200 | 28800 | 38400 | 56000 | 57600 | 115200
  | 128000 | 230400 | 256000 | 460800 | 921600;

export type DataBits = 5 | 6 | 7 | 8;
export type StopBits = 1 | 1.5 | 2;
export type Parity = "none" | "odd" | "even" | "mark" | "space";
export type FlowControl = "none" | "hardware" | "software";

export type Encoding =
  | "utf8" | "ascii" | "latin1"
  | "gbk" | "gb2312" | "gb18030"
  | "big5" | "shift_jis" | "euc-kr"
  | "hex" | "base64" | "binary";

export type ProtocolMode =
  | "raw"           // No parsing, return raw bytes
  | "line"          // Newline-delimited lines
  | "delimiter"     // Custom delimiter
  | "modbus-rtu"    // Modbus RTU frame detection
  | "hex-frame"     // Hex frame with start/end markers
  | "slip";         // SLIP protocol (0xC0 framing)

export interface SerialConfig {
  path: string;
  baudRate: BaudRate;
  dataBits: DataBits;
  stopBits: StopBits;
  parity: Parity;
  flowControl: FlowControl;
  encoding: Encoding;
  protocol: ProtocolMode;
  delimiter?: string;       // For "delimiter" protocol: hex string e.g. "0D0A"
  frameStart?: string;      // For "hex-frame": start marker hex
  frameEnd?: string;        // For "hex-frame": end marker hex
  readTimeout?: number;     // ms, default 0 (non-blocking)
  bufferSize?: number;      // max messages to buffer, default 1000
  autoReconnect?: boolean;  // default false
  dtr?: boolean;            // DTR signal, default true
  rts?: boolean;            // RTS signal, default true
}

export const DEFAULT_CONFIG: Omit<SerialConfig, "path"> = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
  encoding: "utf8",
  protocol: "line",
  bufferSize: 1000,
  autoReconnect: false,
  dtr: true,
  rts: true,
};

export interface SerialMessage {
  timestamp: string;
  connectionId: string;
  data: string;       // Decoded data per encoding
  raw?: string;       // Hex representation of raw bytes
  length: number;     // Raw byte length
  direction: "rx" | "tx";
}

export interface ConnectionInfo {
  id: string;
  config: SerialConfig;
  status: "open" | "closed" | "error" | "reconnecting";
  openedAt: string;
  messageCount: number;
  lastActivity: string | null;
  error: string | null;
}

export interface ConnectionEntry {
  port: SerialPort;
  config: SerialConfig;
  messages: SerialMessage[];
  status: "open" | "closed" | "error" | "reconnecting";
  openedAt: Date;
  lastActivity: Date | null;
  error: string | null;
  messageCount: number;
  parser?: NodeJS.ReadWriteStream;
  rawListener?: (data: Buffer) => void;
  lastReadIndex: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempts: number;
  manualClose: boolean;
}

export interface ReadResult {
  messages: SerialMessage[];
  lastActivity: string | null;
  dataAge: number | null;
  newMessageCount: number;
  totalBuffered: number;
}

export interface WaitResponse {
  messages: SerialMessage[];
  totalBytes: number;
  elapsed: number;
  reason: "silence" | "timeout" | "first-frame";
  firstMessage: string | null;
  lastMessage: string | null;
}

export interface MessageFilter {
  direction?: "rx" | "tx" | "all";
  since?: string;
  count?: number;
  offset?: number;
  matchHex?: string;
  matchText?: string;
  minLength?: number;
  maxLength?: number;
  lastOnly?: boolean;
}
