export type CommandCategory = "consumer" | "passthrough";
export type CommandSource = "built-in" | "cli" | "skill";

export interface RegisteredCommand {
  name: string;
  description: string;
  source: CommandSource;
  category?: CommandCategory;
  argumentHint?: string;
  availableDuringTask: boolean;
}

/** Built-in commands that BeamCode handles without the CLI. */
const BUILT_IN_COMMANDS: RegisteredCommand[] = [
  {
    name: "/help",
    description: "Show all available commands",
    source: "built-in",
    category: "consumer",
    availableDuringTask: true,
  },
  {
    name: "/clear",
    description: "Clear conversation context",
    source: "built-in",
    category: "passthrough",
    availableDuringTask: false,
  },
  {
    name: "/model",
    description: "Show the current model",
    source: "built-in",
    category: "passthrough",
    availableDuringTask: true,
  },
  {
    name: "/status",
    description: "Show session status summary",
    source: "built-in",
    category: "passthrough",
    availableDuringTask: true,
  },
  {
    name: "/config",
    description: "Show session configuration",
    source: "built-in",
    category: "passthrough",
    availableDuringTask: true,
  },
  {
    name: "/cost",
    description: "Show cost and token usage",
    source: "built-in",
    category: "passthrough",
    availableDuringTask: false,
  },
  {
    name: "/context",
    description: "Show context window usage",
    source: "built-in",
    category: "passthrough",
    availableDuringTask: false,
  },
  {
    name: "/compact",
    description: "Compact conversation context",
    source: "built-in",
    category: "passthrough",
    availableDuringTask: false,
  },
  {
    name: "/files",
    description: "Show files in context",
    source: "built-in",
    category: "passthrough",
    availableDuringTask: false,
  },
  {
    name: "/release-notes",
    description: "Show release notes",
    source: "built-in",
    category: "passthrough",
    availableDuringTask: false,
  },
];

export class SlashCommandRegistry {
  private commands = new Map<string, RegisteredCommand>();

  constructor() {
    for (const cmd of BUILT_IN_COMMANDS) {
      this.commands.set(cmd.name.toLowerCase(), { ...cmd });
    }
  }

  find(name: string): RegisteredCommand | undefined {
    const key = name.toLowerCase();
    return this.commands.get(key.startsWith("/") ? key : `/${key}`);
  }

  getAll(): RegisteredCommand[] {
    return Array.from(this.commands.values());
  }

  getBySource(source: CommandSource): RegisteredCommand[] {
    return this.getAll().filter((c) => c.source === source);
  }

  registerFromCLI(
    commands: Array<{
      name: string;
      description: string;
      argumentHint?: string;
    }>,
  ): void {
    for (const cmd of commands) {
      const name = cmd.name.startsWith("/") ? cmd.name : `/${cmd.name}`;
      const key = name.toLowerCase();
      const existing = this.commands.get(key);
      if (existing && existing.source === "built-in") {
        // Enrich built-in with CLI metadata but keep source as built-in
        existing.description = cmd.description;
        if (cmd.argumentHint) existing.argumentHint = cmd.argumentHint;
      } else {
        this.commands.set(key, {
          name,
          description: cmd.description,
          source: "cli",
          argumentHint: cmd.argumentHint,
          availableDuringTask: false,
        });
      }
    }
  }

  registerSkills(skills: string[]): void {
    for (const skill of skills) {
      const name = skill.startsWith("/") ? skill : `/${skill}`;
      const key = name.toLowerCase();
      const existing = this.commands.get(key);
      if (existing) {
        // Only upgrade from "cli" to "skill", preserve "built-in"
        if (existing.source === "cli") {
          existing.source = "skill";
        }
      } else {
        this.commands.set(key, {
          name,
          description: `Run ${skill} skill`,
          source: "skill",
          availableDuringTask: false,
        });
      }
    }
  }

  clearDynamic(): void {
    for (const [key, cmd] of this.commands) {
      if (cmd.source !== "built-in") {
        this.commands.delete(key);
      }
    }
  }
}
