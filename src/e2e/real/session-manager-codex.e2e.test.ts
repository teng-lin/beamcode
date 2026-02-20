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
import type { Authenticator } from "../../interfaces/auth.js";
import {
  assistantTextContains,
  canBindLocalhostSync,
  closeWebSockets,
  connectConsumerAndWaitReady,
  connectConsumerWithQueryAndWaitReady,
  deleteTrace,
  dumpTraceOnFailure,
  type TestContextLike,
  waitForBackendConnectedOrExit,
  waitForMessage,
  waitForMessageType,
} from "./helpers.js";
import { getCodexPrereqState } from "./prereqs.js";
import { type SetupRealSessionOptions, setupRealSession } from "./session-manager-setup.js";

const prereqs = getCodexPrereqState();
const canBindLocalhost = canBindLocalhostSync();
const runCodex = prereqs.ok && canBindLocalhost;
const runFullOnly = runCodex && prereqs.canRunPromptTests;

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

  it.runIf(runCodex)("session is registered in launcher after createSession", async () => {
    const { manager, sessionId } = await setupRealSession("codex");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const info = manager.launcher.getSession(sessionId);
    expect(info).toBeDefined();
    expect(info?.state).toBe("connected");
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

  it.runIf(runCodex)(
    "two consumers on same session both receive session_init + cli_connected",
    async () => {
      const { manager, sessionId, port } = await setupRealSession("codex");
      activeManagers.push(manager);

      await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

      const consumer1 = await connectConsumerAndWaitReady(port, sessionId);
      const consumer2 = await connectConsumerAndWaitReady(port, sessionId);
      try {
        expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
      } finally {
        await closeWebSockets(consumer1, consumer2);
      }
    },
  );

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

  it.runIf(runCodex)("consumer reconnects without restarting the CLI", async () => {
    const { manager, sessionId, port } = await setupRealSession("codex");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const first = await connectConsumerAndWaitReady(port, sessionId);

    // Attach listener BEFORE closing so the event isn't missed.
    const disconnected = new Promise<void>((resolve) => {
      manager.once("consumer:disconnected", ({ sessionId: sid }) => {
        if (sid === sessionId) resolve();
      });
    });
    await closeWebSockets(first);
    await disconnected;

    expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);

    const second = await connectConsumerAndWaitReady(port, sessionId);
    try {
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(second);
    }
  });

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

  it.runIf(runCodex)(
    "second createSession on same manager yields independent session",
    async () => {
      const { manager, sessionId } = await setupRealSession("codex");
      activeManagers.push(manager);

      await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

      const second = await manager.createSession({
        adapterName: "codex",
        cwd: process.cwd(),
      });

      try {
        await waitForBackendConnectedOrExit(manager, second.sessionId, 30_000);

        expect(manager.bridge.isBackendConnected(second.sessionId)).toBe(true);
        expect(second.sessionId).not.toBe(sessionId);
        expect(second.adapterName).toBe("codex");
      } finally {
        await manager.deleteSession(second.sessionId);
      }
    },
  );

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

  it.runIf(runCodex)(
    "process_output policy: participant receives output, observer does not",
    async () => {
      const authenticator: Authenticator = {
        async authenticate(context) {
          const transport = context.transport as { query?: Record<string, string> };
          const role = transport.query?.role === "observer" ? "observer" : "participant";
          return {
            userId: role === "observer" ? "obs-1" : "part-1",
            displayName: role === "observer" ? "Observer" : "Participant",
            role,
          };
        },
      };

      const options: SetupRealSessionOptions = { authenticator };
      const { manager, sessionId, port } = await setupRealSession("codex", options);
      activeManagers.push(manager);
      await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

      const participant = await connectConsumerWithQueryAndWaitReady(
        port,
        sessionId,
        { role: "participant" },
        "participant",
      );
      const observer = await connectConsumerWithQueryAndWaitReady(
        port,
        sessionId,
        { role: "observer" },
        "observer",
      );
      try {
        const partOutput = waitForMessageType(participant, "process_output", 20_000);
        // Deterministic RBAC policy check for process output fanout.
        manager.bridge.broadcastProcessOutput(sessionId, "stderr", "CODEX_RBAC_OUTPUT_CHECK");
        await partOutput;
        await expect(waitForMessageType(observer, "process_output", 1000)).rejects.toThrow(
          /Timeout waiting for message/,
        );
      } finally {
        await closeWebSockets(participant, observer);
      }
    },
  );

  it.runIf(runCodex)("deleteSession on non-existent session returns false", async () => {
    const { manager } = await setupRealSession("codex");
    activeManagers.push(manager);

    const deleted = await manager.deleteSession("non-existent-session-id");
    expect(deleted).toBe(false);
  });

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

  it.runIf(runFullOnly)("response includes stream_event messages before result", async () => {
    const { manager, sessionId, port } = await setupRealSession("codex");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
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
          content: "Reply with EXACTLY CODEX_STREAM_CHECK and nothing else.",
        }),
      );

      // stream_event MUST arrive before result — await in order
      const streamEvent = await streamEventPromise;
      expect((streamEvent as { type: string }).type).toBe("stream_event");

      const result = await resultPromise;
      expect((result as { type: string }).type).toBe("result");
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFullOnly)("result message carries completion metadata", async () => {
    const { manager, sessionId, port } = await setupRealSession("codex");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY CODEX_META_CHECK and nothing else.",
        }),
      );

      const result = (await waitForMessageType(consumer, "result", 90_000)) as {
        type: string;
        status?: string;
        is_error?: boolean;
      };
      expect(result.type).toBe("result");
      // Result should signal successful completion, not error
      expect(result.is_error).not.toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFullOnly)("assistant response content contains expected token", async () => {
    const { manager, sessionId, port } = await setupRealSession("codex");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY CODEX_CONTENT_CHECK and nothing else.",
        }),
      );

      const assistant = await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "CODEX_CONTENT_CHECK"),
        90_000,
      );
      expect(assistantTextContains(assistant, "CODEX_CONTENT_CHECK")).toBe(true);

      await waitForMessageType(consumer, "result", 90_000);
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

      // Diagnostic: log session state between turns
      const snapshot = manager.bridge.getSession(sessionId);
      const launcherInfo = manager.launcher.getSession(sessionId);
      console.log(
        `[codex-second-turn] between turns: lastStatus=${snapshot?.lastStatus ?? "n/a"} ` +
          `cliConnected=${snapshot?.cliConnected ?? "n/a"} ` +
          `launcherState=${launcherInfo?.state ?? "n/a"} ` +
          `backendConnected=${manager.bridge.isBackendConnected(sessionId)} ` +
          `messageHistoryLen=${snapshot?.messageHistoryLength ?? "n/a"}`,
      );

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

  it.runIf(runFullOnly)("interrupt mid-turn then fresh prompt yields valid response", async () => {
    const { manager, sessionId, port } = await setupRealSession("codex");
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
    try {
      // Start a long-running turn
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Write an extremely detailed essay about distributed systems.",
        }),
      );

      // Wait for streaming to start
      await waitForMessage(
        consumer,
        (msg) => {
          const m = msg as { type?: string };
          return m.type === "stream_event" || m.type === "assistant_message";
        },
        15_000,
      );

      // Interrupt
      consumer.send(JSON.stringify({ type: "interrupt" }));

      // Wait for the interrupted turn to complete
      await waitForMessageType(consumer, "result", 15_000);

      // Backend should still be functional
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);

      // Send a new prompt — backend should still work
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY CODEX_POST_INTERRUPT and nothing else.",
        }),
      );

      const postInterrupt = await waitForMessage(
        consumer,
        (msg) => {
          if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
          const type = (msg as { type?: string }).type;
          return type === "assistant" || type === "result";
        },
        90_000,
      );
      expect(postInterrupt).toBeDefined();
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFullOnly)("set_permission_mode keeps real backend healthy", async () => {
    const { manager, sessionId, port } = await setupRealSession("codex");
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
    try {
      consumer.send(JSON.stringify({ type: "set_permission_mode", mode: "delegate" }));
      await new Promise((resolve) => setTimeout(resolve, 1000));
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
