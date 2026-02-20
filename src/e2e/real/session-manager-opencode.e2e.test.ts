/**
 * Real Opencode backend e2e tests.
 *
 * Uses SessionManager.createSession({ adapterName: "opencode" }) to exercise
 * the full lifecycle: spawn opencode serve, connect backend, consumer comms.
 *
 * Gated by opencode binary availability + localhost bind check.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { SessionManager } from "../../core/session-manager.js";
import {
  canBindLocalhostSync,
  closeWebSockets,
  connectConsumerAndWaitReady,
  deleteTrace,
  dumpTraceOnFailure,
  type TestContextLike,
  waitForBackendConnectedOrExit,
  waitForMessageType,
} from "./helpers.js";
import { getOpencodePrereqState } from "./prereqs.js";
import { setupRealSession } from "./session-manager-setup.js";
import { registerSharedFullTests, registerSharedSmokeTests } from "./shared-real-e2e-tests.js";

const prereqs = getOpencodePrereqState();
const canBindLocalhost = canBindLocalhostSync();
const runSmoke = prereqs.ok && canBindLocalhost;
const runFull = runSmoke && prereqs.canRunPromptTests;

describe("E2E Real Opencode SessionManager", () => {
  const activeManagers: SessionManager[] = [];

  afterEach(async (context: TestContextLike) => {
    dumpTraceOnFailure(context, activeManagers, "opencode-e2e-debug");

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
    adapterName: "opencode" as const,
    tokenPrefix: "OPENCODE",
    setup: (opts?: Parameters<typeof setupRealSession>[1]) => setupRealSession("opencode", opts),
    runSmoke,
    runFull,
    activeManagers,
    requireCliConnected: false,
  };

  registerSharedSmokeTests(sharedConfig);
  registerSharedFullTests(sharedConfig);

  // -------------------------------------------------------------------------
  // Opencode-unique full tests
  // -------------------------------------------------------------------------

  it.runIf(runFull)("assistant message carries model metadata", async () => {
    const { manager, sessionId, port } = await setupRealSession("opencode");
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY OPENCODE_MODEL_CHECK and nothing else.",
        }),
      );

      const assistant = (await waitForMessageType(consumer, "assistant", 90_000)) as {
        type: string;
        message?: {
          model_id?: string;
          provider_id?: string;
          tokens?: Record<string, unknown>;
        };
      };
      expect(assistant.type).toBe("assistant");
      expect(assistant.message).toBeDefined();

      await waitForMessageType(consumer, "result", 90_000);
    } finally {
      await closeWebSockets(consumer);
    }
  });
});
