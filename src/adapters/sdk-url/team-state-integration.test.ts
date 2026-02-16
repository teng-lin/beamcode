/**
 * Team State Integration Tests — Phase 5.6
 *
 * Tests that the state reducer correctly wires TeamToolCorrelationBuffer
 * and reduceTeamState into the existing state reduction pipeline.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { TeamToolCorrelationBuffer } from "../../core/team-tool-correlation.js";
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

describe("state-reducer team integration", () => {
  let buffer: TeamToolCorrelationBuffer;

  beforeEach(() => {
    buffer = new TeamToolCorrelationBuffer();
  });

  describe("tool_use buffering", () => {
    it("buffers TeamCreate tool_use for later correlation", () => {
      const state = makeDefaultState();
      const msg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "TeamCreate",
            input: { team_name: "my-team" },
          },
        ],
      });

      const next = reduce(state, msg, buffer);
      // State doesn't change until tool_result arrives
      expect(next.team).toBeUndefined();
      expect(buffer.pendingCount).toBe(1);
    });
  });

  describe("TeamCreate lifecycle", () => {
    it("applies TeamCreate when tool_result correlates with buffered tool_use", () => {
      const state = makeDefaultState();

      // Assistant message with TeamCreate tool_use
      const toolUseMsg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "TeamCreate",
            input: { team_name: "my-team" },
          },
        ],
      });
      const s1 = reduce(state, toolUseMsg, buffer);

      // Message with tool_result
      const toolResultMsg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-1",
            content: '{"success": true}',
          },
        ],
      });
      const s2 = reduce(s1, toolResultMsg, buffer);

      expect(s2.team).toBeDefined();
      expect(s2.team!.name).toBe("my-team");
      expect(s2.team!.role).toBe("lead");
      expect(s2.team!.members).toEqual([]);
      expect(s2.team!.tasks).toEqual([]);
    });
  });

  describe("Task spawn (member add)", () => {
    it("adds member via Task(team_name) tool_use + result", () => {
      const state: SessionState = {
        ...makeDefaultState(),
        team: {
          name: "my-team",
          role: "lead",
          members: [],
          tasks: [],
        },
      };

      // Task tool_use with team_name + name
      const toolUseMsg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-2",
            name: "Task",
            input: { team_name: "my-team", name: "worker-1", model: "claude-sonnet-4-5-20250929" },
          },
        ],
      });
      const s1 = reduce(state, toolUseMsg, buffer);

      const resultMsg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-2",
            content: '{"success": true}',
          },
        ],
      });
      const s2 = reduce(s1, resultMsg, buffer);

      expect(s2.team!.members).toHaveLength(1);
      expect(s2.team!.members[0]!.name).toBe("worker-1");
      expect(s2.team!.members[0]!.status).toBe("active");
    });
  });

  describe("backward compatibility", () => {
    it("populates agents[] from team.members", () => {
      const state: SessionState = {
        ...makeDefaultState(),
        team: {
          name: "my-team",
          role: "lead",
          members: [],
          tasks: [],
        },
      };

      const toolUseMsg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-2",
            name: "Task",
            input: { team_name: "my-team", name: "worker-1" },
          },
        ],
      });
      const s1 = reduce(state, toolUseMsg, buffer);

      const resultMsg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-2",
            content: "{}",
          },
        ],
      });
      const s2 = reduce(s1, resultMsg, buffer);

      expect(s2.agents).toEqual(["worker-1"]);
    });
  });

  describe("TeamDelete", () => {
    it("removes team and resets agents to []", () => {
      const state: SessionState = {
        ...makeDefaultState(),
        team: {
          name: "my-team",
          role: "lead",
          members: [
            { name: "worker-1", agentId: "w1", agentType: "general-purpose", status: "active" },
          ],
          tasks: [],
        },
        agents: ["worker-1"],
      };

      const toolUseMsg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-del",
            name: "TeamDelete",
            input: {},
          },
        ],
      });
      const s1 = reduce(state, toolUseMsg, buffer);

      const resultMsg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-del",
            content: '{"success": true}',
          },
        ],
      });
      const s2 = reduce(s1, resultMsg, buffer);

      expect(s2.team).toBeUndefined();
      expect(s2.agents).toEqual([]);
    });
  });

  describe("error handling", () => {
    it("skips state update on error tool_result", () => {
      const state: SessionState = {
        ...makeDefaultState(),
        team: {
          name: "my-team",
          role: "lead",
          members: [],
          tasks: [],
        },
      };

      const toolUseMsg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-err",
            name: "TaskCreate",
            input: { subject: "Fix bug" },
          },
        ],
      });
      const s1 = reduce(state, toolUseMsg, buffer);

      const errorResult = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-err",
            content: "Something went wrong",
            is_error: true,
          },
        ],
      });
      const s2 = reduce(s1, errorResult, buffer);

      expect(s2.team!.tasks).toEqual([]);
    });
  });

  describe("non-team tools", () => {
    it("does not affect state for regular tool_use blocks", () => {
      const state = makeDefaultState();

      const msg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-read",
            name: "Read",
            input: { file_path: "/tmp/test.ts" },
          },
        ],
      });
      const next = reduce(state, msg, buffer);

      expect(next.team).toBeUndefined();
      expect(buffer.pendingCount).toBe(0);
    });
  });

  describe("full lifecycle", () => {
    it("create → member → task → complete → delete", () => {
      let state = makeDefaultState();

      // TeamCreate tool_use + result
      state = reduce(
        state,
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu-1", name: "TeamCreate", input: { team_name: "my-team" } },
          ],
        }),
        buffer,
      );
      state = reduce(
        state,
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "{}" }],
        }),
        buffer,
      );
      expect(state.team?.name).toBe("my-team");

      // Add member
      state = reduce(
        state,
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu-2",
              name: "Task",
              input: { team_name: "my-team", name: "dev-1" },
            },
          ],
        }),
        buffer,
      );
      state = reduce(
        state,
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "tool_result", tool_use_id: "tu-2", content: "{}" }],
        }),
        buffer,
      );
      expect(state.team?.members).toHaveLength(1);
      expect(state.agents).toEqual(["dev-1"]);

      // Create task
      state = reduce(
        state,
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu-3", name: "TaskCreate", input: { subject: "Fix bug" } },
          ],
        }),
        buffer,
      );
      state = reduce(
        state,
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "tool_result", tool_use_id: "tu-3", content: '{"id": "1"}' }],
        }),
        buffer,
      );
      expect(state.team?.tasks).toHaveLength(1);
      expect(state.team?.tasks[0].subject).toBe("Fix bug");

      // Complete task
      state = reduce(
        state,
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu-4",
              name: "TaskUpdate",
              input: { taskId: "1", status: "completed" },
            },
          ],
        }),
        buffer,
      );
      state = reduce(
        state,
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "tool_result", tool_use_id: "tu-4", content: "{}" }],
        }),
        buffer,
      );
      expect(state.team?.tasks[0].status).toBe("completed");

      // Delete team
      state = reduce(
        state,
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-5", name: "TeamDelete", input: {} }],
        }),
        buffer,
      );
      state = reduce(
        state,
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "tool_result", tool_use_id: "tu-5", content: "{}" }],
        }),
        buffer,
      );
      expect(state.team).toBeUndefined();
      expect(state.agents).toEqual([]);
    });
  });

  describe("existing reducers unchanged", () => {
    it("session_init still works with team state", () => {
      const state: SessionState = {
        ...makeDefaultState(),
        team: {
          name: "my-team",
          role: "lead",
          members: [
            { name: "w1", agentId: "w1@t", agentType: "general-purpose", status: "active" },
          ],
          tasks: [],
        },
      };

      const msg = createUnifiedMessage({
        type: "session_init",
        role: "system",
        metadata: { model: "claude-opus-4-6" },
      });

      const next = reduce(state, msg, buffer);
      expect(next.model).toBe("claude-opus-4-6");
      // team state is preserved
      expect(next.team?.name).toBe("my-team");
    });
  });
});
