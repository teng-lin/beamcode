import type { BackendAdapter } from "../core/interfaces/backend-adapter.js";
import type { Logger } from "../interfaces/logger.js";
import type { ProcessManager } from "../interfaces/process-manager.js";
import { AcpAdapter } from "./acp/acp-adapter.js";
import { AgentSdkAdapter } from "./agent-sdk/agent-sdk-adapter.js";
import { ClaudeAdapter } from "./claude/claude-adapter.js";
import { CodexAdapter } from "./codex/codex-adapter.js";
import { GeminiAdapter } from "./gemini/gemini-adapter.js";
import { OpencodeAdapter } from "./opencode/opencode-adapter.js";

export type { CliAdapterName } from "../core/interfaces/adapter-names.js";
export { CLI_ADAPTER_NAMES } from "../core/interfaces/adapter-names.js";

import type { CliAdapterName } from "../core/interfaces/adapter-names.js";
import { CLI_ADAPTER_NAMES } from "../core/interfaces/adapter-names.js";

export interface CreateAdapterDeps {
  processManager: ProcessManager;
  logger?: Logger;
}

export function createAdapter(
  name: CliAdapterName | undefined,
  deps: CreateAdapterDeps,
): BackendAdapter {
  const resolved = name ?? "claude";

  switch (resolved) {
    case "claude":
      return new ClaudeAdapter();
    case "claude:agent-sdk":
      return new AgentSdkAdapter();
    case "codex":
      return new CodexAdapter({
        processManager: deps.processManager,
        logger: deps.logger,
      });
    case "acp":
      return new AcpAdapter();
    case "gemini":
      return new GeminiAdapter();
    case "opencode":
      return new OpencodeAdapter({
        processManager: deps.processManager,
        logger: deps.logger,
      });
    default:
      throw new Error(
        `Unknown adapter "${resolved}". Valid adapters: ${CLI_ADAPTER_NAMES.join(", ")}`,
      );
  }
}
