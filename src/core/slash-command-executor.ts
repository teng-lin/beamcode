import type { SessionState } from "../types/session-state.js";
import type { SlashCommandRegistry } from "./slash-command-registry.js";

export interface SlashCommandResult {
  content: string;
  source: "emulated";
  durationMs: number;
}

/** Extract the command name (e.g. "/help") from a full command string (e.g. "/help foo"). */
export function commandName(command: string): string {
  return command.trim().split(/\s+/)[0];
}

export class SlashCommandExecutor {
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

  /** Build /help output from capabilities, slash_commands, and registry. */
  private buildHelp(state: SessionState, registry: SlashCommandRegistry | null): string {
    const capCmds = state.capabilities?.commands;
    const hasCapabilities = capCmds != null && capCmds.length > 0;
    let content: string;

    if (hasCapabilities) {
      const formatted = capCmds.map((cmd) => {
        const name = cmd.name.startsWith("/") ? cmd.name : `/${cmd.name}`;
        const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : "";
        return `  ${name}${hint} — ${cmd.description}`;
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

    if (registry) {
      content = this.augmentHelp(content, hasCapabilities, registry);
    }

    return content;
  }

  /** Augment /help output with registry commands not already listed. */
  private augmentHelp(
    baseContent: string,
    hasCapabilities: boolean,
    registry: SlashCommandRegistry,
  ): string {
    const registryCommands = registry.getAll();

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
}
