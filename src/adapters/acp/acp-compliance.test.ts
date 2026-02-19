/**
 * AcpAdapter compliance test -- runs the BackendAdapter compliance suite
 * against AcpAdapter with mock subprocess infrastructure.
 */

import { runBackendAdapterComplianceTests } from "../../core/interfaces/backend-adapter-compliance.js";
import type { SpawnFn } from "./acp-adapter.js";
import { AcpAdapter } from "./acp-adapter.js";
import { autoRespond, createMockChild } from "./acp-mock-helpers.js";

function createComplianceAcpAdapter(): AcpAdapter {
  const spawnFn: SpawnFn = ((_command: string, _args: string[]) => {
    const { child, stdin, stdout } = createMockChild();
    autoRespond(stdin, stdout, {
      initResult: { agentInfo: { name: "compliance-agent", version: "1.0" } },
      echoPrompts: true,
    });
    return child;
  }) as unknown as SpawnFn;

  return new AcpAdapter(spawnFn);
}

runBackendAdapterComplianceTests("AcpAdapter", createComplianceAcpAdapter);
