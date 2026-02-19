/**
 * SSE (Server-Sent Events) stream parser.
 *
 * Parses a `text/event-stream` response body into discrete SSE events.
 * No external dependencies — just the Web Streams API.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SSEEvent {
  id?: string;
  event?: string;
  data: string;
}

// ---------------------------------------------------------------------------
// Stream parser
// ---------------------------------------------------------------------------

/**
 * Async generator that yields parsed SSE events from a ReadableStream.
 *
 * Follows the SSE spec: events are separated by blank lines, and each
 * line is either `field: value` or `field:value`.
 */
export const MAX_SSE_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let trailingCR = false;

  try {
    while (true) {
      if (signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      let chunk = decoder.decode(value, { stream: true });

      // Handle \r\n split across chunks: previous chunk ended with \r,
      // this chunk starts with \n — that's a single line break, not two.
      if (trailingCR && chunk.startsWith("\n")) {
        chunk = chunk.slice(1);
      }
      trailingCR = chunk.endsWith("\r");

      // Normalize \r\n and standalone \r to \n per SSE spec (chunk only)
      buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      if (buffer.length > MAX_SSE_BUFFER_SIZE) {
        throw new Error(`SSE buffer exceeded maximum size of ${MAX_SSE_BUFFER_SIZE} bytes`);
      }

      // Process complete events (separated by double newlines)
      const parts = buffer.split("\n\n");
      // Keep the last part as it may be incomplete
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const event = parseSSEBlock(part);
        if (event) yield event;
      }
    }

    // Process any remaining data in the buffer
    if (buffer.trim().length > 0) {
      const event = parseSSEBlock(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Data parser
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string from an SSE data field.
 * Returns null if parsing fails.
 */
export function parseSSEData<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseSSEBlock(block: string): SSEEvent | null {
  const lines = block.split("\n");
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("id:")) {
      id = line.slice(3).trimStart();
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trimStart();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    } else if (line.startsWith(":")) {
      // Comment line — ignore
    }
  }

  if (dataLines.length === 0) return null;

  return {
    id,
    event,
    data: dataLines.join("\n"),
  };
}
