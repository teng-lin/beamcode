import { describe, expect, it } from "vitest";
import type { ClaudeSessionState, SessionState } from "../../types/session-state.js";
import type { CoreSessionState, DevToolSessionState } from "./core-session-state.js";

describe("CoreSessionState", () => {
  it("is a valid subset of SessionState", () => {
    const fullState: SessionState = {
      session_id: "test-session",
      model: "claude-sonnet-4-5-20250929",
      cwd: "/test",
      tools: ["Bash"],
      permissionMode: "default",
      claude_code_version: "1.0",
      mcp_servers: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 1.5,
      num_turns: 3,
      context_used_percent: 45,
      is_compacting: false,
      git_branch: "main",
      is_worktree: false,
      repo_root: "/repo",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 10,
      total_lines_removed: 5,
    };

    // CoreSessionState can be assigned from SessionState — structural subtype
    const core: CoreSessionState = fullState;
    expect(core.session_id).toBe("test-session");
    expect(core.total_cost_usd).toBe(1.5);
    expect(core.num_turns).toBe(3);
    expect(core.context_used_percent).toBe(45);
    expect(core.is_compacting).toBe(false);
  });

  it("DevToolSessionState extends CoreSessionState", () => {
    const devState: DevToolSessionState = {
      session_id: "dev-session",
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
      git_branch: "feature/test",
      is_worktree: true,
      repo_root: "/repo",
      git_ahead: 2,
      git_behind: 1,
      total_lines_added: 50,
      total_lines_removed: 20,
    };

    // DevToolSessionState is assignable to CoreSessionState
    const core: CoreSessionState = devState;
    expect(core.session_id).toBe("dev-session");

    // DevToolSessionState has git fields
    expect(devState.git_branch).toBe("feature/test");
    expect(devState.is_worktree).toBe(true);
    expect(devState.total_lines_added).toBe(50);
  });

  it("ClaudeSessionState is the same type as SessionState", () => {
    const state: SessionState = {
      session_id: "sdk-session",
      model: "claude-sonnet-4-5-20250929",
      cwd: "/test",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0",
      mcp_servers: [],
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

    // ClaudeSessionState is assignable from SessionState and vice versa
    const claudeState: ClaudeSessionState = state;
    const backToState: SessionState = claudeState;
    expect(backToState).toBe(state);
  });

  it("SessionState extends DevToolSessionState", () => {
    const fullState: SessionState = {
      session_id: "full-session",
      model: "claude-sonnet-4-5-20250929",
      cwd: "/test",
      tools: ["Read"],
      permissionMode: "default",
      claude_code_version: "1.0",
      mcp_servers: [{ name: "test-mcp", status: "connected" }],
      slash_commands: ["/test"],
      skills: ["skill1"],
      total_cost_usd: 2.0,
      num_turns: 5,
      context_used_percent: 60,
      is_compacting: true,
      git_branch: "main",
      is_worktree: false,
      repo_root: "/repo",
      git_ahead: 1,
      git_behind: 0,
      total_lines_added: 100,
      total_lines_removed: 30,
    };

    // SessionState is assignable to DevToolSessionState
    const devTool: DevToolSessionState = fullState;
    expect(devTool.git_branch).toBe("main");
    expect(devTool.total_lines_added).toBe(100);

    // And transitively to CoreSessionState
    const core: CoreSessionState = devTool;
    expect(core.session_id).toBe("full-session");
  });
});
