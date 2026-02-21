/**
 * Real Codex backend e2e tests.
 *
 * Uses SessionCoordinator.createSession({ adapterName: "codex" }) to exercise
 * the full lifecycle: spawn codex app-server, connect backend, consumer comms.
 *
 * Gated by codex binary availability + localhost bind check.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { SessionCoordinator } from "../../core/session-coordinator.js";
import {
  assistantTextContains,
  canBindLocalhostSync,
  closeWebSockets,
  connectConsumerAndWaitReady,
  deleteTrace,
  dumpTraceOnFailure,
  type TestContextLike,
  waitForBackendConnectedOrExit,
  waitForMessage,
  waitForMessageType,
} from "./helpers.js";
import { getCodexPrereqState } from "./prereqs.js";
import { setupRealSession } from "./session-coordinator-setup.js";
import { registerSharedFullTests, registerSharedSmokeTests } from "./shared-real-e2e-tests.js";

const prereqs = getCodexPrereqState();
const canBindLocalhost = canBindLocalhostSync();
const runSmoke = prereqs.ok && canBindLocalhost;
const runFull = runSmoke && prereqs.canRunPromptTests;

describe("E2E Real Codex SessionCoordinator", () => {
  const activeCoordinators: SessionCoordinator[] = [];

  afterEach(async (context: TestContextLike) => {
    dumpTraceOnFailure(context, activeCoordinators, "codex-e2e-debug");

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
    adapterName: "codex" as const,
    tokenPrefix: "CODEX",
    setup: (opts?: Parameters<typeof setupRealSession>[1]) => setupRealSession("codex", opts),
    runSmoke,
    runFull,
    activeCoordinators,
  };

  registerSharedSmokeTests(sharedConfig);
  registerSharedFullTests(sharedConfig);

  // -------------------------------------------------------------------------
  // Codex-unique full tests
  // -------------------------------------------------------------------------

  it.runIf(runFull)("slash command /new works via codex", async () => {
    const { coordinator, sessionId, port } = await setupRealSession("codex");
    activeCoordinators.push(coordinator);

    await waitForBackendConnectedOrExit(coordinator, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY CODEX_PRE_SLASH and nothing else.",
        }),
      );
      await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "CODEX_PRE_SLASH"),
        90_000,
      );
      await waitForMessageType(consumer, "result", 90_000);

      consumer.send(
        JSON.stringify({
          type: "slash_command",
          command: "/new",
          request_id: "codex-new-1",
        }),
      );

      const msg = (await waitForMessageType(consumer, "slash_command_result", 60_000)) as {
        type: string;
        request_id?: string;
        content?: string;
        source?: string;
      };
      expect(msg.type).toBe("slash_command_result");
      expect(msg.request_id).toBe("codex-new-1");
      expect(msg.source).toBe("emulated");
      expect(msg.content).toContain("New thread started");
    } finally {
      await closeWebSockets(consumer);
    }
  });
});
