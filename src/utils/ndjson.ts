/**
 * NDJSON (Newline-Delimited JSON) parsing utilities.
 *
 * Two modes:
 * - Frame-based: WebSocket messages arrive as complete frames (parseNDJSON)
 * - Stream-based: Data arrives in arbitrary chunks via stdout pipes (NDJSONLineBuffer)
 */

/**
 * Parse a complete NDJSON frame (e.g., from a WebSocket message).
 * Splits on newlines, skips empty lines, parses each line as JSON.
 * Returns an array of parsed objects and any lines that failed to parse.
 */
export function parseNDJSON<T = unknown>(data: string): { messages: T[]; errors: string[] } {
  const messages: T[] = [];
  const errors: string[] = [];

  const lines = data.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      messages.push(JSON.parse(trimmed) as T);
    } catch {
      errors.push(trimmed);
    }
  }

  return { messages, errors };
}

/**
 * Serialize a value to an NDJSON line (JSON + newline delimiter).
 */
export function serializeNDJSON(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Line buffer for stream-based NDJSON (e.g., piping stdout from a CLI process).
 *
 * Data arrives in arbitrary chunks that may split across JSON lines or even
 * across UTF-8 multi-byte characters. This buffer accumulates partial data
 * and yields complete lines.
 */
export class NDJSONLineBuffer {
  private buffer = "";
  private decoder = new TextDecoder("utf-8", { fatal: false });

  /**
   * Feed raw bytes or a string into the buffer.
   * Returns an array of complete, non-empty lines ready for JSON.parse().
   */
  feed(chunk: string | Uint8Array): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buffer += text;

    const lines: string[] = [];

    // Handle both \n and \r\n line endings
    let newlineIdx = this.buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      let line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      newlineIdx = this.buffer.indexOf("\n");

      // Strip trailing \r for \r\n
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      const trimmed = line.trim();
      if (trimmed) {
        lines.push(trimmed);
      }
    }

    return lines;
  }

  /**
   * Flush any remaining data in the buffer (e.g., on connection close).
   * Returns a final line if there's non-empty data without a trailing newline.
   */
  flush(): string | null {
    const remaining = this.buffer.trim();
    this.buffer = "";
    return remaining || null;
  }

  /** Reset the buffer, discarding any accumulated partial data. */
  reset(): void {
    this.buffer = "";
  }

  /** Current buffer size in characters. */
  get size(): number {
    return this.buffer.length;
  }
}
