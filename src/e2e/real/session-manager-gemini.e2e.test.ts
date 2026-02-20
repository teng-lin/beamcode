/**
 * Real Gemini backend e2e tests.
 *
 * Uses SessionManager.createSession({ adapterName: "gemini" }) to exercise
 * the full lifecycle: spawn gemini --experimental-acp, connect backend, consumer comms.
 *
 * Gated by gemini binary + API key availability + localhost bind check.
 * Note: gemini requires credentials even for smoke tests (the --experimental-acp
 * handshake needs authentication).
 */

import { afterEach, describe } from "vitest";
import type { SessionManager } from "../../core/session-manager.js";
import {
  canBindLocalhostSync,
  deleteTrace,
  dumpTraceOnFailure,
  type TestContextLike,
} from "./helpers.js";
import { getGeminiPrereqState } from "./prereqs.js";
import { setupRealSession } from "./session-manager-setup.js";
import { registerSharedFullTests, registerSharedSmokeTests } from "./shared-real-e2e-tests.js";

const prereqs = getGeminiPrereqState();
const canBindLocalhost = canBindLocalhostSync();
const runSmoke = prereqs.ok && canBindLocalhost;
const runFull = runSmoke && prereqs.canRunPromptTests;

describe("E2E Real Gemini SessionManager", () => {
  const activeManagers: SessionManager[] = [];

  afterEach(async (context: TestContextLike) => {
    dumpTraceOnFailure(context, activeManagers, "gemini-e2e-debug");

    while (activeManagers.length > 0) {
      const manager = activeManagers.pop();
      if (manager) {
        await manager.stop();
        deleteTrace(manager);
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
    activeManagers,
    requireCliConnected: false,
  };

  registerSharedSmokeTests(sharedConfig);
  registerSharedFullTests(sharedConfig);
});
