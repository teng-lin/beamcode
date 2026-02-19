/**
 * Real Opencode backend e2e tests.
 *
 * Uses SessionManager.createSession({ adapterName: "opencode" }) to exercise
 * the full lifecycle: spawn opencode serve, connect backend, consumer comms.
 *
 * Gated by opencode binary availability + localhost bind check.
 *
 * NOTE: opencode uses a shared state directory (~/.local/share/opencode/)
 * that prevents rapid start/stop cycles, so these tests share a single
 * session manager across smoke tests.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getE2EProfile } from "../helpers/e2e-profile.js";
import {
  canBindLocalhostSync,
  closeWebSockets,
  connectConsumerAndWaitReady,
  deleteTrace,
  dumpTraceOnFailure,
  waitForBackendConnectedOrExit,
  waitForMessage,
} from "./helpers.js";
import { getOpencodePrereqState } from "./prereqs.js";
import { type RealSessionContext, setupRealSession } from "./session-manager-setup.js";

const profile = getE2EProfile();
const prereqs = getOpencodePrereqState();
const canBindLocalhost = canBindLocalhostSync();
const runOpencode = prereqs.ok && canBindLocalhost;
const runFullOnly = runOpencode && prereqs.canRunPromptTests && profile === "real-full";

describe("E2E Real Opencode SessionManager", () => {
  let shared: RealSessionContext | undefined;

  beforeAll(async () => {
    if (!runOpencode) return;
    shared = await setupRealSession("opencode");
    await waitForBackendConnectedOrExit(shared.manager, shared.sessionId, 30_000);
  }, 45_000);

  afterEach((context) => {
    if (shared) {
      dumpTraceOnFailure(context, [shared.manager], "opencode-e2e-debug");
    }
  });

  afterAll(async () => {
    if (shared) {
      await shared.manager.stop();
      deleteTrace(shared.manager);
      shared = undefined;
    }
  });

  it.runIf(runOpencode)("createSession connects opencode backend via HTTP+SSE", () => {
    expect(shared).toBeDefined();
    expect(shared!.manager.bridge.isBackendConnected(shared!.sessionId)).toBe(true);
  });

  it.runIf(runOpencode)("consumer gets session_init", async () => {
    expect(shared).toBeDefined();
    const { sessionId, port } = shared!;

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      expect(shared!.manager.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFullOnly)("user_message gets a streamed response from real opencode", async () => {
    expect(shared).toBeDefined();
    const { sessionId, port } = shared!;

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      // Attach both listeners BEFORE sending so neither message is missed
      // in the gap between one listener resolving and the next being attached.
      const assistantPromise = waitForMessage(
        consumer,
        (msg) => {
          if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
          return (msg as { type?: string }).type === "assistant";
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
          content: "Reply with EXACTLY OPENCODE_E2E_OK and nothing else.",
        }),
      );

      const assistant = await assistantPromise;
      expect((assistant as { type: string }).type).toBe("assistant");

      // Wait for the turn to fully complete so the session is idle
      // for subsequent tests.
      await resultPromise;
    } finally {
      await closeWebSockets(consumer);
    }
  });

  // NOTE: Multi-turn and multi-consumer broadcast tests are deferred until
  // the opencode adapter's SSE reconnection is fixed. The SSE /event stream
  // closes after the first prompt's events and reconnects receive empty
  // responses (1ms duration), causing all subsequent prompt events to be lost.

  it.runIf(runFullOnly)("interrupting mid-turn does not crash the backend", async () => {
    expect(shared).toBeDefined();
    const { sessionId, port, manager } = shared!;

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

  it.runIf(runOpencode)("consumer reconnects without restarting the CLI", async () => {
    expect(shared).toBeDefined();
    const { sessionId, port, manager } = shared!;

    const first = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    await closeWebSockets(first);

    // Brief pause for the bridge to process the disconnect.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);

    const second = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(second);
    }
  });

  it.runIf(runOpencode)("deleteSession cleans up", async () => {
    expect(shared).toBeDefined();
    const { manager, sessionId } = shared!;

    const deleted = await manager.deleteSession(sessionId);
    expect(deleted).toBe(true);
    expect(manager.launcher.getSession(sessionId)).toBeUndefined();
  });
});
