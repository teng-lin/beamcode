/**
 * Real Agent SDK backend e2e tests.
 *
 * Uses SessionCoordinator.createSession({ adapterName: "claude:agent-sdk" })
 * to exercise the full lifecycle: in-process SDK query, consumer comms.
 *
 * The Agent SDK is a direct-connection adapter (no child process, no launcher).
 * It runs in-process via `import("@anthropic-ai/claude-agent-sdk")`.
 *
 * Prereqs: Claude CLI available + authenticated, SDK package installed.
 * No separate API key needed — the SDK uses CLI auth.
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
import { getAgentSdkPrereqState } from "./prereqs.js";
import { setupRealSession } from "./session-coordinator-setup.js";

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
  // Smoke tests (SDK package + Claude CLI available, no API key needed)
  // -------------------------------------------------------------------------

  it.runIf(runSmoke)("createSession connects agent-sdk backend (in-process)", async () => {
    const { coordinator, sessionId } = await setupRealSession("claude:agent-sdk");
    activeCoordinators.push(coordinator);

    // For direct-connection adapters, createSession already awaits connection.
    // waitForBackendConnectedOrExit resolves immediately.
    await waitForBackendConnectedOrExit(coordinator, sessionId, 30_000);
    expect(coordinator.bridge.isBackendConnected(sessionId)).toBe(true);
  });

  it.runIf(runSmoke)("consumer gets session_init from agent-sdk backend", async () => {
    const { coordinator, sessionId, port } = await setupRealSession("claude:agent-sdk");
    activeCoordinators.push(coordinator);

    await waitForBackendConnectedOrExit(coordinator, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      expect(coordinator.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runSmoke)("two consumers on same session both receive session_init", async () => {
    const { coordinator, sessionId, port } = await setupRealSession("claude:agent-sdk");
    activeCoordinators.push(coordinator);

    await waitForBackendConnectedOrExit(coordinator, sessionId, 30_000);

    const consumer1 = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    const consumer2 = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      expect(coordinator.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(consumer1, consumer2);
    }
  });

  it.runIf(runSmoke)(
    "backend stays connected across consumer disconnect and reconnect",
    async () => {
      const { coordinator, sessionId, port } = await setupRealSession("claude:agent-sdk");
      activeCoordinators.push(coordinator);

      await waitForBackendConnectedOrExit(coordinator, sessionId, 30_000);

      const consumer1 = await connectConsumerAndWaitReady(port, sessionId, {
        requireCliConnected: false,
      });
      await closeWebSockets(consumer1);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(coordinator.bridge.isBackendConnected(sessionId)).toBe(true);

      const consumer2 = await connectConsumerAndWaitReady(port, sessionId, {
        requireCliConnected: false,
      });
      try {
        expect(coordinator.bridge.isBackendConnected(sessionId)).toBe(true);
      } finally {
        await closeWebSockets(consumer2);
      }
    },
  );

  it.runIf(runSmoke)("deleteSession removes a live agent-sdk session", async () => {
    const { coordinator, sessionId } = await setupRealSession("claude:agent-sdk");
    activeCoordinators.push(coordinator);

    await waitForBackendConnectedOrExit(coordinator, sessionId, 30_000);

    expect(coordinator.bridge.isBackendConnected(sessionId)).toBe(true);
    const deleted = await coordinator.deleteSession(sessionId);
    expect(deleted).toBe(true);
    expect(coordinator.bridge.getSession(sessionId)).toBeUndefined();
  });

  it.runIf(runSmoke)("two independent agent-sdk sessions can connect concurrently", async () => {
    const session1 = await setupRealSession("claude:agent-sdk");
    const session2 = await setupRealSession("claude:agent-sdk");
    activeCoordinators.push(session1.coordinator, session2.coordinator);

    await Promise.all([
      waitForBackendConnectedOrExit(session1.coordinator, session1.sessionId, 30_000),
      waitForBackendConnectedOrExit(session2.coordinator, session2.sessionId, 30_000),
    ]);

    expect(session1.coordinator.bridge.isBackendConnected(session1.sessionId)).toBe(true);
    expect(session2.coordinator.bridge.isBackendConnected(session2.sessionId)).toBe(true);
  });

  it.runIf(runSmoke)("deleteSession on non-existent session returns false", async () => {
    const { coordinator } = await setupRealSession("claude:agent-sdk");
    activeCoordinators.push(coordinator);

    const deleted = await coordinator.deleteSession("non-existent-session-id");
    expect(deleted).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Full tests (require CLI auth — sends real prompts to Claude)
  // -------------------------------------------------------------------------

  it.runIf(runFull)("user_message gets an assistant reply from real agent-sdk", async () => {
    const { coordinator, sessionId, port } = await setupRealSession("claude:agent-sdk");
    activeCoordinators.push(coordinator);

    await waitForBackendConnectedOrExit(coordinator, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY AGENTSDK_E2E_OK and nothing else.",
        }),
      );

      const assistant = await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "AGENTSDK_E2E_OK"),
        90_000,
      );
      expect(assistantTextContains(assistant, "AGENTSDK_E2E_OK")).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFull)("response includes stream_event messages before result", async () => {
    const { coordinator, sessionId, port } = await setupRealSession("claude:agent-sdk");
    activeCoordinators.push(coordinator);

    await waitForBackendConnectedOrExit(coordinator, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      const streamEventPromise = waitForMessage(
        consumer,
        (msg) => {
          if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
          return (msg as { type?: string }).type === "stream_event";
        },
        90_000,
      );
      const resultPromise = waitForMessage(
        consumer,
        (msg) => {
          if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
          return (msg as { type?: string }).type === "result";
        },
        90_000,
      );

      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY AGENTSDK_STREAM_CHECK and nothing else.",
        }),
      );

      const streamEvent = await streamEventPromise;
      expect((streamEvent as { type: string }).type).toBe("stream_event");

      const result = await resultPromise;
      expect((result as { type: string }).type).toBe("result");
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFull)("same session supports a second turn", async () => {
    const { coordinator, sessionId, port } = await setupRealSession("claude:agent-sdk");
    activeCoordinators.push(coordinator);

    await waitForBackendConnectedOrExit(coordinator, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY AGENTSDK_TURN_ONE and nothing else.",
        }),
      );
      await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "AGENTSDK_TURN_ONE"),
        90_000,
      );
      await waitForMessageType(consumer, "result", 90_000);

      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY AGENTSDK_TURN_TWO and nothing else.",
        }),
      );
      const turnTwo = await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "AGENTSDK_TURN_TWO"),
        90_000,
      );
      expect(assistantTextContains(turnTwo, "AGENTSDK_TURN_TWO")).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFull)("broadcast assistant reply to two consumers", async () => {
    const { coordinator, sessionId, port } = await setupRealSession("claude:agent-sdk");
    activeCoordinators.push(coordinator);

    await waitForBackendConnectedOrExit(coordinator, sessionId, 30_000);

    const consumer1 = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    const consumer2 = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      consumer1.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY AGENTSDK_BROADCAST_OK and nothing else.",
        }),
      );

      const [assistant1, assistant2] = await Promise.all([
        waitForMessage(
          consumer1,
          (msg) => assistantTextContains(msg, "AGENTSDK_BROADCAST_OK"),
          90_000,
        ),
        waitForMessage(
          consumer2,
          (msg) => assistantTextContains(msg, "AGENTSDK_BROADCAST_OK"),
          90_000,
        ),
      ]);
      expect(assistantTextContains(assistant1, "AGENTSDK_BROADCAST_OK")).toBe(true);
      expect(assistantTextContains(assistant2, "AGENTSDK_BROADCAST_OK")).toBe(true);
    } finally {
      await closeWebSockets(consumer1, consumer2);
    }
  });

  it.runIf(runFull)("interrupt mid-turn does not crash", async () => {
    const { coordinator, sessionId, port } = await setupRealSession("claude:agent-sdk");
    activeCoordinators.push(coordinator);

    await waitForBackendConnectedOrExit(coordinator, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Write a very long essay about software engineering best practices.",
        }),
      );

      // Wait for streaming to start
      await waitForMessage(
        consumer,
        (msg) => {
          const m = msg as { type?: string };
          return (
            m.type === "stream_event" ||
            m.type === "assistant_message" ||
            m.type === "status_change"
          );
        },
        15_000,
      );

      consumer.send(JSON.stringify({ type: "interrupt" }));

      // Wait for the turn to finish
      await waitForMessage(
        consumer,
        (msg) => {
          if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
          return (msg as { type?: string }).type === "result";
        },
        15_000,
      ).catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(coordinator.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });
});
