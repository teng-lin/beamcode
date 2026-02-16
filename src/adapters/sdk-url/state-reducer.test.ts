import { describe, expect, it } from "vitest";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { SessionState } from "../../types/session-state.js";
import { reduce } from "./state-reducer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefaultState(): SessionState {
  return {
    session_id: "sess-1",
    model: "",
    cwd: "",
    tools: [],
    permissionMode: "default",
    claude_code_version: "",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("state-reducer", () => {
  describe("session_init", () => {
    it("updates model, cwd, tools, and other init fields", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "session_init",
        role: "system",
        metadata: {
          model: "claude-sonnet-4-5-20250929",
          cwd: "/home/user/project",
          tools: ["Read", "Write"],
          permissionMode: "plan",
          claude_code_version: "1.0.0",
          mcp_servers: [{ name: "local", status: "connected" }],
          agents: ["planner"],
          slash_commands: ["/help"],
          skills: ["tdd"],
        },
      });

      const next = reduce(state, msg);

      expect(next).not.toBe(state); // new object
      expect(next.model).toBe("claude-sonnet-4-5-20250929");
      expect(next.cwd).toBe("/home/user/project");
      expect(next.tools).toEqual(["Read", "Write"]);
      expect(next.permissionMode).toBe("plan");
      expect(next.claude_code_version).toBe("1.0.0");
      expect(next.mcp_servers).toEqual([{ name: "local", status: "connected" }]);
      expect(next.agents).toEqual(["planner"]);
      expect(next.slash_commands).toEqual(["/help"]);
      expect(next.skills).toEqual(["tdd"]);
    });

    it("preserves fields not present in metadata", () => {
      const state = { ...makeDefaultState(), total_cost_usd: 0.5, num_turns: 3 };
      const msg = createUnifiedMessage({
        type: "session_init",
        role: "system",
        metadata: { model: "claude-opus-4-6" },
      });

      const next = reduce(state, msg);
      expect(next.total_cost_usd).toBe(0.5);
      expect(next.num_turns).toBe(3);
      expect(next.model).toBe("claude-opus-4-6");
    });

    it("does not mutate original state", () => {
      const state = makeDefaultState();
      const original = { ...state };
      const msg = createUnifiedMessage({
        type: "session_init",
        role: "system",
        metadata: { model: "claude-opus-4-6" },
      });

      reduce(state, msg);
      expect(state).toEqual(original);
    });
  });

  describe("status_change", () => {
    it("sets is_compacting true when status is compacting", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: "compacting" },
      });

      const next = reduce(state, msg);
      expect(next.is_compacting).toBe(true);
    });

    it("sets is_compacting false when status is not compacting", () => {
      const state = { ...makeDefaultState(), is_compacting: true };
      const msg = createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: null },
      });

      const next = reduce(state, msg);
      expect(next.is_compacting).toBe(false);
    });

    it("updates permissionMode when provided", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: null, permissionMode: "plan" },
      });

      const next = reduce(state, msg);
      expect(next.permissionMode).toBe("plan");
    });

    it("leaves permissionMode unchanged when not provided", () => {
      const state = { ...makeDefaultState(), permissionMode: "default" };
      const msg = createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: null },
      });

      const next = reduce(state, msg);
      expect(next.permissionMode).toBe("default");
    });
  });

  describe("result", () => {
    it("updates cost and turn counts", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: {
          total_cost_usd: 0.05,
          num_turns: 3,
        },
      });

      const next = reduce(state, msg);
      expect(next.total_cost_usd).toBe(0.05);
      expect(next.num_turns).toBe(3);
    });

    it("updates line counts when present", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: {
          total_cost_usd: 0,
          num_turns: 1,
          total_lines_added: 42,
          total_lines_removed: 10,
        },
      });

      const next = reduce(state, msg);
      expect(next.total_lines_added).toBe(42);
      expect(next.total_lines_removed).toBe(10);
    });

    it("computes context_used_percent from modelUsage", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: {
          total_cost_usd: 0.05,
          num_turns: 1,
          modelUsage: {
            "claude-sonnet-4-5-20250929": {
              inputTokens: 50000,
              outputTokens: 10000,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              contextWindow: 200000,
              costUSD: 0.05,
            },
          },
        },
      });

      const next = reduce(state, msg);
      // (50000 + 10000) / 200000 * 100 = 30
      expect(next.context_used_percent).toBe(30);
      expect(next.last_model_usage).toBeDefined();
    });

    it("updates duration fields", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: {
          total_cost_usd: 0,
          num_turns: 1,
          duration_ms: 1200,
          duration_api_ms: 800,
        },
      });

      const next = reduce(state, msg);
      expect(next.last_duration_ms).toBe(1200);
      expect(next.last_duration_api_ms).toBe(800);
    });

    it("does not mutate original state", () => {
      const state = makeDefaultState();
      const original = { ...state };
      const msg = createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: { total_cost_usd: 0.1, num_turns: 5 },
      });

      reduce(state, msg);
      expect(state).toEqual(original);
    });
  });

  describe("control_response", () => {
    it("sets capabilities on success", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: "req-1",
          response: {
            commands: [{ name: "/help", description: "Get help" }],
            models: [{ value: "claude-sonnet-4-5-20250929", displayName: "Sonnet" }],
            account: { email: "user@example.com" },
          },
        },
      });

      const next = reduce(state, msg);
      expect(next.capabilities).toBeDefined();
      expect(next.capabilities!.commands).toHaveLength(1);
      expect(next.capabilities!.models).toHaveLength(1);
      expect(next.capabilities!.account).toEqual({ email: "user@example.com" });
      expect(next.capabilities!.receivedAt).toBeGreaterThan(0);
    });

    it("returns original state on error subtype", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "error",
          request_id: "req-1",
          error: "Something failed",
        },
      });

      const next = reduce(state, msg);
      expect(next).toBe(state); // same reference — no mutation
    });

    it("returns original state when response is missing", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: "req-1",
        },
      });

      const next = reduce(state, msg);
      expect(next).toBe(state);
    });

    it("defaults commands/models to empty arrays if not present in response", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: "req-1",
          response: {},
        },
      });

      const next = reduce(state, msg);
      expect(next.capabilities!.commands).toEqual([]);
      expect(next.capabilities!.models).toEqual([]);
      expect(next.capabilities!.account).toBeNull();
    });
  });

  describe("unhandled message types", () => {
    it("returns original state for assistant messages (no state mutation)", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      });

      const next = reduce(state, msg);
      expect(next).toBe(state);
    });

    it("returns original state for stream_event messages", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "stream_event",
        role: "system",
        metadata: { event: {} },
      });

      const next = reduce(state, msg);
      expect(next).toBe(state);
    });

    it("returns original state for tool_progress messages", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "tool_progress",
        role: "tool",
        metadata: { tool_use_id: "tu-1" },
      });

      const next = reduce(state, msg);
      expect(next).toBe(state);
    });

    it("returns original state for auth_status messages", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "auth_status",
        role: "system",
        metadata: { isAuthenticating: true },
      });

      const next = reduce(state, msg);
      expect(next).toBe(state);
    });
  });
});
