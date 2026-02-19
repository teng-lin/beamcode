/**
 * GeminiAdapter compliance test -- runs the BackendAdapter compliance suite
 * against GeminiAdapter using shared ACP mock subprocess infrastructure.
 */

import { runBackendAdapterComplianceTests } from "../../core/interfaces/backend-adapter-compliance.js";
import type { SpawnFn } from "../acp/acp-adapter.js";
import { autoRespond, createMockChild } from "../acp/acp-mock-helpers.js";
import { GeminiAdapter } from "./gemini-adapter.js";

function createComplianceGeminiAdapter(): GeminiAdapter {
  const spawnFn: SpawnFn = ((_command: string, _args: string[]) => {
    const { child, stdin, stdout } = createMockChild();
    autoRespond(stdin, stdout, {
      initResult: { agentInfo: { name: "gemini-compliance", version: "1.0" } },
      echoPrompts: true,
    });
    return child;
  }) as unknown as SpawnFn;

  return new GeminiAdapter({ spawnFn });
}

runBackendAdapterComplianceTests("GeminiAdapter", createComplianceGeminiAdapter);
