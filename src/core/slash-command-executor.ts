import type { CommandRunner } from "../interfaces/command-runner.js";
import type { ResolvedConfig } from "../types/config.js";
import type { SessionState } from "../types/session-state.js";
import type { SlashCommandRegistry } from "./slash-command-registry.js";

export interface SlashCommandResult {
  content: string;
  source: "emulated" | "pty";
  durationMs: number;
}

type EmulatorFn = (state: SessionState) => string;

/** Extract the command name (e.g. "/help") from a full command string (e.g. "/help foo"). */
function commandName(command: string): string {
  return command.split(/\s+/)[0];
}

/**
 * Derive the set of backend-supported commands from SessionState.
 * Three-tier fallback:
 *   1. capabilities.commands (preferred — rich metadata, authoritative)
 *   2. slash_commands from system/init (available immediately)
 *   3. Empty set (before CLI connects — only emulated commands work)
 */
function getBackendCommands(state: SessionState): Set<string> {
  const capCmds = state.capabilities?.commands;
  if (capCmds && capCmds.length > 0) {
    return new Set(capCmds.map((c) => c.name));
  }
  if (state.slash_commands.length > 0) {
    return new Set(state.slash_commands);
  }
  return new Set();
}

/** Commands we can emulate from SessionState without the CLI. */
const EMULATABLE_COMMANDS: Record<string, EmulatorFn> = {
  "/help": (state) => {
    const capCmds = state.capabilities?.commands;
    if (capCmds && capCmds.length > 0) {
      const formatted = capCmds.map((cmd) => {
        const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : "";
        return `  ${cmd.name}${hint} — ${cmd.description}`;
      });
      return ["Available commands:", ...formatted].join("\n");
    }

    // Fallback: list backend + emulated commands when capabilities are unavailable
    const backendNames = getBackendCommands(state);
    const allNames = [
      ...backendNames,
      ...Object.keys(EMULATABLE_COMMANDS).filter(
        (name) => name !== "/help" && !backendNames.has(name),
      ),
    ].sort();
    return ["Available commands:", ...allNames.map((name) => `  ${name}`)].join("\n");
  },

  "/model": (state) => state.model || "unknown",

  "/status": (state) => {
    const lines = [
      `Model: ${state.model || "unknown"}`,
      `CWD: ${state.cwd || "unknown"}`,
      `Permission mode: ${state.permissionMode || "default"}`,
      `Version: ${state.claude_code_version || "unknown"}`,
      `Turns: ${state.num_turns}`,
      `Cost: $${state.total_cost_usd.toFixed(4)}`,
      `Context used: ${state.context_used_percent}%`,
    ];
    if (state.git_branch) lines.push(`Git branch: ${state.git_branch}`);
    if (state.tools.length > 0) lines.push(`Tools: ${state.tools.join(", ")}`);
    return lines.join("\n");
  },

  "/config": (state) => {
    const lines = [
      `Model: ${state.model || "unknown"}`,
      `Permission mode: ${state.permissionMode || "default"}`,
      `CWD: ${state.cwd || "unknown"}`,
      `Version: ${state.claude_code_version || "unknown"}`,
    ];
    if (state.mcp_servers.length > 0) {
      lines.push(
        `MCP servers: ${state.mcp_servers.map((s) => `${s.name} (${s.status})`).join(", ")}`,
      );
    }
    return lines.join("\n");
  },

  "/cost": (state) => {
    const lines = [`Total cost: $${state.total_cost_usd.toFixed(4)}`];
    if (state.last_duration_ms != null) {
      lines.push(`Last turn duration: ${(state.last_duration_ms / 1000).toFixed(1)}s`);
    }
    if (state.last_duration_api_ms != null) {
      lines.push(`Last turn API duration: ${(state.last_duration_api_ms / 1000).toFixed(1)}s`);
    }
    if (state.last_model_usage) {
      for (const [model, usage] of Object.entries(state.last_model_usage)) {
        lines.push(
          `  ${model}: in=${usage.inputTokens} out=${usage.outputTokens} cache_read=${usage.cacheReadInputTokens} cache_create=${usage.cacheCreationInputTokens} cost=$${usage.costUSD.toFixed(4)}`,
        );
      }
    }
    return lines.join("\n");
  },

  "/context": (state) => {
    const lines = [`Context used: ${state.context_used_percent}%`];
    if (state.last_model_usage) {
      for (const [model, usage] of Object.entries(state.last_model_usage)) {
        const total = usage.inputTokens + usage.outputTokens;
        const pct = usage.contextWindow > 0 ? Math.round((total / usage.contextWindow) * 100) : 0;
        lines.push(`  ${model}: ${total}/${usage.contextWindow} tokens (${pct}%)`);
      }
    }
    return lines.join("\n");
  },
};

export class SlashCommandExecutor {
  private commandRunner: CommandRunner | null;
  private config: ResolvedConfig;
  private registry: SlashCommandRegistry | null;
  /** Per-session serialization queues to prevent --resume conflicts. */
  private ptyQueues = new Map<string, Promise<void>>();

  constructor(options: {
    commandRunner?: CommandRunner;
    config: ResolvedConfig;
    registry?: SlashCommandRegistry;
  }) {
    this.commandRunner = options.commandRunner ?? null;
    this.config = options.config;
    this.registry = options.registry ?? null;
  }

  /** Returns true if the command is a skill command in the registry. */
  isSkillCommand(command: string): boolean {
    if (!this.registry) return false;
    const name = commandName(command);
    const cmd = this.registry.find(name);
    return cmd?.source === "skill";
  }

  /** Returns true if the command is supported by the backend AND not emulatable locally. */
  isNativeCommand(command: string, state: SessionState): boolean {
    const name = commandName(command);
    if (name in EMULATABLE_COMMANDS) return false;
    return getBackendCommands(state).has(name);
  }

  /** Returns true if we can handle this command (emulation, backend-known, or PTY). */
  canHandle(command: string, state: SessionState): boolean {
    const name = commandName(command);
    if (name in EMULATABLE_COMMANDS) return true;
    if (getBackendCommands(state).has(name)) return true;
    if (this.commandRunner && this.config.slashCommand.ptyEnabled) return true;
    return false;
  }

  /** Execute a slash command — tries emulation first, falls back to PTY. */
  async execute(
    state: SessionState,
    command: string,
    cliSessionId: string,
  ): Promise<SlashCommandResult> {
    const name = commandName(command);
    const start = Date.now();

    // Try emulation first
    const emulator = EMULATABLE_COMMANDS[name];
    if (emulator) {
      let content = emulator(state);
      // Augment /help with registry commands (skills, CLI-registered)
      if (name === "/help" && this.registry) {
        content = this.augmentHelp(content, state);
      }
      return {
        content,
        source: "emulated",
        durationMs: Date.now() - start,
      };
    }

    // Fall back to PTY
    if (!this.commandRunner) {
      throw new Error(`Command "${name}" cannot be emulated and no PTY runner is available`);
    }

    if (!this.config.slashCommand.ptyEnabled) {
      throw new Error(`PTY execution is disabled for command "${name}"`);
    }

    // Serialize PTY commands per session to prevent --resume conflicts
    const runner = this.commandRunner;
    const result = await this.enqueue(cliSessionId, () =>
      runner.execute(cliSessionId, command, {
        cwd: state.cwd,
        timeoutMs: this.config.slashCommand.ptyTimeoutMs,
        silenceThresholdMs: this.config.slashCommand.ptySilenceThresholdMs,
      }),
    );

    return {
      content: result.output,
      source: "pty",
      durationMs: result.durationMs,
    };
  }

  /** Enqueue a PTY operation per session to prevent --resume conflicts. */
  private async enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.ptyQueues.get(sessionId) ?? Promise.resolve();
    let resolve: (() => void) | undefined;
    const next = new Promise<void>((r) => {
      resolve = r;
    });
    this.ptyQueues.set(sessionId, next);

    await prev;
    try {
      return await fn();
    } finally {
      resolve?.();
    }
  }

  /** Augment /help output with registry commands not already listed. */
  private augmentHelp(baseContent: string, state: SessionState): string {
    if (!this.registry) return baseContent;

    const registryCommands = this.registry.getAll();
    const hasCapabilities =
      state.capabilities?.commands && state.capabilities.commands.length > 0;

    // Collect names already present in the help output
    const existingNames = new Set<string>();
    for (const line of baseContent.split("\n")) {
      const match = line.match(/^\s+(\/\S+)/);
      if (match) existingNames.add(match[1]);
    }

    // Find registry commands not yet listed
    const extra = registryCommands.filter(
      (c) => !existingNames.has(c.name),
    );
    if (extra.length === 0) return baseContent;

    const formatted = extra.map((cmd) => {
      const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : "";
      if (hasCapabilities) {
        return `  ${cmd.name}${hint} — ${cmd.description}`;
      }
      return `  ${cmd.name}`;
    });

    return baseContent + "\n" + formatted.join("\n");
  }

  dispose(): void {
    this.commandRunner?.dispose();
    this.ptyQueues.clear();
  }
}
