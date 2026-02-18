import type { SessionState } from "../types/session-state.js";
import type { RegisteredCommand, SlashCommandRegistry } from "./slash-command-registry.js";

export interface SlashCommandResult {
  content: string;
  source: "emulated" | "pty";
  durationMs: number;
}

/** Extract the command name (e.g. "/help") from a full command string (e.g. "/help foo"). */
function commandName(command: string): string {
  return command.trim().split(/\s+/)[0];
}

export class SlashCommandExecutor {
  /** True if this command should go to the CLI (everything except /help, /clear). */
  shouldForwardToCLI(
    command: string,
    _session: { state: SessionState; registry: SlashCommandRegistry | null },
  ): boolean {
    const name = commandName(command);
    return name !== "/help" && name !== "/clear";
  }

  /**
   * Execute /help locally. Everything else should be forwarded, not executed here.
   * @throws if the command is not /help
   */
  async executeLocal(
    state: SessionState,
    command: string,
    registry?: SlashCommandRegistry | null,
  ): Promise<SlashCommandResult> {
    const name = commandName(command);
    if (name === "/help") {
      return {
        content: this.buildHelp(state, registry ?? null),
        source: "emulated",
        durationMs: 0,
      };
    }
    throw new Error(`Command "${name}" must be forwarded to CLI`);
  }

  /** Returns true if the command is a skill command in the registry. */
  isSkillCommand(command: string, registry: SlashCommandRegistry | null): boolean {
    return this.registryMatch(command, registry, (cmd) => cmd.source === "skill");
  }

  /** Returns true if the command is a passthrough command (forwarded to CLI without emulation). */
  isPassthroughCommand(command: string, registry: SlashCommandRegistry | null): boolean {
    return this.registryMatch(command, registry, (cmd) => cmd.category === "passthrough");
  }

  /** Look up a command in the registry and test it against a predicate. */
  private registryMatch(
    command: string,
    registry: SlashCommandRegistry | null,
    predicate: (cmd: RegisteredCommand) => boolean,
  ): boolean {
    if (!registry) return false;
    const cmd = registry.find(commandName(command));
    return cmd !== undefined && predicate(cmd);
  }

  /** Build /help output from capabilities, slash_commands, and registry. */
  private buildHelp(state: SessionState, registry: SlashCommandRegistry | null): string {
    const capCmds = state.capabilities?.commands;
    let content: string;

    if (capCmds && capCmds.length > 0) {
      const formatted = capCmds.map((cmd) => {
        const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : "";
        return `  ${cmd.name}${hint} — ${cmd.description}`;
      });
      content = ["Available commands:", ...formatted].join("\n");
    } else {
      // Fallback: list backend slash_commands when capabilities are unavailable
      const backendNames = new Set(
        state.slash_commands.map((n) => (n.startsWith("/") ? n : `/${n}`)),
      );
      const allNames = [...backendNames].sort();
      content = ["Available commands:", ...allNames.map((name) => `  ${name}`)].join("\n");
    }

    // Augment with registry commands not already listed
    if (registry) {
      content = this.augmentHelp(content, state, registry);
    }

    return content;
  }

  /** Augment /help output with registry commands not already listed. */
  private augmentHelp(
    baseContent: string,
    state: SessionState,
    registry: SlashCommandRegistry,
  ): string {
    const registryCommands = registry.getAll();
    const hasCapabilities = state.capabilities?.commands && state.capabilities.commands.length > 0;

    // Collect names already present in the help output (case-insensitive)
    const existingNames = new Set<string>();
    for (const line of baseContent.split("\n")) {
      const match = line.match(/^\s+(\/\S+)/);
      if (match) existingNames.add(match[1].toLowerCase());
    }

    // Find registry commands not yet listed
    const extra = registryCommands.filter((c) => !existingNames.has(c.name.toLowerCase()));
    if (extra.length === 0) return baseContent;

    const formatted = extra.map((cmd) => {
      const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : "";
      if (hasCapabilities) {
        return `  ${cmd.name}${hint} — ${cmd.description}`;
      }
      return `  ${cmd.name}`;
    });

    return `${baseContent}\n${formatted.join("\n")}`;
  }

  dispose(): void {
    // No-op — no resources to clean up
  }
}
