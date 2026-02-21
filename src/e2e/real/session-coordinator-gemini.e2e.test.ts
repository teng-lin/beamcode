/**
 * Real Gemini backend e2e tests.
 *
 * Uses SessionCoordinator.createSession({ adapterName: "gemini" }) to exercise
 * the full lifecycle: spawn gemini --experimental-acp, connect backend, consumer comms.
 *
 * Gated by gemini binary + API key availability + localhost bind check.
 * Note: gemini requires credentials even for smoke tests (the --experimental-acp
 * handshake needs authentication).
 */

import { afterEach, describe } from "vitest";
import type { SessionCoordinator } from "../../core/session-coordinator.js";
import {
  canBindLocalhostSync,
  deleteTrace,
  dumpTraceOnFailure,
  type TestContextLike,
} from "./helpers.js";
import { getGeminiPrereqState } from "./prereqs.js";
import { setupRealSession } from "./session-coordinator-setup.js";
import { registerSharedFullTests, registerSharedSmokeTests } from "./shared-real-e2e-tests.js";

const prereqs = getGeminiPrereqState();
const canBindLocalhost = canBindLocalhostSync();
const runSmoke = prereqs.ok && canBindLocalhost;
const runFull = runSmoke && prereqs.canRunPromptTests;

describe("E2E Real Gemini SessionCoordinator", () => {
  const activeCoordinators: SessionCoordinator[] = [];

  afterEach(async (context: TestContextLike) => {
    dumpTraceOnFailure(context, activeCoordinators, "gemini-e2e-debug");

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
    adapterName: "gemini" as const,
    tokenPrefix: "GEMINI",
    setup: (opts?: Parameters<typeof setupRealSession>[1]) => setupRealSession("gemini", opts),
    runSmoke,
    runFull,
    activeCoordinators,
    requireCliConnected: false,
  };

  registerSharedSmokeTests(sharedConfig);
  registerSharedFullTests(sharedConfig);
});
