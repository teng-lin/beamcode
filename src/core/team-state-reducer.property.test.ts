import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reduceTeamState } from "./team-state-reducer.js";
import type { CorrelatedToolUse } from "./team-tool-correlation.js";
import type { TeamState } from "./types/team-types.js";

function arbTeamState(): fc.Arbitrary<TeamState> {
  return fc.record({
    name: fc.string({ minLength: 1 }),
    role: fc.constantFrom("lead" as const, "teammate" as const),
    members: fc.array(
      fc.record({
        name: fc.string({ minLength: 1 }),
        agentId: fc.string({ minLength: 1 }),
        agentType: fc.string({ minLength: 1 }),
        status: fc.constantFrom("active" as const, "idle" as const, "shutdown" as const),
      }),
      { maxLength: 5 },
    ),
    tasks: fc.uniqueArray(
      fc.record({
        id: fc.string({ minLength: 1 }),
        subject: fc.string(),
        status: fc.constantFrom("pending" as const, "in_progress" as const, "completed" as const),
        blockedBy: fc.array(fc.string({ minLength: 1 }), { maxLength: 3 }),
        blocks: fc.array(fc.string({ minLength: 1 }), { maxLength: 3 }),
      }),
      { maxLength: 5, selector: (t) => t.id },
    ),
  });
}

function makeCorrelated(toolName: string, input: Record<string, unknown>): CorrelatedToolUse {
  return {
    recognized: {
      toolName,
      toolUseId: `tu-${Math.random().toString(36).slice(2)}`,
      category: "team_state_change",
      input,
    },
    result: undefined,
  };
}

describe("team-state-reducer property tests", () => {
  it("TeamCreate is idempotent — applying twice returns same state", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (teamName) => {
        const correlated = makeCorrelated("TeamCreate", { team_name: teamName });
        const state1 = reduceTeamState(undefined, correlated);
        const state2 = reduceTeamState(state1, correlated);
        expect(state2).toBe(state1);
      }),
    );
  });

  it("Task (spawn) is idempotent — duplicate member additions are no-ops", () => {
    fc.assert(
      fc.property(arbTeamState(), fc.string({ minLength: 1 }), (state, name) => {
        const correlated = makeCorrelated("Task", { name, team_name: state.name });
        const state1 = reduceTeamState(state, correlated);
        const state2 = reduceTeamState(state1!, correlated);
        expect(state2).toBe(state1);
      }),
    );
  });

  it("error results never mutate state", () => {
    fc.assert(
      fc.property(arbTeamState(), (state) => {
        const correlated: CorrelatedToolUse = {
          recognized: {
            toolName: "TaskCreate",
            toolUseId: "tu-err",
            category: "team_task_update",
            input: { subject: "fail" },
          },
          result: {
            type: "tool_result",
            tool_use_id: "tu-err",
            content: "error happened",
            is_error: true,
          },
        };
        expect(reduceTeamState(state, correlated)).toBe(state);
      }),
    );
  });

  it("TaskUpdate with status=deleted removes the task", () => {
    fc.assert(
      fc.property(
        arbTeamState().filter((s) => s.tasks.length > 0),
        (state) => {
          const taskId = state.tasks[0]!.id;
          const correlated = makeCorrelated("TaskUpdate", { taskId, status: "deleted" });
          const result = reduceTeamState(state, correlated)!;
          expect(result.tasks.find((t) => t.id === taskId)).toBeUndefined();
          expect(result.tasks.length).toBe(state.tasks.length - 1);
        },
      ),
    );
  });

  it("TaskUpdate dependency arrays are deduplicated", () => {
    fc.assert(
      fc.property(
        arbTeamState().filter((s) => s.tasks.length > 0),
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }),
        (state, deps) => {
          const taskId = state.tasks[0]!.id;
          const correlated1 = makeCorrelated("TaskUpdate", { taskId, addBlockedBy: deps });
          const state1 = reduceTeamState(state, correlated1)!;
          const correlated2 = makeCorrelated("TaskUpdate", { taskId, addBlockedBy: deps });
          const state2 = reduceTeamState(state1, correlated2)!;
          const task = state2.tasks.find((t) => t.id === taskId)!;
          const uniqueDeps = new Set(task.blockedBy);
          expect(task.blockedBy.length).toBe(uniqueDeps.size);
        },
      ),
    );
  });

  it("TeamDelete always returns undefined", () => {
    fc.assert(
      fc.property(arbTeamState(), (state) => {
        const correlated = makeCorrelated("TeamDelete", {});
        expect(reduceTeamState(state, correlated)).toBeUndefined();
      }),
    );
  });

  it("read-only tools (TaskGet, TaskList) return same state reference", () => {
    fc.assert(
      fc.property(arbTeamState(), fc.constantFrom("TaskGet", "TaskList"), (state, tool) => {
        const correlated = makeCorrelated(tool, {});
        expect(reduceTeamState(state, correlated)).toBe(state);
      }),
    );
  });

  it("all reducers handle undefined state without throwing", () => {
    const tools = [
      "TeamCreate",
      "TeamDelete",
      "Task",
      "TaskCreate",
      "TaskUpdate",
      "TaskGet",
      "TaskList",
      "SendMessage",
    ];
    fc.assert(
      fc.property(fc.constantFrom(...tools), (tool) => {
        const correlated = makeCorrelated(tool, {
          team_name: "test",
          name: "agent",
          subject: "t",
          taskId: "1",
          type: "message",
        });
        expect(() => reduceTeamState(undefined, correlated)).not.toThrow();
      }),
    );
  });
});
