/**
 * Real Agent SDK backend e2e tests.
 *
 * Uses SessionCoordinator.createSession({ adapterName: "claude:agent-sdk" })
 * to exercise the full lifecycle: in-process SDK query, consumer comms.
 *
 * The Agent SDK is a direct-connection adapter (no child process).
 * It runs in-process via `import("@anthropic-ai/claude-agent-sdk")`.
 *
 * Prereqs: Claude CLI available + logged in, SDK package installed.
 * No separate API key needed — the SDK uses CLI auth.
 */

import { afterEach, describe } from "vitest";
import type { SessionCoordinator } from "../../core/session-coordinator.js";
import {
  canBindLocalhostSync,
  deleteTrace,
  dumpTraceOnFailure,
  type TestContextLike,
} from "./helpers.js";
import { getAgentSdkPrereqState } from "./prereqs.js";
import { setupRealSession } from "./session-coordinator-setup.js";
import { registerSharedFullTests, registerSharedSmokeTests } from "./shared-real-e2e-tests.js";

const prereqs = getAgentSdkPrereqState();
const canBindLocalhost = canBindLocalhostSync();
const runSmoke = prereqs.ok && canBindLocalhost;
const runFull = runSmoke && prereqs.canRunPromptTests;

describe("E2E Real Agent SDK SessionCoordinator", () => {
  const activeCoordinators: SessionCoordinator[] = [];

  afterEach(async (context: TestContextLike) => {
    dumpTraceOnFailure(context, activeCoordinators, "agent-sdk-e2e-debug");

    while (activeCoordinators.length > 0) {
      const coordinator = activeCoordinators.pop();
      if (coordinator) {
        await coordinator.stop();
        deleteTrace(coordinator);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Shared smoke + full tests
  // -------------------------------------------------------------------------

  const sharedConfig = {
    adapterName: "claude:agent-sdk" as const,
    tokenPrefix: "AGENTSDK",
    setup: (opts?: Parameters<typeof setupRealSession>[1]) =>
      setupRealSession("claude:agent-sdk", opts),
    runSmoke,
    runFull,
    activeCoordinators,
    requireCliConnected: false,
  };

  registerSharedSmokeTests(sharedConfig);
  registerSharedFullTests(sharedConfig);
});
