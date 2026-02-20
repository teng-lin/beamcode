import { describe, expect, it } from "vitest";
import type { SessionState } from "../types/session-state.js";
import { SlashCommandExecutor } from "./slash-command-executor.js";
import { SlashCommandRegistry } from "./slash-command-registry.js";

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "test-session",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/test",
    tools: ["Bash", "Read"],
    permissionMode: "default",
    claude_code_version: "1.0.0",
    mcp_servers: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0.1234,
    num_turns: 5,
    context_used_percent: 42,
    is_compacting: false,
    git_branch: "main",
    is_worktree: false,
    repo_root: "/test",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 100,
    total_lines_removed: 50,
    ...overrides,
  };
}

/** State with capabilities.commands (authoritative). */
function makeStateWithCapabilities(extra: Partial<SessionState> = {}): SessionState {
  return makeState({
    slash_commands: ["/compact", "/files", "/release-notes", "/context"],
    capabilities: {
      commands: [
        { name: "/compact", description: "Compact conversation history" },
        { name: "/files", description: "List files in context" },
        { name: "/release-notes", description: "Show release notes" },
        { name: "/vim", description: "Toggle vim mode", argumentHint: "[on|off]" },
        { name: "/help", description: "Show available commands" },
        { name: "/model", description: "Show or switch model", argumentHint: "[model]" },
        { name: "/context", description: "Show context window usage" },
      ],
      models: [],
      account: null,
      receivedAt: Date.now(),
    },
    ...extra,
  });
}

function createExecutor() {
  return new SlashCommandExecutor();
}

describe("SlashCommandExecutor", () => {
  describe("executeLocal", () => {
    it("/help returns help text with capabilities descriptions", async () => {
      const executor = createExecutor();
      const state = makeStateWithCapabilities();
      const result = await executor.executeLocal(state, "/help");
      expect(result.source).toBe("emulated");
      expect(result.durationMs).toBe(0);
      expect(result.content).toContain("Available commands:");
      expect(result.content).toContain("/compact — Compact conversation history");
      expect(result.content).toContain("/vim [on|off] — Toggle vim mode");
      expect(result.content).toContain("/model [model] — Show or switch model");
    });

    it("/help falls back to slash_commands names when capabilities unavailable", async () => {
      const executor = createExecutor();
      const state = makeState({
        slash_commands: ["/compact", "/files", "/vim"],
      });
      const result = await executor.executeLocal(state, "/help");
      expect(result.source).toBe("emulated");
      expect(result.content).toContain("/compact");
      expect(result.content).toContain("/files");
      expect(result.content).toContain("/vim");
    });

    it("/help shows empty list when no backend info and no registry", async () => {
      const executor = createExecutor();
      const state = makeState(); // no slash_commands, no capabilities
      const result = await executor.executeLocal(state, "/help");
      expect(result.source).toBe("emulated");
      expect(result.content).toContain("Available commands:");
      // No commands should be listed (no emulatable commands to pad with)
      expect(result.content).not.toContain("/model");
      expect(result.content).not.toContain("/status");
      expect(result.content).not.toContain("/compact");
    });

    it("/help augments with registry commands", async () => {
      const registry = new SlashCommandRegistry();
      registry.registerSkills(["commit"]);
      const executor = createExecutor();
      const state = makeState();
      const result = await executor.executeLocal(state, "/help", registry);
      expect(result.content).toContain("/commit");
    });

    it("/help prefers capabilities over registry when both available", async () => {
      const registry = new SlashCommandRegistry();
      registry.registerSkills(["commit"]);
      const executor = createExecutor();
      const state = makeStateWithCapabilities();
      const result = await executor.executeLocal(state, "/help", registry);
      // Capabilities descriptions should be used
      expect(result.content).toContain("/compact — Compact conversation history");
      // Skills from registry should also appear
      expect(result.content).toContain("/commit");
    });

    it("throws for non-/help commands", async () => {
      const executor = createExecutor();
      const state = makeState();
      await expect(executor.executeLocal(state, "/model")).rejects.toThrow(
        'Command "/model" must be forwarded to CLI',
      );
      await expect(executor.executeLocal(state, "/status")).rejects.toThrow(
        'Command "/status" must be forwarded to CLI',
      );
      await expect(executor.executeLocal(state, "/compact")).rejects.toThrow(
        'Command "/compact" must be forwarded to CLI',
      );
    });
  });
});
