/**
 * Shared tool response helpers: human text for the chat, machine data
 * as structuredContent for agents.
 */

export type ToolOk = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export type ToolErr = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { ok: false; error: string };
  isError: true;
};

export function ok(data: Record<string, unknown>, human?: string): ToolOk {
  return {
    content: [
      {
        type: "text" as const,
        text: human ?? JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data,
  };
}

export function fail(message: string): ToolErr {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { ok: false, error: message },
    isError: true,
  };
}

export function jsonError(message: string): string {
  return message;
}
