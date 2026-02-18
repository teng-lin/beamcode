import { describe, expect, it } from "vitest";
import { MockCommandRunner } from "../testing/mock-command-runner.js";
import type { ResolvedConfig } from "../types/config.js";
import { DEFAULT_CONFIG } from "../types/config.js";
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
    agents: [],
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

/** State with typical backend commands reported via slash_commands (init). */
function makeStateWithSlashCommands(extra: Partial<SessionState> = {}): SessionState {
  return makeState({
    slash_commands: ["/compact", "/files", "/release-notes", "/vim"],
    ...extra,
  });
}

/** State with capabilities.commands (authoritative). */
function makeStateWithCapabilities(extra: Partial<SessionState> = {}): SessionState {
  return makeState({
    slash_commands: ["/compact", "/files", "/release-notes", "/cost", "/context"],
    capabilities: {
      commands: [
        { name: "/compact", description: "Compact conversation history" },
        { name: "/files", description: "List files in context" },
        { name: "/release-notes", description: "Show release notes" },
        { name: "/vim", description: "Toggle vim mode", argumentHint: "[on|off]" },
        { name: "/help", description: "Show available commands" },
        { name: "/model", description: "Show or switch model", argumentHint: "[model]" },
        { name: "/cost", description: "Show cost and token usage" },
        { name: "/context", description: "Show context window usage" },
      ],
      models: [],
      account: null,
      receivedAt: Date.now(),
    },
    ...extra,
  });
}

const PTY_DISABLED_CONFIG: Partial<ResolvedConfig> = {
  slashCommand: { ptyTimeoutMs: 15000, ptySilenceThresholdMs: 500, ptyEnabled: false },
};

function createExecutor(options?: {
  commandRunner?: MockCommandRunner;
  config?: Partial<ResolvedConfig>;
}) {
  const runner = options?.commandRunner ?? new MockCommandRunner();
  return {
    executor: new SlashCommandExecutor({
      commandRunner: runner,
      config: { ...DEFAULT_CONFIG, ...options?.config },
    }),
    runner,
  };
}

describe("SlashCommandExecutor", () => {
  describe("isNativeCommand", () => {
    it("identifies native commands from capabilities", () => {
      const { executor } = createExecutor();
      const state = makeStateWithCapabilities();
      expect(executor.isNativeCommand("/compact", state)).toBe(true);
      expect(executor.isNativeCommand("/files", state)).toBe(true);
      expect(executor.isNativeCommand("/release-notes", state)).toBe(true);
      expect(executor.isNativeCommand("/vim", state)).toBe(true);
      expect(executor.isNativeCommand("/cost", state)).toBe(true);
      expect(executor.isNativeCommand("/context", state)).toBe(true);
    });

    it("identifies native commands from slash_commands fallback", () => {
      const { executor } = createExecutor();
      const state = makeStateWithSlashCommands();
      expect(executor.isNativeCommand("/compact", state)).toBe(true);
      expect(executor.isNativeCommand("/vim", state)).toBe(true);
    });

    it("rejects emulatable commands even if in backend commands", () => {
      const { executor } = createExecutor();
      const state = makeStateWithCapabilities();
      // /model and /help are in capabilities but are emulatable — should NOT be native
      expect(executor.isNativeCommand("/model", state)).toBe(false);
      expect(executor.isNativeCommand("/help", state)).toBe(false);
      expect(executor.isNativeCommand("/status", state)).toBe(false);
    });

    it("rejects unknown commands", () => {
      const { executor } = createExecutor();
      const state = makeStateWithCapabilities();
      expect(executor.isNativeCommand("/nonexistent", state)).toBe(false);
    });

    it("returns false for all commands when no backend info available", () => {
      const { executor } = createExecutor();
      const state = makeState(); // no slash_commands, no capabilities
      expect(executor.isNativeCommand("/compact", state)).toBe(false);
      expect(executor.isNativeCommand("/files", state)).toBe(false);
    });
  });

  describe("isPassthroughCommand", () => {
    it("identifies passthrough commands from registry", () => {
      const { executor } = createExecutor();
      const registry = new SlashCommandRegistry();
      expect(executor.isPassthroughCommand("/cost", registry)).toBe(true);
      expect(executor.isPassthroughCommand("/context", registry)).toBe(true);
      expect(executor.isPassthroughCommand("/compact", registry)).toBe(true);
      expect(executor.isPassthroughCommand("/files", registry)).toBe(true);
      expect(executor.isPassthroughCommand("/release-notes", registry)).toBe(true);
    });

    it("rejects non-passthrough commands", () => {
      const { executor } = createExecutor();
      const registry = new SlashCommandRegistry();
      expect(executor.isPassthroughCommand("/help", registry)).toBe(false);
      expect(executor.isPassthroughCommand("/model", registry)).toBe(false);
      expect(executor.isPassthroughCommand("/status", registry)).toBe(false);
    });

    it("returns false when registry is null", () => {
      const { executor } = createExecutor();
      expect(executor.isPassthroughCommand("/cost", null)).toBe(false);
    });
  });

  describe("canHandle", () => {
    it("handles emulatable commands regardless of backend state", () => {
      const { executor } = createExecutor();
      const state = makeState(); // no backend info at all
      expect(executor.canHandle("/model", state)).toBe(true);
      expect(executor.canHandle("/status", state)).toBe(true);
      expect(executor.canHandle("/config", state)).toBe(true);
      expect(executor.canHandle("/help", state)).toBe(true);
    });

    it("handles backend-known commands", () => {
      const { executor } = createExecutor();
      const state = makeStateWithCapabilities();
      expect(executor.canHandle("/compact", state)).toBe(true);
      expect(executor.canHandle("/vim", state)).toBe(true);
    });

    it("handles unknown commands when PTY is available", () => {
      const { executor } = createExecutor();
      const state = makeState();
      expect(executor.canHandle("/usage", state)).toBe(true);
    });

    it("rejects unknown commands when PTY is disabled", () => {
      const { executor } = createExecutor({ config: PTY_DISABLED_CONFIG });
      const state = makeState();
      expect(executor.canHandle("/usage", state)).toBe(false);
    });

    it("rejects unknown commands when no runner is provided", () => {
      const executor = new SlashCommandExecutor({
        config: DEFAULT_CONFIG,
      });
      const state = makeState();
      expect(executor.canHandle("/usage", state)).toBe(false);
    });
  });

  describe("emulation", () => {
    it("/model returns the session model", async () => {
      const { executor } = createExecutor();
      const result = await executor.execute(makeState(), "/model", "cli-123");
      expect(result.source).toBe("emulated");
      expect(result.content).toBe("claude-sonnet-4-5-20250929");
    });

    it("/model returns unknown for empty model", async () => {
      const { executor } = createExecutor();
      const result = await executor.execute(makeState({ model: "" }), "/model", "cli-123");
      expect(result.content).toBe("unknown");
    });

    it("/status returns formatted summary", async () => {
      const { executor } = createExecutor();
      const result = await executor.execute(makeState(), "/status", "cli-123");
      expect(result.source).toBe("emulated");
      expect(result.content).toContain("Model: claude-sonnet-4-5-20250929");
      expect(result.content).toContain("CWD: /test");
      expect(result.content).toContain("Turns: 5");
      expect(result.content).toContain("Cost: $0.1234");
      expect(result.content).toContain("Context used: 42%");
      expect(result.content).toContain("Git branch: main");
      expect(result.content).toContain("Tools: Bash, Read");
    });

    it("/config returns model and config info", async () => {
      const { executor } = createExecutor();
      const result = await executor.execute(makeState(), "/config", "cli-123");
      expect(result.source).toBe("emulated");
      expect(result.content).toContain("Model: claude-sonnet-4-5-20250929");
      expect(result.content).toContain("Permission mode: default");
      expect(result.content).toContain("Version: 1.0.0");
    });
  });

  describe("PTY fallback", () => {
    it("delegates non-emulatable commands to PTY runner", async () => {
      const runner = new MockCommandRunner();
      runner.setResult("/usage", {
        output: "Usage: 50% of quota",
        rawOutput: "Usage: 50% of quota",
        exitCode: 0,
        durationMs: 200,
      });
      const { executor } = createExecutor({ commandRunner: runner });
      const result = await executor.execute(makeState(), "/usage", "cli-123");
      expect(result.source).toBe("pty");
      expect(result.content).toBe("Usage: 50% of quota");
      expect(runner.executeCalls).toHaveLength(1);
      expect(runner.executeCalls[0].command).toBe("/usage");
    });

    it("throws when no runner is available for non-emulatable command", async () => {
      const executor = new SlashCommandExecutor({
        config: DEFAULT_CONFIG,
      });
      await expect(executor.execute(makeState(), "/usage", "cli-123")).rejects.toThrow(
        /cannot be emulated/,
      );
    });

    it("throws when PTY is disabled", async () => {
      const { executor } = createExecutor({ config: PTY_DISABLED_CONFIG });
      await expect(executor.execute(makeState(), "/usage", "cli-123")).rejects.toThrow(
        /PTY execution is disabled/,
      );
    });

    it("propagates runner errors", async () => {
      const runner = new MockCommandRunner();
      runner.setError(new Error("PTY spawn failed"));
      const { executor } = createExecutor({ commandRunner: runner });
      await expect(executor.execute(makeState(), "/usage", "cli-123")).rejects.toThrow(
        "PTY spawn failed",
      );
    });
  });

  describe("queue serialization", () => {
    it("serializes PTY commands for the same session", async () => {
      const runner = new MockCommandRunner();
      const executionOrder: number[] = [];

      let call = 0;
      const originalExecute = runner.execute.bind(runner);
      runner.execute = async (...args) => {
        const myCall = ++call;
        executionOrder.push(myCall);
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10));
        return originalExecute(...args);
      };

      const { executor } = createExecutor({ commandRunner: runner });
      const state = makeState();

      // Launch two commands concurrently for the same session
      const [r1, r2] = await Promise.all([
        executor.execute(state, "/usage", "cli-123"),
        executor.execute(state, "/usage", "cli-123"),
      ]);

      expect(r1.source).toBe("pty");
      expect(r2.source).toBe("pty");
      // Both should have executed in order
      expect(executionOrder).toEqual([1, 2]);
    });
  });

  describe("capabilities-driven routing", () => {
    it("uses capabilities.commands when available", () => {
      const { executor } = createExecutor();
      const state = makeStateWithCapabilities();
      // /vim is in capabilities but not emulatable → native
      expect(executor.isNativeCommand("/vim", state)).toBe(true);
      expect(executor.canHandle("/vim", state)).toBe(true);
    });

    it("falls back to slash_commands when capabilities unavailable", () => {
      const { executor } = createExecutor();
      const state = makeStateWithSlashCommands(); // no capabilities
      expect(executor.isNativeCommand("/vim", state)).toBe(true);
      expect(executor.canHandle("/vim", state)).toBe(true);
    });

    it("falls back to empty set when both unavailable", () => {
      const { executor } = createExecutor();
      const state = makeState(); // no slash_commands, no capabilities
      // Only emulatable commands should work
      expect(executor.canHandle("/model", state)).toBe(true);
      expect(executor.canHandle("/help", state)).toBe(true);
      // Non-emulatable, non-backend commands require PTY
      expect(executor.isNativeCommand("/compact", state)).toBe(false);
    });

    it("emulatable commands are never considered native even if in capabilities", () => {
      const { executor } = createExecutor();
      const state = makeStateWithCapabilities();
      // /model and /help are in capabilities but should be emulated locally
      expect(executor.isNativeCommand("/model", state)).toBe(false);
      expect(executor.isNativeCommand("/help", state)).toBe(false);
    });

    it("/help shows capabilities descriptions when available", async () => {
      const { executor } = createExecutor();
      const state = makeStateWithCapabilities();
      const result = await executor.execute(state, "/help", "cli-123");
      expect(result.source).toBe("emulated");
      expect(result.content).toContain("/compact — Compact conversation history");
      expect(result.content).toContain("/vim [on|off] — Toggle vim mode");
      expect(result.content).toContain("/model [model] — Show or switch model");
    });

    it("/help falls back to slash_commands names when capabilities unavailable", async () => {
      const { executor } = createExecutor();
      const state = makeStateWithSlashCommands();
      const result = await executor.execute(state, "/help", "cli-123");
      expect(result.source).toBe("emulated");
      expect(result.content).toContain("/compact");
      expect(result.content).toContain("/vim");
      // Emulatable commands should also appear
      expect(result.content).toContain("/model");
      expect(result.content).toContain("/status");
    });

    it("/help shows only emulatable commands when no backend info", async () => {
      const { executor } = createExecutor();
      const state = makeState(); // no slash_commands, no capabilities
      const result = await executor.execute(state, "/help", "cli-123");
      expect(result.source).toBe("emulated");
      expect(result.content).toContain("/model");
      expect(result.content).toContain("/status");
      expect(result.content).not.toContain("/compact");
      expect(result.content).not.toContain("/cost");
      expect(result.content).not.toContain("/context");
    });

    it("treats empty capabilities.commands as unavailable (falls back to slash_commands)", () => {
      const { executor } = createExecutor();
      const state = makeState({
        slash_commands: ["/compact", "/files"],
        capabilities: { commands: [], models: [], account: null, receivedAt: Date.now() },
      });
      expect(executor.isNativeCommand("/compact", state)).toBe(true);
      expect(executor.isNativeCommand("/files", state)).toBe(true);
    });

    it("handles commands with arguments", () => {
      const { executor } = createExecutor();
      const state = makeStateWithCapabilities();
      expect(executor.isNativeCommand("/vim on", state)).toBe(true);
      expect(executor.isNativeCommand("/compact --force", state)).toBe(true);
      expect(executor.canHandle("/model gpt-4", state)).toBe(true);
    });

    it("handles commands with leading whitespace", () => {
      const { executor } = createExecutor();
      const state = makeStateWithCapabilities();
      expect(executor.isNativeCommand("  /compact", state)).toBe(true);
      expect(executor.canHandle("  /model", state)).toBe(true);

      const registry = new SlashCommandRegistry();
      expect(executor.isPassthroughCommand("  /cost", registry)).toBe(true);
    });
  });

  describe("registry-aware execution", () => {
    it("isSkillCommand identifies skill commands from registry", () => {
      const registry = new SlashCommandRegistry();
      registry.registerSkills(["commit"]);
      const { executor } = createExecutor();
      expect(executor.isSkillCommand("/commit", registry)).toBe(true);
      expect(executor.isSkillCommand("/help", registry)).toBe(false);
      expect(executor.isSkillCommand("/nonexistent", registry)).toBe(false);
    });

    it("isSkillCommand returns false when no registry", () => {
      const { executor } = createExecutor();
      expect(executor.isSkillCommand("/commit", null)).toBe(false);
    });

    it("registry-reported commands appear in /help", async () => {
      const registry = new SlashCommandRegistry();
      registry.registerFromCLI([{ name: "/vim", description: "Toggle vim mode" }]);
      registry.registerSkills(["commit"]);
      const { executor } = createExecutor();
      const state = makeState();
      const result = await executor.execute(state, "/help", "cli-123", registry);
      expect(result.content).toContain("/vim");
      expect(result.content).toContain("/commit");
    });

    it("/help prefers capabilities over registry when both available", async () => {
      const registry = new SlashCommandRegistry();
      registry.registerSkills(["commit"]);
      const { executor } = createExecutor();
      const state = makeStateWithCapabilities();
      const result = await executor.execute(state, "/help", "cli-123", registry);
      // Capabilities descriptions should be used
      expect(result.content).toContain("/compact — Compact conversation history");
      // Skills from registry should also appear
      expect(result.content).toContain("/commit");
    });
  });

  describe("dispose", () => {
    it("disposes the command runner", () => {
      const runner = new MockCommandRunner();
      const { executor } = createExecutor({ commandRunner: runner });
      // Should not throw
      executor.dispose();
    });
  });
});
