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

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionManager } from "../../core/session-manager.js";
import { getE2EProfile } from "../helpers/e2e-profile.js";
import {
  canBindLocalhostSync,
  closeWebSockets,
  connectConsumerAndWaitReady,
  deleteTrace,
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

  it.runIf(runOpencode)("deleteSession cleans up", async () => {
    expect(shared).toBeDefined();
    const { manager, sessionId } = shared!;

    const deleted = await manager.deleteSession(sessionId);
    expect(deleted).toBe(true);
    expect(manager.launcher.getSession(sessionId)).toBeUndefined();
  });

  it.runIf(runFullOnly)("user_message gets a streamed response from real opencode", async () => {
    // Full test needs its own session (smoke tests may have deleted shared)
    const ctx = await setupRealSession("opencode");
    try {
      await waitForBackendConnectedOrExit(ctx.manager, ctx.sessionId, 30_000);

      const consumer = await connectConsumerAndWaitReady(ctx.port, ctx.sessionId, {
        requireCliConnected: false,
      });
      try {
        consumer.send(
          JSON.stringify({
            type: "user_message",
            content: "Reply with EXACTLY OPENCODE_E2E_OK and nothing else.",
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
    } finally {
      await ctx.manager.stop();
      deleteTrace(ctx.manager);
    }
  });
});
