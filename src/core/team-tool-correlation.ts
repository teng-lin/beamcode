/**
 * Team Tool Correlation Buffer — Phase 5.3
 *
 * Buffers pending team tool_use blocks and correlates them with incoming
 * tool_results. Solves the timing issue where tool_use arrives in one
 * message and tool_result arrives in a later message.
 *
 * - Keyed by toolUseId (tool_use.id ↔ tool_result.tool_use_id)
 * - Default TTL: 30 seconds
 * - On is_error results: entry cleared, pair returned with error flag
 */

import type { RecognizedTeamToolUse } from "./team-tool-recognizer.js";
import type { ToolResultContent } from "./types/unified-message.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingToolUse {
  recognized: RecognizedTeamToolUse;
  receivedAt: number;
}

export interface CorrelatedToolUse {
  recognized: RecognizedTeamToolUse;
  result?: ToolResultContent;
}

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

/**
 * Buffers pending tool_use blocks and correlates them with incoming tool_results.
 *
 * Lifecycle:
 * 1. onToolUse(recognized) — buffers the tool_use
 * 2. onToolResult(toolResultContent) — correlates and returns the pair
 * 3. flush(maxAgeMs) — discards stale entries older than maxAgeMs
 */
export class TeamToolCorrelationBuffer {
  private pending = new Map<string, PendingToolUse>();

  /** Buffer a recognized team tool_use for later correlation. */
  onToolUse(recognized: RecognizedTeamToolUse): void {
    this.pending.set(recognized.toolUseId, {
      recognized,
      receivedAt: Date.now(),
    });
  }

  /**
   * Attempt to correlate a tool_result with a buffered tool_use.
   * Returns the correlated pair if found, or undefined if no match.
   * If tool_result.is_error is true, clears the entry and returns
   * the pair with the result — the state reducer should skip state mutation.
   */
  onToolResult(result: ToolResultContent): CorrelatedToolUse | undefined {
    const entry = this.pending.get(result.tool_use_id);
    if (!entry) return undefined;

    this.pending.delete(result.tool_use_id);

    return {
      recognized: entry.recognized,
      result,
    };
  }

  /** Discard entries older than maxAgeMs. Returns count of discarded entries. */
  flush(maxAgeMs: number): number {
    const now = Date.now();
    let discarded = 0;

    for (const [id, entry] of this.pending) {
      if (now - entry.receivedAt > maxAgeMs) {
        this.pending.delete(id);
        discarded++;
      }
    }

    return discarded;
  }

  /** Number of pending (uncorrelated) entries. */
  get pendingCount(): number {
    return this.pending.size;
  }
}
