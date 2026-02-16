import { describe, expect, it } from "vitest";
import { reduceTeamState } from "./team-state-reducer.js";
import type { CorrelatedToolUse } from "./team-tool-correlation.js";
import type { RecognizedTeamToolUse } from "./team-tool-recognizer.js";
import type { TeamMember, TeamState, TeamTask } from "./types/team-types.js";
import type { ToolResultContent } from "./types/unified-message.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCorrelated(overrides: {
  toolName: string;
  toolUseId?: string;
  category?: RecognizedTeamToolUse["category"];
  input?: Record<string, unknown>;
  result?: Partial<ToolResultContent>;
}): CorrelatedToolUse {
  return {
    recognized: {
      toolName: overrides.toolName,
      toolUseId: overrides.toolUseId ?? "tu-1",
      category: overrides.category ?? "team_state_change",
      input: overrides.input ?? {},
    },
    result: overrides.result
      ? {
          type: "tool_result",
          tool_use_id: overrides.toolUseId ?? "tu-1",
          content: "",
          ...overrides.result,
        }
      : undefined,
  };
}

function makeTeamState(overrides?: Partial<TeamState>): TeamState {
  return {
    name: "my-team",
    role: "lead",
    members: [],
    tasks: [],
    ...overrides,
  };
}

function makeMember(overrides?: Partial<TeamMember>): TeamMember {
  return {
    name: "worker-1",
    agentId: "worker-1@my-team",
    agentType: "general-purpose",
    status: "active",
    ...overrides,
  };
}

function makeTask(overrides?: Partial<TeamTask>): TeamTask {
  return {
    id: "1",
    subject: "Fix bug",
    status: "pending",
    blockedBy: [],
    blocks: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TeamCreate
// ---------------------------------------------------------------------------

describe("reduceTeamState", () => {
  describe("TeamCreate", () => {
    it("initializes TeamState from undefined", () => {
      const correlated = makeCorrelated({
        toolName: "TeamCreate",
        input: { team_name: "my-team" },
      });
      const result = reduceTeamState(undefined, correlated);
      expect(result).toEqual({
        name: "my-team",
        role: "lead",
        members: [],
        tasks: [],
      });
    });

    it("skips if state already exists (idempotency)", () => {
      const existing = makeTeamState({ name: "existing-team" });
      const correlated = makeCorrelated({
        toolName: "TeamCreate",
        input: { team_name: "new-team" },
      });
      const result = reduceTeamState(existing, correlated);
      expect(result).toBe(existing); // same reference
      expect(result!.name).toBe("existing-team");
    });
  });

  // ---------------------------------------------------------------------------
  // TeamDelete
  // ---------------------------------------------------------------------------

  describe("TeamDelete", () => {
    it("returns undefined (team dissolved)", () => {
      const state = makeTeamState();
      const correlated = makeCorrelated({ toolName: "TeamDelete" });
      const result = reduceTeamState(state, correlated);
      expect(result).toBeUndefined();
    });

    it("returns undefined even when state is undefined", () => {
      const correlated = makeCorrelated({ toolName: "TeamDelete" });
      const result = reduceTeamState(undefined, correlated);
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Task (team spawn — add member)
  // ---------------------------------------------------------------------------

  describe("Task (team spawn)", () => {
    it("adds a new member", () => {
      const state = makeTeamState();
      const correlated = makeCorrelated({
        toolName: "Task",
        input: {
          team_name: "my-team",
          name: "worker-1",
          model: "claude-opus-4-6",
          color: "blue",
          agentType: "general-purpose",
        },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.members).toHaveLength(1);
      expect(result!.members[0]).toEqual({
        name: "worker-1",
        agentId: "worker-1@my-team",
        agentType: "general-purpose",
        status: "active",
        model: "claude-opus-4-6",
        color: "blue",
      });
    });

    it("defaults agentType to 'general-purpose' when not provided", () => {
      const state = makeTeamState();
      const correlated = makeCorrelated({
        toolName: "Task",
        input: { team_name: "my-team", name: "worker-1" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.members[0]!.agentType).toBe("general-purpose");
    });

    it("skips if member already exists (idempotency)", () => {
      const state = makeTeamState({
        members: [makeMember({ name: "worker-1" })],
      });
      const correlated = makeCorrelated({
        toolName: "Task",
        input: { team_name: "my-team", name: "worker-1" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.members).toHaveLength(1);
    });

    it("returns state unchanged when state is undefined", () => {
      const correlated = makeCorrelated({
        toolName: "Task",
        input: { team_name: "my-team", name: "worker-1" },
      });
      const result = reduceTeamState(undefined, correlated);
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // TaskCreate
  // ---------------------------------------------------------------------------

  describe("TaskCreate", () => {
    it("adds a new task from tool_use input and tool_result id", () => {
      const state = makeTeamState();
      const correlated = makeCorrelated({
        toolName: "TaskCreate",
        category: "team_task_update",
        input: {
          subject: "Fix bug",
          description: "Details here",
          activeForm: "Fixing bug",
        },
        result: { content: JSON.stringify({ id: "3" }) },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.tasks).toHaveLength(1);
      expect(result!.tasks[0]).toEqual({
        id: "3",
        subject: "Fix bug",
        description: "Details here",
        status: "pending",
        activeForm: "Fixing bug",
        blockedBy: [],
        blocks: [],
      });
    });

    it("skips if task with same id already exists (idempotency)", () => {
      const state = makeTeamState({
        tasks: [makeTask({ id: "3", subject: "Original" })],
      });
      const correlated = makeCorrelated({
        toolName: "TaskCreate",
        category: "team_task_update",
        input: { subject: "Duplicate" },
        result: { content: JSON.stringify({ id: "3" }) },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.tasks).toHaveLength(1);
      expect(result!.tasks[0]!.subject).toBe("Original");
    });

    it("handles missing result (no id extraction)", () => {
      const state = makeTeamState();
      const correlated = makeCorrelated({
        toolName: "TaskCreate",
        category: "team_task_update",
        input: { subject: "Fix bug" },
      });
      // No result means we can't extract the task ID — state unchanged
      const result = reduceTeamState(state, correlated);
      expect(result!.tasks).toHaveLength(0);
    });

    it("returns state unchanged when state is undefined", () => {
      const correlated = makeCorrelated({
        toolName: "TaskCreate",
        category: "team_task_update",
        input: { subject: "Fix bug" },
        result: { content: JSON.stringify({ id: "1" }) },
      });
      const result = reduceTeamState(undefined, correlated);
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // TaskUpdate
  // ---------------------------------------------------------------------------

  describe("TaskUpdate", () => {
    it("updates task status", () => {
      const state = makeTeamState({
        tasks: [makeTask({ id: "1", status: "pending" })],
      });
      const correlated = makeCorrelated({
        toolName: "TaskUpdate",
        category: "team_task_update",
        input: { taskId: "1", status: "in_progress" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.tasks[0]!.status).toBe("in_progress");
    });

    it("updates task owner", () => {
      const state = makeTeamState({
        tasks: [makeTask({ id: "1" })],
      });
      const correlated = makeCorrelated({
        toolName: "TaskUpdate",
        category: "team_task_update",
        input: { taskId: "1", owner: "worker-1" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.tasks[0]!.owner).toBe("worker-1");
    });

    it("updates addBlockedBy", () => {
      const state = makeTeamState({
        tasks: [makeTask({ id: "2", blockedBy: [] })],
      });
      const correlated = makeCorrelated({
        toolName: "TaskUpdate",
        category: "team_task_update",
        input: { taskId: "2", addBlockedBy: ["1"] },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.tasks[0]!.blockedBy).toEqual(["1"]);
    });

    it("updates addBlocks", () => {
      const state = makeTeamState({
        tasks: [makeTask({ id: "1", blocks: [] })],
      });
      const correlated = makeCorrelated({
        toolName: "TaskUpdate",
        category: "team_task_update",
        input: { taskId: "1", addBlocks: ["2", "3"] },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.tasks[0]!.blocks).toEqual(["2", "3"]);
    });

    it("does not duplicate blockedBy entries on repeat", () => {
      const state = makeTeamState({
        tasks: [makeTask({ id: "2", blockedBy: ["1"] })],
      });
      const correlated = makeCorrelated({
        toolName: "TaskUpdate",
        category: "team_task_update",
        input: { taskId: "2", addBlockedBy: ["1"] },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.tasks[0]!.blockedBy).toEqual(["1"]);
    });

    it("no-op if task not found", () => {
      const state = makeTeamState({
        tasks: [makeTask({ id: "1" })],
      });
      const correlated = makeCorrelated({
        toolName: "TaskUpdate",
        category: "team_task_update",
        input: { taskId: "99", status: "completed" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.tasks).toHaveLength(1);
      expect(result!.tasks[0]!.id).toBe("1");
      expect(result!.tasks[0]!.status).toBe("pending");
    });

    it("handles status: deleted — removes task from array", () => {
      const state = makeTeamState({
        tasks: [
          makeTask({ id: "1", subject: "Keep" }),
          makeTask({ id: "2", subject: "Delete me" }),
        ],
      });
      const correlated = makeCorrelated({
        toolName: "TaskUpdate",
        category: "team_task_update",
        input: { taskId: "2", status: "deleted" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.tasks).toHaveLength(1);
      expect(result!.tasks[0]!.id).toBe("1");
    });

    it("updates subject when provided", () => {
      const state = makeTeamState({
        tasks: [makeTask({ id: "1", subject: "Old" })],
      });
      const correlated = makeCorrelated({
        toolName: "TaskUpdate",
        category: "team_task_update",
        input: { taskId: "1", subject: "New" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.tasks[0]!.subject).toBe("New");
    });

    it("updates description when provided", () => {
      const state = makeTeamState({
        tasks: [makeTask({ id: "1" })],
      });
      const correlated = makeCorrelated({
        toolName: "TaskUpdate",
        category: "team_task_update",
        input: { taskId: "1", description: "Updated description" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.tasks[0]!.description).toBe("Updated description");
    });

    it("updates activeForm when provided", () => {
      const state = makeTeamState({
        tasks: [makeTask({ id: "1" })],
      });
      const correlated = makeCorrelated({
        toolName: "TaskUpdate",
        category: "team_task_update",
        input: { taskId: "1", activeForm: "Running tests" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.tasks[0]!.activeForm).toBe("Running tests");
    });

    it("concurrent update on same task — last write wins", () => {
      const state = makeTeamState({
        tasks: [makeTask({ id: "1", status: "pending" })],
      });
      const first = makeCorrelated({
        toolName: "TaskUpdate",
        toolUseId: "tu-a",
        category: "team_task_update",
        input: { taskId: "1", status: "in_progress" },
      });
      const second = makeCorrelated({
        toolName: "TaskUpdate",
        toolUseId: "tu-b",
        category: "team_task_update",
        input: { taskId: "1", status: "completed" },
      });
      const intermediate = reduceTeamState(state, first);
      const result = reduceTeamState(intermediate, second);
      expect(result!.tasks[0]!.status).toBe("completed");
    });
  });

  // ---------------------------------------------------------------------------
  // TaskGet / TaskList — read-only (no state change)
  // ---------------------------------------------------------------------------

  describe("TaskGet / TaskList", () => {
    it("TaskGet returns state unchanged", () => {
      const state = makeTeamState();
      const correlated = makeCorrelated({
        toolName: "TaskGet",
        category: "team_task_update",
        input: { taskId: "1" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result).toBe(state);
    });

    it("TaskList returns state unchanged", () => {
      const state = makeTeamState();
      const correlated = makeCorrelated({
        toolName: "TaskList",
        category: "team_task_update",
        input: {},
      });
      const result = reduceTeamState(state, correlated);
      expect(result).toBe(state);
    });
  });

  // ---------------------------------------------------------------------------
  // SendMessage
  // ---------------------------------------------------------------------------

  describe("SendMessage", () => {
    it("message type — no state change", () => {
      const state = makeTeamState();
      const correlated = makeCorrelated({
        toolName: "SendMessage",
        category: "team_message",
        input: { type: "message", recipient: "worker-1", content: "Hello" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result).toBe(state);
    });

    it("broadcast type — no state change", () => {
      const state = makeTeamState();
      const correlated = makeCorrelated({
        toolName: "SendMessage",
        category: "team_message",
        input: { type: "broadcast", content: "Announcement" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result).toBe(state);
    });

    it("shutdown_request — no state change", () => {
      const state = makeTeamState();
      const correlated = makeCorrelated({
        toolName: "SendMessage",
        category: "team_message",
        input: {
          type: "shutdown_request",
          recipient: "worker-1",
          content: "Wrapping up",
        },
      });
      const result = reduceTeamState(state, correlated);
      expect(result).toBe(state);
    });

    it("shutdown_response with approve=true — sets member status to shutdown", () => {
      const state = makeTeamState({
        members: [makeMember({ name: "worker-1", status: "active" })],
      });
      const correlated = makeCorrelated({
        toolName: "SendMessage",
        category: "team_message",
        input: {
          type: "shutdown_response",
          request_id: "req-1",
          approve: true,
        },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.members[0]!.status).toBe("shutdown");
    });

    it("shutdown_response with approve=false — no state change", () => {
      const state = makeTeamState({
        members: [makeMember({ name: "worker-1", status: "active" })],
      });
      const correlated = makeCorrelated({
        toolName: "SendMessage",
        category: "team_message",
        input: {
          type: "shutdown_response",
          request_id: "req-1",
          approve: false,
        },
      });
      const result = reduceTeamState(state, correlated);
      expect(result).toBe(state);
    });

    it("shutdown_response on unknown member — no-op (no crash)", () => {
      const state = makeTeamState({ members: [] });
      const correlated = makeCorrelated({
        toolName: "SendMessage",
        category: "team_message",
        input: {
          type: "shutdown_response",
          request_id: "req-1",
          approve: true,
        },
      });
      const result = reduceTeamState(state, correlated);
      expect(result).toBe(state);
    });

    it("plan_approval_request — no state change", () => {
      const state = makeTeamState();
      const correlated = makeCorrelated({
        toolName: "SendMessage",
        category: "team_message",
        input: { type: "plan_approval_request" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result).toBe(state);
    });

    it("plan_approval_response — no state change", () => {
      const state = makeTeamState();
      const correlated = makeCorrelated({
        toolName: "SendMessage",
        category: "team_message",
        input: { type: "plan_approval_response" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result).toBe(state);
    });
  });

  // ---------------------------------------------------------------------------
  // Error results — no state change
  // ---------------------------------------------------------------------------

  describe("error results", () => {
    it("TeamCreate with is_error — no state change", () => {
      const correlated = makeCorrelated({
        toolName: "TeamCreate",
        input: { team_name: "my-team" },
        result: { is_error: true, content: "Error: failed" },
      });
      const result = reduceTeamState(undefined, correlated);
      expect(result).toBeUndefined();
    });

    it("TaskCreate with is_error — no state change", () => {
      const state = makeTeamState();
      const correlated = makeCorrelated({
        toolName: "TaskCreate",
        category: "team_task_update",
        input: { subject: "Fail" },
        result: { is_error: true, content: "Error: failed" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result).toBe(state);
    });

    it("TaskUpdate with is_error — no state change", () => {
      const state = makeTeamState({
        tasks: [makeTask({ id: "1", status: "pending" })],
      });
      const correlated = makeCorrelated({
        toolName: "TaskUpdate",
        category: "team_task_update",
        input: { taskId: "1", status: "completed" },
        result: { is_error: true, content: "Error: failed" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result).toBe(state);
    });
  });

  // ---------------------------------------------------------------------------
  // Role detection
  // ---------------------------------------------------------------------------

  describe("role detection", () => {
    it("TeamCreate → role: lead", () => {
      const correlated = makeCorrelated({
        toolName: "TeamCreate",
        input: { team_name: "my-team" },
      });
      const result = reduceTeamState(undefined, correlated);
      expect(result!.role).toBe("lead");
    });

    it("no TeamCreate (Task spawn first) → role: teammate", () => {
      // When state doesn't exist and we see a non-TeamCreate event,
      // the state remains undefined (no team to be a teammate of yet)
      const state = makeTeamState({ role: "teammate" });
      const correlated = makeCorrelated({
        toolName: "TaskUpdate",
        category: "team_task_update",
        input: { taskId: "1", status: "in_progress" },
      });
      const result = reduceTeamState(state, correlated);
      expect(result!.role).toBe("teammate");
    });
  });

  // ---------------------------------------------------------------------------
  // Task dependency cycles — accepted (no cycle detection)
  // ---------------------------------------------------------------------------

  describe("dependency cycles", () => {
    it("accepts A blocks B, B blocks A (no cycle detection)", () => {
      let state = makeTeamState({
        tasks: [
          makeTask({ id: "1", blocks: [], blockedBy: [] }),
          makeTask({ id: "2", blocks: [], blockedBy: [] }),
        ],
      });

      // A blocks B
      state = reduceTeamState(
        state,
        makeCorrelated({
          toolName: "TaskUpdate",
          toolUseId: "tu-a",
          category: "team_task_update",
          input: { taskId: "1", addBlocks: ["2"] },
        }),
      )!;

      // B blocks A
      state = reduceTeamState(
        state,
        makeCorrelated({
          toolName: "TaskUpdate",
          toolUseId: "tu-b",
          category: "team_task_update",
          input: { taskId: "2", addBlocks: ["1"] },
        }),
      )!;

      expect(state.tasks.find((t) => t.id === "1")!.blocks).toEqual(["2"]);
      expect(state.tasks.find((t) => t.id === "2")!.blocks).toEqual(["1"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Full lifecycle
  // ---------------------------------------------------------------------------

  describe("full lifecycle", () => {
    it("create → add members → create tasks → claim → complete → shutdown → delete", () => {
      // 1. Create team
      let state = reduceTeamState(
        undefined,
        makeCorrelated({
          toolName: "TeamCreate",
          input: { team_name: "project-x" },
        }),
      );
      expect(state).toBeDefined();
      expect(state!.name).toBe("project-x");
      expect(state!.role).toBe("lead");

      // 2. Add members
      state = reduceTeamState(
        state,
        makeCorrelated({
          toolName: "Task",
          toolUseId: "tu-m1",
          input: {
            team_name: "project-x",
            name: "researcher",
            model: "claude-sonnet-4-5-20250929",
          },
        }),
      );
      state = reduceTeamState(
        state,
        makeCorrelated({
          toolName: "Task",
          toolUseId: "tu-m2",
          input: { team_name: "project-x", name: "coder", model: "claude-opus-4-6" },
        }),
      );
      expect(state!.members).toHaveLength(2);

      // 3. Create tasks
      state = reduceTeamState(
        state,
        makeCorrelated({
          toolName: "TaskCreate",
          toolUseId: "tu-t1",
          category: "team_task_update",
          input: { subject: "Research API" },
          result: { content: JSON.stringify({ id: "1" }) },
        }),
      );
      state = reduceTeamState(
        state,
        makeCorrelated({
          toolName: "TaskCreate",
          toolUseId: "tu-t2",
          category: "team_task_update",
          input: { subject: "Implement API" },
          result: { content: JSON.stringify({ id: "2" }) },
        }),
      );
      expect(state!.tasks).toHaveLength(2);

      // 4. Claim task
      state = reduceTeamState(
        state,
        makeCorrelated({
          toolName: "TaskUpdate",
          category: "team_task_update",
          input: { taskId: "1", status: "in_progress", owner: "researcher" },
        }),
      );
      expect(state!.tasks[0]!.status).toBe("in_progress");
      expect(state!.tasks[0]!.owner).toBe("researcher");

      // 5. Complete task
      state = reduceTeamState(
        state,
        makeCorrelated({
          toolName: "TaskUpdate",
          category: "team_task_update",
          input: { taskId: "1", status: "completed" },
        }),
      );
      expect(state!.tasks[0]!.status).toBe("completed");

      // 6. Shutdown member (via shutdown_response approve=true)
      state = reduceTeamState(
        state,
        makeCorrelated({
          toolName: "SendMessage",
          category: "team_message",
          input: { type: "shutdown_response", request_id: "sr-1", approve: true },
        }),
      );
      // Note: shutdown_response from observed session — we need to figure out
      // which member. In practice, the observed session is the one responding.
      // For now, if we can't determine the member, no change.
      // The actual member detection is done by the integration layer.

      // 7. Delete team
      const finalState = reduceTeamState(
        state,
        makeCorrelated({
          toolName: "TeamDelete",
        }),
      );
      expect(finalState).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency comprehensive test
  // ---------------------------------------------------------------------------

  describe("idempotency", () => {
    it("applying same TeamCreate twice produces same state", () => {
      const correlated = makeCorrelated({
        toolName: "TeamCreate",
        input: { team_name: "test-team" },
      });
      const first = reduceTeamState(undefined, correlated);
      const second = reduceTeamState(first, correlated);
      expect(second).toBe(first); // reference equality — no mutation
    });

    it("applying same Task spawn twice does not duplicate member", () => {
      const state = makeTeamState();
      const correlated = makeCorrelated({
        toolName: "Task",
        input: { team_name: "my-team", name: "worker-1" },
      });
      const first = reduceTeamState(state, correlated);
      const second = reduceTeamState(first, correlated);
      expect(second!.members).toHaveLength(1);
    });

    it("applying same TaskCreate twice does not duplicate task", () => {
      const state = makeTeamState();
      const correlated = makeCorrelated({
        toolName: "TaskCreate",
        category: "team_task_update",
        input: { subject: "Fix bug" },
        result: { content: JSON.stringify({ id: "1" }) },
      });
      const first = reduceTeamState(state, correlated);
      const second = reduceTeamState(first, correlated);
      expect(second!.tasks).toHaveLength(1);
    });
  });
});
