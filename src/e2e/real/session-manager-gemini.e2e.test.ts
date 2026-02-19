/**
 * Real Gemini backend e2e tests.
 *
 * Uses SessionManager.createSession({ adapterName: "gemini" }) to exercise
 * the full lifecycle: spawn gemini --experimental-acp, connect backend, consumer comms.
 *
 * Gated by gemini binary availability + localhost bind check.
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
import { getGeminiPrereqState } from "./prereqs.js";
import { setupRealSession } from "./session-manager-setup.js";

const profile = getE2EProfile();
const prereqs = getGeminiPrereqState();
const canBindLocalhost = canBindLocalhostSync();
const runGemini = prereqs.ok && canBindLocalhost;
const runFullOnly = runGemini && prereqs.canRunPromptTests && profile === "real-full";

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
  // Smoke: connection + lifecycle
  // -------------------------------------------------------------------------

  it.runIf(runGemini)("createSession connects gemini backend", async () => {
    const { manager, sessionId } = await setupRealSession("gemini");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 45_000);
    expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
  });

  it.runIf(runGemini)("consumer gets session_init", async () => {
    const { manager, sessionId, port } = await setupRealSession("gemini");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 45_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runGemini)("deleteSession kills subprocess", async () => {
    const { manager, sessionId } = await setupRealSession("gemini");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 45_000);

    const deleted = await manager.deleteSession(sessionId);
    expect(deleted).toBe(true);
    expect(manager.launcher.getSession(sessionId)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Smoke: concurrent sessions
  // -------------------------------------------------------------------------

  it.runIf(runGemini)("two independent gemini sessions connect concurrently", async () => {
    const ctx1 = await setupRealSession("gemini");
    const ctx2 = await setupRealSession("gemini");
    activeManagers.push(ctx1.manager, ctx2.manager);

    await Promise.all([
      waitForBackendConnectedOrExit(ctx1.manager, ctx1.sessionId, 45_000),
      waitForBackendConnectedOrExit(ctx2.manager, ctx2.sessionId, 45_000),
    ]);

    expect(ctx1.manager.bridge.isBackendConnected(ctx1.sessionId)).toBe(true);
    expect(ctx2.manager.bridge.isBackendConnected(ctx2.sessionId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Smoke: consumer disconnect/reconnect resilience
  // -------------------------------------------------------------------------

  it.runIf(runGemini)(
    "backend stays connected across consumer disconnect and reconnect",
    async () => {
      const { manager, sessionId, port } = await setupRealSession("gemini");
      activeManagers.push(manager);
      await waitForBackendConnectedOrExit(manager, sessionId, 45_000);

      // Connect and disconnect first consumer
      const consumer1 = await connectConsumerAndWaitReady(port, sessionId, {
        requireCliConnected: false,
      });
      await closeWebSockets(consumer1);

      // Allow bridge to process close handlers
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);

      // Reconnect with a second consumer
      const consumer2 = await connectConsumerAndWaitReady(port, sessionId, {
        requireCliConnected: false,
      });
      try {
        expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
      } finally {
        await closeWebSockets(consumer2);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Smoke: consumer attaching immediately after launch
  // -------------------------------------------------------------------------

  it.runIf(runGemini)(
    "consumer attaching immediately after launch still reaches ready state",
    async () => {
      const { manager, sessionId, port } = await setupRealSession("gemini");
      activeManagers.push(manager);

      // Attach consumer immediately — don't wait for backend to connect first
      const consumer = await connectConsumerAndWaitReady(port, sessionId, {
        requireCliConnected: false,
      });
      try {
        await waitForBackendConnectedOrExit(manager, sessionId, 45_000);
        expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
      } finally {
        await closeWebSockets(consumer);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Smoke: sequential create/delete stress
  // -------------------------------------------------------------------------

  it.runIf(runGemini)("stress: sequential gemini sessions connect and teardown (x3)", async () => {
    for (let i = 0; i < 3; i++) {
      const { manager, sessionId } = await setupRealSession("gemini");
      activeManagers.push(manager);
      await waitForBackendConnectedOrExit(manager, sessionId, 45_000);
      const removed = await manager.deleteSession(sessionId);
      expect(removed).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Smoke: session appears in launcher listing
  // -------------------------------------------------------------------------

  it.runIf(runGemini)("created session appears in launcher session list", async () => {
    const { manager, sessionId } = await setupRealSession("gemini");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 45_000);

    const info = manager.launcher.getSession(sessionId);
    expect(info).toBeDefined();
    expect(info?.state).toBe("connected");
    expect(info?.adapterName).toBe("gemini");
  });

  // -------------------------------------------------------------------------
  // Full: user message + streamed response
  // -------------------------------------------------------------------------

  it.runIf(runFullOnly)("user_message gets a streamed response from real gemini", async () => {
    const { manager, sessionId, port } = await setupRealSession("gemini");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 45_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY GEMINI_E2E_OK and nothing else.",
        }),
      );

      const assistant = await waitForMessage(
        consumer,
        (msg) => {
          if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
          return (msg as { type?: string }).type === "assistant";
        },
        90_000,
      );
      expect((assistant as { type: string }).type).toBe("assistant");
    } finally {
      await closeWebSockets(consumer);
    }
  });

  // -------------------------------------------------------------------------
  // Full: cancel mid-turn
  // -------------------------------------------------------------------------

  it.runIf(runFullOnly)("cancel mid-turn does not crash", async () => {
    const { manager, sessionId, port } = await setupRealSession("gemini");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 45_000);

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

      // Wait briefly for the turn to start
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Send interrupt
      consumer.send(JSON.stringify({ type: "interrupt" }));

      // Give time for the cancel to process
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Backend should still be functional (not crashed)
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  // -------------------------------------------------------------------------
  // Full: multi-turn conversation
  // -------------------------------------------------------------------------

  it.runIf(runFullOnly)("same real gemini session supports a second turn", async () => {
    const { manager, sessionId, port } = await setupRealSession("gemini");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 45_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      // Turn 1
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY GEMINI_TURN_ONE and nothing else.",
        }),
      );
      await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "GEMINI_TURN_ONE"),
        90_000,
      );
      await waitForMessageType(consumer, "result", 90_000);

      // Turn 2
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY GEMINI_TURN_TWO and nothing else.",
        }),
      );
      const turnTwo = await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "GEMINI_TURN_TWO"),
        90_000,
      );
      expect(assistantTextContains(turnTwo, "GEMINI_TURN_TWO")).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  // -------------------------------------------------------------------------
  // Full: broadcast to two consumers
  // -------------------------------------------------------------------------

  it.runIf(runFullOnly)("broadcast live assistant/result to two consumers", async () => {
    const { manager, sessionId, port } = await setupRealSession("gemini");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 45_000);

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
          content: "Reply with EXACTLY GEMINI_BROADCAST_OK and nothing else.",
        }),
      );

      const [assistant1, assistant2] = await Promise.all([
        waitForMessage(
          consumer1,
          (msg) => assistantTextContains(msg, "GEMINI_BROADCAST_OK"),
          90_000,
        ),
        waitForMessage(
          consumer2,
          (msg) => assistantTextContains(msg, "GEMINI_BROADCAST_OK"),
          90_000,
        ),
      ]);
      expect(assistantTextContains(assistant1, "GEMINI_BROADCAST_OK")).toBe(true);
      expect(assistantTextContains(assistant2, "GEMINI_BROADCAST_OK")).toBe(true);

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

  // -------------------------------------------------------------------------
  // Full: stream events arrive before result
  // -------------------------------------------------------------------------

  it.runIf(runFullOnly)("stream events are received before the final result", async () => {
    const { manager, sessionId, port } = await setupRealSession("gemini");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 45_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY GEMINI_STREAM_CHECK and nothing else.",
        }),
      );

      // Collect all messages until we see a result
      const received: Array<{ type: string }> = [];
      await waitForMessage(
        consumer,
        (msg) => {
          if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
          const typed = msg as { type: string };
          received.push(typed);
          return typed.type === "result";
        },
        90_000,
      );

      // Verify we got at least one non-result message before the result
      const resultIdx = received.findIndex((m) => m.type === "result");
      expect(resultIdx).toBeGreaterThan(0);

      // Everything before the result should be stream_event or assistant
      const beforeResult = received.slice(0, resultIdx);
      expect(beforeResult.length).toBeGreaterThan(0);
      for (const msg of beforeResult) {
        expect(["stream_event", "assistant", "tool_progress", "tool_use_summary"]).toContain(
          msg.type,
        );
      }
    } finally {
      await closeWebSockets(consumer);
    }
  });
});
