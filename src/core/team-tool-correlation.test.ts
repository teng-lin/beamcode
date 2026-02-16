import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamToolCorrelationBuffer } from "./team-tool-correlation.js";
import type { RecognizedTeamToolUse } from "./team-tool-recognizer.js";
import type { ToolResultContent } from "./types/unified-message.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecognized(overrides?: Partial<RecognizedTeamToolUse>): RecognizedTeamToolUse {
  return {
    toolName: "TaskCreate",
    toolUseId: "tu-1",
    category: "team_task_update",
    input: { subject: "Fix bug" },
    ...overrides,
  };
}

function makeToolResult(overrides?: Partial<ToolResultContent>): ToolResultContent {
  return {
    type: "tool_result",
    tool_use_id: "tu-1",
    content: '{"id": "3"}',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TeamToolCorrelationBuffer", () => {
  let buffer: TeamToolCorrelationBuffer;

  beforeEach(() => {
    buffer = new TeamToolCorrelationBuffer();
  });

  // ---------------------------------------------------------------------------
  // Buffer → correlate → pair returned correctly
  // ---------------------------------------------------------------------------

  describe("basic correlation", () => {
    it("returns correlated pair when tool_result matches buffered tool_use", () => {
      const recognized = makeRecognized();
      buffer.onToolUse(recognized);

      const result = makeToolResult();
      const correlated = buffer.onToolResult(result);

      expect(correlated).toBeDefined();
      expect(correlated!.recognized).toBe(recognized);
      expect(correlated!.result).toBe(result);
    });

    it("removes entry from buffer after successful correlation", () => {
      buffer.onToolUse(makeRecognized());
      expect(buffer.pendingCount).toBe(1);

      buffer.onToolResult(makeToolResult());
      expect(buffer.pendingCount).toBe(0);
    });

    it("handles multiple concurrent tool_use → tool_result pairs", () => {
      const r1 = makeRecognized({ toolUseId: "tu-a" });
      const r2 = makeRecognized({ toolUseId: "tu-b" });
      buffer.onToolUse(r1);
      buffer.onToolUse(r2);
      expect(buffer.pendingCount).toBe(2);

      const c1 = buffer.onToolResult(makeToolResult({ tool_use_id: "tu-a" }));
      expect(c1).toBeDefined();
      expect(c1!.recognized.toolUseId).toBe("tu-a");
      expect(buffer.pendingCount).toBe(1);

      const c2 = buffer.onToolResult(makeToolResult({ tool_use_id: "tu-b" }));
      expect(c2).toBeDefined();
      expect(c2!.recognized.toolUseId).toBe("tu-b");
      expect(buffer.pendingCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Correlate without buffer → returns undefined (no crash)
  // ---------------------------------------------------------------------------

  describe("no match", () => {
    it("returns undefined when no buffered tool_use matches", () => {
      const result = buffer.onToolResult(makeToolResult());
      expect(result).toBeUndefined();
    });

    it("returns undefined for tool_result with unknown tool_use_id", () => {
      buffer.onToolUse(makeRecognized({ toolUseId: "tu-x" }));
      const result = buffer.onToolResult(makeToolResult({ tool_use_id: "tu-y" }));
      expect(result).toBeUndefined();
      expect(buffer.pendingCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Error results
  // ---------------------------------------------------------------------------

  describe("error results", () => {
    it("returns correlated pair with is_error flag when tool_result has error", () => {
      buffer.onToolUse(makeRecognized());
      const errorResult = makeToolResult({
        is_error: true,
        content: "Error: permission denied",
      });
      const correlated = buffer.onToolResult(errorResult);

      expect(correlated).toBeDefined();
      expect(correlated!.result).toBe(errorResult);
      expect(correlated!.result!.is_error).toBe(true);
    });

    it("clears entry from buffer on error result", () => {
      buffer.onToolUse(makeRecognized());
      expect(buffer.pendingCount).toBe(1);

      buffer.onToolResult(makeToolResult({ is_error: true }));
      expect(buffer.pendingCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Duplicate tool_use ID → overwrites (last write wins)
  // ---------------------------------------------------------------------------

  describe("duplicate handling", () => {
    it("overwrites on duplicate tool_use ID (last write wins)", () => {
      const first = makeRecognized({
        toolUseId: "tu-dup",
        toolName: "TaskCreate",
      });
      const second = makeRecognized({
        toolUseId: "tu-dup",
        toolName: "TaskUpdate",
      });
      buffer.onToolUse(first);
      buffer.onToolUse(second);

      expect(buffer.pendingCount).toBe(1);

      const correlated = buffer.onToolResult(makeToolResult({ tool_use_id: "tu-dup" }));
      expect(correlated).toBeDefined();
      expect(correlated!.recognized.toolName).toBe("TaskUpdate");
    });
  });

  // ---------------------------------------------------------------------------
  // Flush — discard stale entries
  // ---------------------------------------------------------------------------

  describe("flush", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("discards entries older than maxAgeMs", () => {
      buffer.onToolUse(makeRecognized({ toolUseId: "tu-old" }));
      expect(buffer.pendingCount).toBe(1);

      // Advance time by 31 seconds (past 30s TTL)
      vi.advanceTimersByTime(31_000);

      const discarded = buffer.flush(30_000);
      expect(discarded).toBe(1);
      expect(buffer.pendingCount).toBe(0);
    });

    it("keeps entries within maxAgeMs", () => {
      buffer.onToolUse(makeRecognized({ toolUseId: "tu-new" }));

      // Advance only 10 seconds
      vi.advanceTimersByTime(10_000);

      const discarded = buffer.flush(30_000);
      expect(discarded).toBe(0);
      expect(buffer.pendingCount).toBe(1);
    });

    it("selectively discards only stale entries", () => {
      buffer.onToolUse(makeRecognized({ toolUseId: "tu-early" }));

      // Advance 20 seconds, then add another
      vi.advanceTimersByTime(20_000);
      buffer.onToolUse(makeRecognized({ toolUseId: "tu-late" }));

      // Advance another 15 seconds (total: 35s for early, 15s for late)
      vi.advanceTimersByTime(15_000);

      const discarded = buffer.flush(30_000);
      expect(discarded).toBe(1); // only tu-early is stale
      expect(buffer.pendingCount).toBe(1);

      // The remaining entry should be tu-late
      const correlated = buffer.onToolResult(makeToolResult({ tool_use_id: "tu-late" }));
      expect(correlated).toBeDefined();
    });

    it("returns 0 when buffer is empty", () => {
      const discarded = buffer.flush(30_000);
      expect(discarded).toBe(0);
    });

    it("returns 0 when nothing is stale", () => {
      buffer.onToolUse(makeRecognized());
      const discarded = buffer.flush(30_000);
      expect(discarded).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // pendingCount tracking
  // ---------------------------------------------------------------------------

  describe("pendingCount", () => {
    it("starts at 0", () => {
      expect(buffer.pendingCount).toBe(0);
    });

    it("increments on onToolUse", () => {
      buffer.onToolUse(makeRecognized({ toolUseId: "tu-a" }));
      expect(buffer.pendingCount).toBe(1);
      buffer.onToolUse(makeRecognized({ toolUseId: "tu-b" }));
      expect(buffer.pendingCount).toBe(2);
    });

    it("decrements on successful correlation", () => {
      buffer.onToolUse(makeRecognized({ toolUseId: "tu-a" }));
      buffer.onToolUse(makeRecognized({ toolUseId: "tu-b" }));
      buffer.onToolResult(makeToolResult({ tool_use_id: "tu-a" }));
      expect(buffer.pendingCount).toBe(1);
    });

    it("does not change on non-matching tool_result", () => {
      buffer.onToolUse(makeRecognized({ toolUseId: "tu-a" }));
      buffer.onToolResult(makeToolResult({ tool_use_id: "tu-z" }));
      expect(buffer.pendingCount).toBe(1);
    });

    it("does not go below 0 for duplicate tool_use IDs", () => {
      buffer.onToolUse(makeRecognized({ toolUseId: "tu-dup" }));
      buffer.onToolUse(makeRecognized({ toolUseId: "tu-dup" }));
      expect(buffer.pendingCount).toBe(1); // overwritten, not duplicated
    });
  });
});
