/**
 * Real Opencode backend e2e tests.
 *
 * Uses SessionCoordinator.createSession({ adapterName: "opencode" }) to exercise
 * the full lifecycle: spawn opencode serve, connect backend, consumer comms.
 *
 * Gated by opencode binary availability + localhost bind check.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { SessionCoordinator } from "../../core/session-coordinator.js";
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
import { setupRealSession } from "./session-coordinator-setup.js";
import { registerSharedFullTests, registerSharedSmokeTests } from "./shared-real-e2e-tests.js";

const prereqs = getOpencodePrereqState();
const canBindLocalhost = canBindLocalhostSync();
const runSmoke = prereqs.ok && canBindLocalhost;
const runFull = runSmoke && prereqs.canRunPromptTests;

describe("E2E Real Opencode SessionCoordinator", () => {
  const activeCoordinators: SessionCoordinator[] = [];

  afterEach(async (context: TestContextLike) => {
    dumpTraceOnFailure(context, activeCoordinators, "opencode-e2e-debug");

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
    adapterName: "opencode" as const,
    tokenPrefix: "OPENCODE",
    setup: (opts?: Parameters<typeof setupRealSession>[1]) => setupRealSession("opencode", opts),
    runSmoke,
    runFull,
    activeCoordinators,
    requireCliConnected: false,
  };

  registerSharedSmokeTests(sharedConfig);
  registerSharedFullTests(sharedConfig);

  // -------------------------------------------------------------------------
  // Opencode-unique full tests
  // -------------------------------------------------------------------------

  it.runIf(runFull)("assistant message carries model metadata", async () => {
    const { coordinator, sessionId, port } = await setupRealSession("opencode");
    activeCoordinators.push(coordinator);
    await waitForBackendConnectedOrExit(coordinator, sessionId, 30_000);

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
