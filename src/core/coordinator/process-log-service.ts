/**
 * ProcessLogService — ring-buffer for process output per session.
 *
 * Extracted from SessionCoordinator to keep the coordinator focused on
 * orchestration. Handles append (with secret redaction), cleanup, and
 * a read API for future consumers.
 */

import { redactSecrets } from "../../utils/redact-secrets.js";

const MAX_LOG_LINES = 500;

export class ProcessLogService {
  private buffers = new Map<string, string[]>();

  /**
   * Append process output to the session's ring buffer.
   * Returns the redacted text so callers can forward it.
   */
  append(sessionId: string, _stream: "stdout" | "stderr", data: string): string {
    const redacted = redactSecrets(data);
    const buffer = this.buffers.get(sessionId) ?? [];
    const lines = redacted.split("\n").filter((l) => l.trim());
    buffer.push(...lines);
    if (buffer.length > MAX_LOG_LINES) {
      buffer.splice(0, buffer.length - MAX_LOG_LINES);
    }
    this.buffers.set(sessionId, buffer);
    return redacted;
  }

  /** Remove the buffer for a closed session. */
  cleanup(sessionId: string): void {
    this.buffers.delete(sessionId);
  }

  // Future use
  get(sessionId: string): readonly string[] {
    return this.buffers.get(sessionId) ?? [];
  }
}
