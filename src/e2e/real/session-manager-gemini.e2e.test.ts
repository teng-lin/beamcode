/**
 * Real Gemini backend e2e tests.
 *
 * Uses SessionManager.createSession({ adapterName: "gemini" }) to exercise
 * the full lifecycle: spawn gemini-cli-a2a-server, connect backend, consumer comms.
 *
 * Gated by gemini-cli-a2a-server binary availability + localhost bind check.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { SessionManager } from "../../core/session-manager.js";
import { getE2EProfile } from "../helpers/e2e-profile.js";
import {
  canBindLocalhostSync,
  closeWebSockets,
  connectConsumerAndWaitReady,
  deleteTrace,
  dumpTraceOnFailure,
  type TestContextLike,
  waitForBackendConnectedOrExit,
  waitForMessage,
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
});
