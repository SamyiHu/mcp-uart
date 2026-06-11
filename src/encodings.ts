import iconv from "iconv-lite";
import type { Encoding } from "./types.js";

/**
 * Decode a Buffer into a string using the specified encoding.
 */
export function decode(data: Buffer, encoding: Encoding): string {
  switch (encoding) {
    case "hex":
      return data.toString("hex").toUpperCase();
    case "base64":
      return data.toString("base64");
    case "binary":
      return data.toString("hex").toUpperCase();
    default:
      // iconv-lite handles: utf8, ascii, latin1, gbk, gb2312, gb18030, big5, shift_jis, euc-kr
      if (iconv.encodingExists(encoding)) {
        return iconv.decode(data, encoding);
      }
      return data.toString("utf8");
  }
}

/**
 * Encode a string into a Buffer using the specified encoding.
 */
export function encode(data: string, encoding: Encoding): Buffer {
  switch (encoding) {
    case "hex":
      return Buffer.from(data.replace(/\s+/g, ""), "hex");
    case "base64":
      return Buffer.from(data, "base64");
    case "binary":
      return Buffer.from(data.replace(/\s+/g, ""), "hex");
    default:
      if (iconv.encodingExists(encoding)) {
        return iconv.encode(data, encoding);
      }
      return Buffer.from(data, "utf8");
  }
}

/**
 * Get a hex dump of a buffer for display.
 */
export function toHexDump(data: Buffer): string {
  const lines: string[] = [];
  for (let i = 0; i < data.length; i += 16) {
    const slice = data.subarray(i, i + 16);
    const hex = Array.from(slice)
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
      .join(" ");
    const ascii = Array.from(slice)
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(
      `${i.toString(16).padStart(4, "0")}  ${hex.padEnd(48)}  ${ascii}`
    );
  }
  return lines.join("\n");
}

/**
 * List all supported encodings with descriptions.
 */
export function listEncodings(): Array<{ name: Encoding; description: string }> {
  return [
    { name: "utf8", description: "UTF-8 (default, universal Unicode)" },
    { name: "ascii", description: "7-bit ASCII" },
    { name: "latin1", description: "ISO-8859-1 / Latin-1 (Western European)" },
    { name: "gbk", description: "GBK (Simplified Chinese, Windows)" },
    { name: "gb2312", description: "GB2312 (Simplified Chinese, basic)" },
    { name: "gb18030", description: "GB18030 (Simplified Chinese, full)" },
    { name: "big5", description: "Big5 (Traditional Chinese)" },
    { name: "shift_jis", description: "Shift_JIS (Japanese)" },
    { name: "euc-kr", description: "EUC-KR (Korean)" },
    { name: "hex", description: "Hexadecimal string (e.g. '48656C6C6F')" },
    { name: "base64", description: "Base64 encoded" },
    { name: "binary", description: "Binary / raw hex (same as hex)" },
  ];
}
