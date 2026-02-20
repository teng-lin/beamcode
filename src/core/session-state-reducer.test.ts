import { describe, expect, it } from "vitest";
import { reduce } from "./session-state-reducer.js";
import { createUnifiedMessage } from "./types/unified-message.js";

/** Minimal valid SessionState for testing. */
function baseState() {
  return {
    model: "claude-sonnet-4-5-20250929",
    cwd: "/tmp",
    tools: [],
    permissionMode: "default",
    claude_code_version: "1.0.0",
    mcp_servers: [],
    slash_commands: [],
    skills: [],
    is_compacting: false,
    total_cost_usd: 0,
    num_turns: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    last_duration_ms: 0,
    last_duration_api_ms: 0,
    context_used_percent: 0,
  };
}

describe("reduce — configuration_change", () => {
  it("updates model from metadata.model", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "configuration_change",
      role: "user",
      metadata: { subtype: "set_model", model: "gpt-4" },
    });

    const next = reduce(state, msg);
    expect(next.model).toBe("gpt-4");
    expect(next).not.toBe(state);
  });

  it("updates permissionMode from metadata.mode (consumer path)", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "configuration_change",
      role: "user",
      metadata: { subtype: "set_permission_mode", mode: "plan" },
    });

    const next = reduce(state, msg);
    expect(next.permissionMode).toBe("plan");
    expect(next).not.toBe(state);
  });

  it("updates permissionMode from metadata.permissionMode (adapter path)", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "configuration_change",
      role: "system",
      metadata: { permissionMode: "bypassPermissions" },
    });

    const next = reduce(state, msg);
    expect(next.permissionMode).toBe("bypassPermissions");
  });

  it("prefers metadata.mode over metadata.permissionMode", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "configuration_change",
      role: "user",
      metadata: { mode: "plan", permissionMode: "bypassPermissions" },
    });

    const next = reduce(state, msg);
    expect(next.permissionMode).toBe("plan");
  });

  it("returns same reference when nothing changed", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "configuration_change",
      role: "system",
      metadata: { subtype: "available_commands_update" },
    });

    const next = reduce(state, msg);
    expect(next).toBe(state);
  });

  it("returns same reference when values are unchanged", () => {
    const state = baseState();
    const msg = createUnifiedMessage({
      type: "configuration_change",
      role: "user",
      metadata: { model: state.model, mode: state.permissionMode },
    });

    const next = reduce(state, msg);
    expect(next).toBe(state);
  });
});
