/**
 * Real Codex backend e2e tests.
 *
 * Uses SessionManager.createSession({ adapterName: "codex" }) to exercise
 * the full lifecycle: spawn codex app-server, connect backend, consumer comms.
 *
 * Gated by codex binary availability + localhost bind check.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { SessionManager } from "../../core/session-manager.js";
import { getE2EProfile } from "../helpers/e2e-profile.js";
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
import { setupRealSession } from "./session-manager-setup.js";

const profile = getE2EProfile();
const prereqs = getCodexPrereqState();
const canBindLocalhost = canBindLocalhostSync();
const runCodex = prereqs.ok && canBindLocalhost;
const runFullOnly = runCodex && prereqs.canRunPromptTests && profile === "real-full";

describe("E2E Real Codex SessionManager", () => {
  const activeManagers: SessionManager[] = [];

  afterEach(async (context: TestContextLike) => {
    dumpTraceOnFailure(context, activeManagers, "codex-e2e-debug");

    while (activeManagers.length > 0) {
      const manager = activeManagers.pop();
      if (manager) {
        await manager.stop();
        deleteTrace(manager);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Smoke tests (runCodex — binary available, no API key needed)
  // -------------------------------------------------------------------------

  it.runIf(runCodex)("createSession connects codex backend", async () => {
    const { manager, sessionId } = await setupRealSession("codex");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);
    expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
  });

  it.runIf(runCodex)("consumer gets session_init + cli_connected", async () => {
    const { manager, sessionId, port } = await setupRealSession("codex");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
    try {
      // connectConsumerAndWaitReady already verifies session_init + cli_connected
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runCodex)("deleteSession cleans up", async () => {
    const { manager, sessionId } = await setupRealSession("codex");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const deleted = await manager.deleteSession(sessionId);
    expect(deleted).toBe(true);
    expect(manager.launcher.getSession(sessionId)).toBeUndefined();
    expect(manager.bridge.getSession(sessionId)).toBeUndefined();
  });

  it.runIf(runCodex)(
    "backend stays connected across consumer disconnect and reconnect",
    async () => {
      const { manager, sessionId, port } = await setupRealSession("codex");
      activeManagers.push(manager);

      await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

      // Connect and disconnect first consumer
      const consumer1 = await connectConsumerAndWaitReady(port, sessionId);
      await closeWebSockets(consumer1);

      // Brief pause for close handlers
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);

      // Second consumer should still get session_init + cli_connected
      const consumer2 = await connectConsumerAndWaitReady(port, sessionId);
      try {
        expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
      } finally {
        await closeWebSockets(consumer2);
      }
    },
  );

  it.runIf(runCodex)("two independent codex sessions can connect concurrently", async () => {
    const session1 = await setupRealSession("codex");
    const session2 = await setupRealSession("codex");
    activeManagers.push(session1.manager, session2.manager);

    await Promise.all([
      waitForBackendConnectedOrExit(session1.manager, session1.sessionId, 30_000),
      waitForBackendConnectedOrExit(session2.manager, session2.sessionId, 30_000),
    ]);

    expect(session1.manager.bridge.isBackendConnected(session1.sessionId)).toBe(true);
    expect(session2.manager.bridge.isBackendConnected(session2.sessionId)).toBe(true);
  });

  it.runIf(runCodex)("stress: sequential codex sessions connect and teardown (x3)", async () => {
    for (let i = 0; i < 3; i++) {
      const { manager, sessionId } = await setupRealSession("codex");
      activeManagers.push(manager);

      await waitForBackendConnectedOrExit(manager, sessionId, 30_000);
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);

      const deleted = await manager.deleteSession(sessionId);
      expect(deleted).toBe(true);
    }
  });

  it.runIf(runCodex)(
    "consumer attaching immediately after createSession reaches ready state",
    async () => {
      const { manager, sessionId, port } = await setupRealSession("codex");
      activeManagers.push(manager);

      // Connect consumer right away (may beat backend connection)
      const consumer = await connectConsumerAndWaitReady(port, sessionId, {
        requireCliConnected: false,
      });
      try {
        await waitForBackendConnectedOrExit(manager, sessionId, 30_000);
        expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
      } finally {
        await closeWebSockets(consumer);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Full tests (runFullOnly — requires API key + real-full profile)
  // -------------------------------------------------------------------------

  it.runIf(runFullOnly)("user_message gets an assistant reply from real codex", async () => {
    const { manager, sessionId, port } = await setupRealSession("codex");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY CODEX_E2E_OK and nothing else.",
        }),
      );

      const assistant = await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "CODEX_E2E_OK"),
        90_000,
      );
      expect(assistantTextContains(assistant, "CODEX_E2E_OK")).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFullOnly)("same session supports a second turn", async () => {
    const { manager, sessionId, port } = await setupRealSession("codex");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
    try {
      // Turn 1
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY CODEX_TURN_ONE and nothing else.",
        }),
      );
      await waitForMessage(consumer, (msg) => assistantTextContains(msg, "CODEX_TURN_ONE"), 90_000);
      await waitForMessageType(consumer, "result", 90_000);

      // Turn 2
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY CODEX_TURN_TWO and nothing else.",
        }),
      );
      const turnTwo = await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "CODEX_TURN_TWO"),
        90_000,
      );
      expect(assistantTextContains(turnTwo, "CODEX_TURN_TWO")).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFullOnly)("broadcast assistant reply to two consumers", async () => {
    const { manager, sessionId, port } = await setupRealSession("codex");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer1 = await connectConsumerAndWaitReady(port, sessionId);
    const consumer2 = await connectConsumerAndWaitReady(port, sessionId);
    try {
      consumer1.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY CODEX_BROADCAST_OK and nothing else.",
        }),
      );

      const [assistant1, assistant2] = await Promise.all([
        waitForMessage(
          consumer1,
          (msg) => assistantTextContains(msg, "CODEX_BROADCAST_OK"),
          90_000,
        ),
        waitForMessage(
          consumer2,
          (msg) => assistantTextContains(msg, "CODEX_BROADCAST_OK"),
          90_000,
        ),
      ]);
      expect(assistantTextContains(assistant1, "CODEX_BROADCAST_OK")).toBe(true);
      expect(assistantTextContains(assistant2, "CODEX_BROADCAST_OK")).toBe(true);

      const [result1, result2] = await Promise.all([
        waitForMessageType(consumer1, "result", 90_000),
        waitForMessageType(consumer2, "result", 90_000),
      ]);
      expect((result1 as { type: string }).type).toBe("result");
      expect((result2 as { type: string }).type).toBe("result");
    } finally {
      await closeWebSockets(consumer1, consumer2);
    }
  });

  it.runIf(runFullOnly)("cancel mid-turn does not crash", async () => {
    const { manager, sessionId, port } = await setupRealSession("codex");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Write a very long essay about software engineering best practices.",
        }),
      );

      // Wait for streaming to start (event-based, no arbitrary sleep)
      await waitForMessage(
        consumer,
        (msg) => {
          const m = msg as { type?: string };
          return m.type === "stream_event" || m.type === "assistant_message";
        },
        15_000,
      );

      // Send interrupt
      consumer.send(JSON.stringify({ type: "interrupt" }));

      // Wait for the turn to finish (result signals completion)
      await waitForMessageType(consumer, "result", 15_000);

      // Backend should still be functional (not crashed)
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFullOnly)("slash command /new works via codex", async () => {
    const { manager, sessionId, port } = await setupRealSession("codex");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    // Send a message first so there's an active thread to reset
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

      // Now send /new to reset the thread
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
