import type { BackendAdapter } from "../core/interfaces/backend-adapter.js";
import type { Logger } from "../interfaces/logger.js";
import type { ProcessManager } from "../interfaces/process-manager.js";
import { AcpAdapter } from "./acp/acp-adapter.js";
import { CodexAdapter } from "./codex/codex-adapter.js";
import { GeminiAdapter } from "./gemini/gemini-adapter.js";
import { OpencodeAdapter } from "./opencode/opencode-adapter.js";
import { SdkUrlAdapter } from "./sdk-url/sdk-url-adapter.js";

export type CliAdapterName = "sdk-url" | "codex" | "acp" | "gemini" | "opencode";
export type AdapterName = CliAdapterName | "agent-sdk";

export const CLI_ADAPTER_NAMES: readonly CliAdapterName[] = [
  "sdk-url",
  "codex",
  "acp",
  "gemini",
  "opencode",
];

export interface CreateAdapterDeps {
  processManager: ProcessManager;
  logger?: Logger;
}

export function createAdapter(
  name: AdapterName | undefined,
  deps: CreateAdapterDeps,
): BackendAdapter {
  const resolved = name ?? "sdk-url";

  switch (resolved) {
    case "sdk-url":
      return new SdkUrlAdapter();
    case "codex":
      return new CodexAdapter({
        processManager: deps.processManager,
        logger: deps.logger,
      });
    case "acp":
      return new AcpAdapter();
    case "gemini":
      return new GeminiAdapter({ logger: deps.logger });
    case "opencode":
      return new OpencodeAdapter({
        processManager: deps.processManager,
        logger: deps.logger,
      });
    case "agent-sdk":
      throw new Error("agent-sdk adapter requires a queryFn and cannot be created via CLI flag");
    default:
      throw new Error(
        `Unknown adapter "${resolved}". Valid adapters: sdk-url, codex, acp, gemini, opencode`,
      );
  }
}
