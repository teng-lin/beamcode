import type { CommandRunner } from "../interfaces/command-runner.js";
import type { ResolvedConfig } from "../types/config.js";
import type { SessionState } from "../types/session-state.js";

export interface SlashCommandResult {
  content: string;
  source: "emulated" | "pty";
  durationMs: number;
}

type EmulatorFn = (state: SessionState) => string;

/** Commands that the CLI handles natively in headless mode. */
const NATIVE_COMMANDS = new Set(["/compact", "/files", "/release-notes"]);

/** Commands we can emulate from SessionState without the CLI. */
const EMULATABLE_COMMANDS: Record<string, EmulatorFn> = {
  "/model": (state) => state.model || "unknown",

  "/status": (state) => {
    const lines: string[] = [];
    lines.push(`Model: ${state.model || "unknown"}`);
    lines.push(`CWD: ${state.cwd || "unknown"}`);
    lines.push(`Permission mode: ${state.permissionMode || "default"}`);
    lines.push(`Version: ${state.claude_code_version || "unknown"}`);
    lines.push(`Turns: ${state.num_turns}`);
    lines.push(`Cost: $${state.total_cost_usd.toFixed(4)}`);
    lines.push(`Context used: ${state.context_used_percent}%`);
    if (state.git_branch) {
      lines.push(`Git branch: ${state.git_branch}`);
    }
    if (state.tools.length > 0) {
      lines.push(`Tools: ${state.tools.join(", ")}`);
    }
    return lines.join("\n");
  },

  "/config": (state) => {
    const lines: string[] = [];
    lines.push(`Model: ${state.model || "unknown"}`);
    lines.push(`Permission mode: ${state.permissionMode || "default"}`);
    lines.push(`CWD: ${state.cwd || "unknown"}`);
    lines.push(`Version: ${state.claude_code_version || "unknown"}`);
    if (state.mcp_servers.length > 0) {
      lines.push(
        `MCP servers: ${state.mcp_servers.map((s) => `${s.name} (${s.status})`).join(", ")}`,
      );
    }
    return lines.join("\n");
  },

  "/cost": (state) => {
    const lines: string[] = [];
    lines.push(`Total cost: $${state.total_cost_usd.toFixed(4)}`);
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
    const lines: string[] = [];
    lines.push(`Context used: ${state.context_used_percent}%`);
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
  /** Per-session serialization queues to prevent --resume conflicts. */
  private ptyQueues = new Map<string, Promise<void>>();

  constructor(options: {
    commandRunner?: CommandRunner;
    config: ResolvedConfig;
  }) {
    this.commandRunner = options.commandRunner ?? null;
    this.config = options.config;
  }

  /** Returns true if the command is handled natively by the CLI in headless mode. */
  isNativeCommand(command: string): boolean {
    const name = command.split(/\s+/)[0];
    return NATIVE_COMMANDS.has(name);
  }

  /** Returns true if we can handle this command (emulation or PTY). */
  canHandle(command: string): boolean {
    const name = command.split(/\s+/)[0];
    if (name in EMULATABLE_COMMANDS) return true;
    if (this.commandRunner && this.config.slashCommand.ptyEnabled) return true;
    return false;
  }

  /** Execute a slash command — tries emulation first, falls back to PTY. */
  async execute(
    state: SessionState,
    command: string,
    cliSessionId: string,
  ): Promise<SlashCommandResult> {
    const name = command.split(/\s+/)[0];
    const start = Date.now();

    // Try emulation first
    const emulator = EMULATABLE_COMMANDS[name];
    if (emulator) {
      const content = emulator(state);
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
    const result = await this.enqueue(cliSessionId, async () => {
      const runnerResult = await runner.execute(cliSessionId, command, {
        cwd: state.cwd,
        timeoutMs: this.config.slashCommand.ptyTimeoutMs,
        silenceThresholdMs: this.config.slashCommand.ptySilenceThresholdMs,
      });
      return runnerResult;
    });

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

  dispose(): void {
    this.commandRunner?.dispose();
    this.ptyQueues.clear();
  }
}
