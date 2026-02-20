import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reduce } from "../../core/session-state-reducer.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { SessionState } from "../../types/session-state.js";

function arbSessionState(): fc.Arbitrary<SessionState> {
  return fc.record({
    session_id: fc.string(),
    model: fc.string(),
    cwd: fc.string(),
    tools: fc.array(fc.string()),
    permissionMode: fc.string(),
    claude_code_version: fc.string(),
    mcp_servers: fc.array(fc.record({ name: fc.string(), status: fc.string() })),
    slash_commands: fc.array(fc.string()),
    skills: fc.array(fc.string()),
    is_compacting: fc.boolean(),
    total_cost_usd: fc.double({ min: 0, max: 10000, noNaN: true }),
    num_turns: fc.nat(),
    total_lines_added: fc.nat(),
    total_lines_removed: fc.nat(),
    context_used_percent: fc.integer({ min: 0, max: 100 }),
    git_branch: fc.string(),
    is_worktree: fc.boolean(),
    repo_root: fc.string(),
    git_ahead: fc.nat(),
    git_behind: fc.nat(),
  }) as fc.Arbitrary<SessionState>;
}

describe("state-reducer property tests", () => {
  it("reduce never mutates input state", () => {
    fc.assert(
      fc.property(arbSessionState(), (state) => {
        const frozen = Object.freeze({ ...state });
        const msg = createUnifiedMessage({
          type: "session_init",
          role: "system",
          metadata: { model: "test-model", cwd: "/tmp" },
        });
        expect(() => reduce(frozen, msg)).not.toThrow();
      }),
    );
  });

  it("unrelated message types return original reference", () => {
    fc.assert(
      fc.property(arbSessionState(), (state) => {
        const msg = createUnifiedMessage({
          type: "stream_event",
          role: "assistant",
        });
        const result = reduce(state, msg);
        expect(result).toBe(state);
      }),
    );
  });

  it("session_init preserves fields not present in metadata", () => {
    fc.assert(
      fc.property(arbSessionState(), fc.string(), (state, model) => {
        const msg = createUnifiedMessage({
          type: "session_init",
          role: "system",
          metadata: { model },
        });
        const result = reduce(state, msg);
        expect(result.model).toBe(model);
        expect(result.cwd).toBe(state.cwd);
        expect(result.is_compacting).toBe(state.is_compacting);
      }),
    );
  });

  it("result reducer only updates numeric fields from metadata", () => {
    fc.assert(
      fc.property(
        arbSessionState(),
        fc.double({ min: 0, max: 10000, noNaN: true }),
        fc.nat(),
        (state, cost, turns) => {
          const msg = createUnifiedMessage({
            type: "result",
            role: "assistant",
            metadata: {
              total_cost_usd: cost,
              num_turns: turns,
              bogus_field: "should-be-ignored",
            },
          });
          const result = reduce(state, msg);
          expect(result.total_cost_usd).toBe(cost);
          expect(result.num_turns).toBe(turns);
          expect(result.model).toBe(state.model);
        },
      ),
    );
  });

  it("status_change with 'compacting' sets is_compacting true", () => {
    fc.assert(
      fc.property(arbSessionState(), (state) => {
        const msg = createUnifiedMessage({
          type: "status_change",
          role: "system",
          metadata: { status: "compacting" },
        });
        expect(reduce(state, msg).is_compacting).toBe(true);
      }),
    );
  });

  it("status_change with non-compacting status sets is_compacting false", () => {
    fc.assert(
      fc.property(
        arbSessionState(),
        fc.string().filter((s) => s !== "compacting"),
        (state, status) => {
          const msg = createUnifiedMessage({
            type: "status_change",
            role: "system",
            metadata: { status },
          });
          expect(reduce(state, msg).is_compacting).toBe(false);
        },
      ),
    );
  });
});
