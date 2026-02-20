export type CliAdapterName = "claude" | "codex" | "acp" | "gemini" | "opencode";
export type AdapterName = CliAdapterName | "agent-sdk";
export const CLI_ADAPTER_NAMES: readonly CliAdapterName[] = [
  "claude",
  "codex",
  "acp",
  "gemini",
  "opencode",
];
