import { ReadlineParser } from "@serialport/parser-readline";
import { DelimiterParser } from "@serialport/parser-delimiter";
import { Transform } from "stream";
import type { ProtocolMode, SerialConfig } from "./types.js";

/**
 * Create a parser transform stream based on the protocol mode.
 */
export function createParser(config: SerialConfig): NodeJS.ReadWriteStream | null {
  switch (config.protocol) {
    case "line":
      return new ReadlineParser({ delimiter: "\r\n", includeDelimiter: false, encoding: undefined });

    case "delimiter": {
      const delimHex = config.delimiter || "0D0A";
      const delimBuf = Buffer.from(delimHex, "hex");
      return new DelimiterParser({ delimiter: delimBuf, includeDelimiter: false });
    }

    case "hex-frame":
      return createHexFrameParser(
        config.frameStart ? Buffer.from(config.frameStart, "hex") : null,
        config.frameEnd ? Buffer.from(config.frameEnd, "hex") : Buffer.from("0D0A", "hex")
      );

    case "modbus-rtu":
      return createModbusRtuParser();

    case "slip":
      return createSlipParser();

    case "raw":
    default:
      return null; // No parser, pass through raw data
  }
}

/**
 * Hex frame parser: collects bytes between start marker and end marker.
 * If no start marker, collects until end marker is found.
 */
function createHexFrameParser(startMarker: Buffer | null, endMarker: Buffer): Transform {
  let buffer = Buffer.alloc(0);
  let inFrame = !startMarker; // If no start marker, we're always "in frame"

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      buffer = Buffer.concat([buffer, chunk]);

      while (true) {
        if (!inFrame) {
          // Look for start marker
          const startIdx = buffer.indexOf(startMarker!);
          if (startIdx === -1) {
            // Keep last (startMarker.length - 1) bytes in case of partial match
            if (buffer.length > startMarker!.length) {
              buffer = buffer.subarray(buffer.length - startMarker!.length);
            }
            break;
          }
          buffer = buffer.subarray(startIdx + startMarker!.length);
          inFrame = true;
        }

        // Look for end marker
        const endIdx = buffer.indexOf(endMarker);
        if (endIdx === -1) break;

        const frame = buffer.subarray(0, endIdx);
        buffer = buffer.subarray(endIdx + endMarker.length);
        inFrame = !startMarker;
        if (frame.length > 0) {
          this.push(frame);
        }
      }
      callback();
    },
  });
}

/**
 * Modbus RTU frame parser.
 * Frames are identified by silence gaps (≥3.5 char times) between frames.
 * At 115200 baud, 3.5 char times ≈ 0.3ms — we use a conservative 10ms gap.
 */
function createModbusRtuParser(): Transform {
  let buffer = Buffer.alloc(0);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const GAP_MS = 10; // Inter-frame gap in ms

  const flushFrame = function (this: Transform) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length > 0) {
      // Validate minimum Modbus RTU frame: addr(1) + func(1) + crc(2) = 4 bytes
      if (buffer.length >= 4) {
        this.push(Buffer.from(buffer));
      }
      buffer = Buffer.alloc(0);
    }
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (timer) clearTimeout(timer);
      buffer = Buffer.concat([buffer, chunk]);
      timer = setTimeout(() => flushFrame.call(this), GAP_MS);
      callback();
    },
    flush(callback) {
      if (buffer.length >= 4) {
        this.push(Buffer.from(buffer));
      }
      if (timer) clearTimeout(timer);
      callback();
    },
  });
}

/**
 * SLIP protocol parser (RFC 1055).
 * END = 0xC0, ESC = 0xDB, ESC_END = 0xDC, ESC_ESC = 0xDD.
 */
function createSlipParser(): Transform {
  let frame: number[] = [];
  let escaped = false;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      for (const byte of chunk) {
        if (byte === 0xc0) {
          // END: emit frame if we have data
          if (frame.length > 0) {
            this.push(Buffer.from(frame));
            frame = [];
          }
          escaped = false;
          continue;
        }
        if (byte === 0xdb) {
          // ESC: next byte is escaped
          escaped = true;
          continue;
        }
        if (escaped) {
          escaped = false;
          if (byte === 0xdc) {
            frame.push(0xc0); // ESC_END → 0xC0
            continue;
          }
          if (byte === 0xdd) {
            frame.push(0xdb); // ESC_ESC → 0xDB
            continue;
          }
          // Invalid escape, push both
          frame.push(0xdb);
        }
        frame.push(byte);
      }
      callback();
    },
    flush(callback) {
      if (frame.length > 0) {
        this.push(Buffer.from(frame));
      }
      callback();
    },
  });
}

/**
 * List all supported protocol modes with descriptions.
 */
export function listProtocols(): Array<{ name: ProtocolMode; description: string }> {
  return [
    { name: "raw", description: "No parsing — raw byte stream, data delivered as-is" },
    { name: "line", description: "Line-based — splits on \\r\\n (newline-delimited)" },
    { name: "delimiter", description: "Custom delimiter — splits on configurable hex byte sequence" },
    { name: "modbus-rtu", description: "Modbus RTU — detects frame boundaries by inter-frame silence gap" },
    { name: "hex-frame", description: "Hex frame — extracts data between configurable start/end hex markers" },
    { name: "slip", description: "SLIP (RFC 1055) — de-frames SLIP-encoded packets (END=0xC0, ESC=0xDB)" },
  ];
}
