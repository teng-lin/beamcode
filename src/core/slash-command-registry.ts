export type CommandCategory = "consumer" | "relay" | "passthrough";

export interface SlashCommandDef {
  name: string;
  description: string;
  category: CommandCategory;
  argumentHint?: string;
  availableDuringTask: boolean;
}

/** Consumer-local commands handled entirely in the browser. */
export const CONSUMER_COMMANDS: SlashCommandDef[] = [
  {
    name: "/help",
    description: "Show all available commands",
    category: "consumer",
    availableDuringTask: true,
  },
  {
    name: "/clear",
    description: "Clear the message display",
    category: "consumer",
    availableDuringTask: true,
  },
];

/** Commands emulated by the relay from session state. */
export const RELAY_COMMANDS: SlashCommandDef[] = [
  {
    name: "/model",
    description: "Show the current model",
    category: "relay",
    availableDuringTask: true,
  },
  {
    name: "/status",
    description: "Show session status summary",
    category: "relay",
    availableDuringTask: true,
  },
  {
    name: "/config",
    description: "Show session configuration",
    category: "relay",
    availableDuringTask: true,
  },
  {
    name: "/cost",
    description: "Show cost and token usage",
    category: "relay",
    availableDuringTask: true,
  },
  {
    name: "/context",
    description: "Show context window usage",
    category: "relay",
    availableDuringTask: true,
  },
];

/** Commands forwarded to the CLI as user messages. */
export const PASSTHROUGH_COMMANDS: SlashCommandDef[] = [
  {
    name: "/compact",
    description: "Compact conversation context",
    category: "passthrough",
    availableDuringTask: false,
  },
  {
    name: "/files",
    description: "Show files in context",
    category: "passthrough",
    availableDuringTask: false,
  },
  {
    name: "/release-notes",
    description: "Show release notes",
    category: "passthrough",
    availableDuringTask: false,
  },
];

const ALL_COMMANDS: SlashCommandDef[] = [
  ...CONSUMER_COMMANDS,
  ...RELAY_COMMANDS,
  ...PASSTHROUGH_COMMANDS,
];

/** Look up a command definition by name (e.g. "/help"). */
export function findCommand(name: string): SlashCommandDef | undefined {
  return ALL_COMMANDS.find((cmd) => cmd.name === name);
}

/** Return all known command definitions. */
export function getAllCommands(): SlashCommandDef[] {
  return ALL_COMMANDS;
}
