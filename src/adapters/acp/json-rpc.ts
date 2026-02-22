/**
 * JSON-RPC 2.0 Codec for ACP communication.
 *
 * Minimal message framing: request/response/notification creation,
 * auto-incrementing IDs, and newline-delimited JSON encoding/decoding.
 */

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg;
}

export function isJsonRpcResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && !("method" in msg);
}

export function isJsonRpcNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

export class JsonRpcCodec {
  private nextId = 1;

  /** Create a request with auto-incrementing ID. Returns the ID and raw message. */
  createRequest(method: string, params?: unknown): { id: number; raw: JsonRpcRequest } {
    const id = this.nextId++;
    const raw: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    if (params !== undefined) {
      raw.params = params;
    }
    return { id, raw };
  }

  /** Create a notification (no ID, no response expected). */
  createNotification(method: string, params?: unknown): JsonRpcNotification {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method };
    if (params !== undefined) {
      msg.params = params;
    }
    return msg;
  }

  /** Create a success response echoing the request ID. */
  createResponse(id: number | string, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  /** Create an error response echoing the request ID. */
  createErrorResponse(id: number | string, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  /** Encode a message as a newline-delimited JSON string. */
  encode(msg: JsonRpcMessage): string {
    return `${JSON.stringify(msg)}\n`;
  }

  /** Decode a newline-delimited JSON string into a message. Throws on invalid JSON-RPC. */
  decode(line: string): JsonRpcMessage {
    const trimmed = line.trim();
    if (!trimmed) {
      throw new Error("Empty JSON-RPC message");
    }

    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    if (parsed.jsonrpc !== "2.0") {
      throw new Error(`Invalid JSON-RPC version: ${String(parsed.jsonrpc)}`);
    }

    return parsed as unknown as JsonRpcMessage;
  }
}
