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

  it.runIf(runFullOnly)("slash command /cost works via codex", async () => {
    const { manager, sessionId, port } = await setupRealSession("codex");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
    try {
      consumer.send(
        JSON.stringify({
          type: "slash_command",
          command: "/cost",
          request_id: "codex-cost-1",
        }),
      );

      const msg = (await waitForMessageType(consumer, "slash_command_result", 60_000)) as {
        type: string;
        request_id?: string;
      };
      expect(msg.type).toBe("slash_command_result");
      expect(msg.request_id).toBe("codex-cost-1");
    } finally {
      await closeWebSockets(consumer);
    }
  });
});
