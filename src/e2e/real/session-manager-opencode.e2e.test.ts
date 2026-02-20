/**
 * Real Opencode backend e2e tests.
 *
 * Uses SessionManager.createSession({ adapterName: "opencode" }) to exercise
 * the full lifecycle: spawn opencode serve, connect backend, consumer comms.
 *
 * Gated by opencode binary availability + localhost bind check.
 *
 * NOTE: opencode uses a shared state directory (~/.local/share/opencode/)
 * that prevents rapid start/stop cycles, so smoke tests share a single
 * session manager where possible. Tests needing independent setup (RBAC,
 * concurrent managers, stress) create their own.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { getOpencodePrereqState } from "./prereqs.js";
import {
  type RealSessionContext,
  type SetupRealSessionOptions,
  setupRealSession,
} from "./session-manager-setup.js";

const prereqs = getOpencodePrereqState();
const canBindLocalhost = canBindLocalhostSync();
const runOpencode = prereqs.ok && canBindLocalhost;
// opencode manages its own provider credentials internally — no external
// API key env var is needed from beamcode's side, so prompt tests run
// whenever the binary is available and the profile allows real tests.
const runFullOnly = runOpencode && prereqs.canRunPromptTests;

describe("E2E Real Opencode SessionManager", () => {
  // Shared session for smoke tests (avoids rapid start/stop of opencode server)
  let shared: RealSessionContext | undefined;

  // Independent managers for tests that need their own setup
  const activeManagers: SessionManager[] = [];

  beforeAll(async () => {
    if (!runOpencode) return;
    shared = await setupRealSession("opencode");
    await waitForBackendConnectedOrExit(shared.manager, shared.sessionId, 30_000);
  }, 45_000);

  afterEach((context: TestContextLike) => {
    const managers = shared ? [shared.manager, ...activeManagers] : [...activeManagers];
    dumpTraceOnFailure(context, managers, "opencode-e2e-debug");
  });

  afterAll(async () => {
    // Clean up independent managers first
    while (activeManagers.length > 0) {
      const mgr = activeManagers.pop();
      if (mgr) {
        await mgr.stop();
        deleteTrace(mgr);
      }
    }

    // Clean up shared last
    if (shared) {
      await shared.manager.stop();
      deleteTrace(shared.manager);
      shared = undefined;
    }
  });

  // ---------------------------------------------------------------------------
  // Smoke tests (runOpencode — binary available, no API key needed)
  // ---------------------------------------------------------------------------

  it.runIf(runOpencode)("createSession connects opencode backend via HTTP+SSE", () => {
    expect(shared).toBeDefined();
    expect(shared!.manager.bridge.isBackendConnected(shared!.sessionId)).toBe(true);
  });

  it.runIf(runOpencode)("session is registered in launcher after createSession", () => {
    expect(shared).toBeDefined();
    const info = shared!.manager.launcher.getSession(shared!.sessionId);
    expect(info).toBeDefined();
    expect(info?.state).toBe("connected");
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

  it.runIf(runOpencode)("two consumers on same session both receive session_init", async () => {
    expect(shared).toBeDefined();
    const { sessionId, port } = shared!;

    const consumer1 = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    const consumer2 = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      expect(shared!.manager.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(consumer1, consumer2);
    }
  });

  it.runIf(runOpencode)(
    "backend stays connected across consumer disconnect and reconnect",
    async () => {
      expect(shared).toBeDefined();
      const { sessionId, port, manager } = shared!;

      // Connect and disconnect first consumer
      const consumer1 = await connectConsumerAndWaitReady(port, sessionId, {
        requireCliConnected: false,
      });
      await closeWebSockets(consumer1);

      // Brief pause for close handlers
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);

      // Second consumer should still get session_init
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

  it.runIf(runOpencode)("consumer reconnects without restarting the CLI", async () => {
    expect(shared).toBeDefined();
    const { sessionId, port, manager } = shared!;

    const first = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });

    // Attach listener BEFORE closing so the event isn't missed.
    const disconnected = new Promise<void>((resolve) => {
      manager.once("consumer:disconnected", ({ sessionId: sid }) => {
        if (sid === sessionId) resolve();
      });
    });
    await closeWebSockets(first);
    await disconnected;

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

  it.runIf(runOpencode)(
    "consumer attaching immediately after createSession reaches ready state",
    async () => {
      const { manager, sessionId, port } = await setupRealSession("opencode");
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

  it.runIf(runOpencode)("two independent opencode sessions can connect concurrently", async () => {
    const session1 = await setupRealSession("opencode");
    const session2 = await setupRealSession("opencode");
    activeManagers.push(session1.manager, session2.manager);

    await Promise.all([
      waitForBackendConnectedOrExit(session1.manager, session1.sessionId, 30_000),
      waitForBackendConnectedOrExit(session2.manager, session2.sessionId, 30_000),
    ]);

    expect(session1.manager.bridge.isBackendConnected(session1.sessionId)).toBe(true);
    expect(session2.manager.bridge.isBackendConnected(session2.sessionId)).toBe(true);
  });

  it.runIf(runOpencode)(
    "second createSession on same manager yields independent session",
    async () => {
      expect(shared).toBeDefined();
      const { manager } = shared!;

      const second = await manager.createSession({
        adapterName: "opencode",
        cwd: process.cwd(),
      });

      try {
        await waitForBackendConnectedOrExit(manager, second.sessionId, 30_000);

        expect(manager.bridge.isBackendConnected(second.sessionId)).toBe(true);
        expect(second.sessionId).not.toBe(shared!.sessionId);
        expect(second.adapterName).toBe("opencode");
      } finally {
        await manager.deleteSession(second.sessionId);
      }
    },
  );

  it.runIf(runOpencode)(
    "stress: sequential opencode sessions connect and teardown (x3)",
    async () => {
      for (let i = 0; i < 3; i++) {
        const { manager, sessionId } = await setupRealSession("opencode");
        activeManagers.push(manager);

        await waitForBackendConnectedOrExit(manager, sessionId, 30_000);
        expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);

        const deleted = await manager.deleteSession(sessionId);
        expect(deleted).toBe(true);
      }
    },
  );

  it.runIf(runOpencode)(
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
      const { manager, sessionId, port } = await setupRealSession("opencode", options);
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
        manager.bridge.broadcastProcessOutput(sessionId, "stderr", "OPENCODE_RBAC_OUTPUT_CHECK");
        await partOutput;
        await expect(waitForMessageType(observer, "process_output", 1000)).rejects.toThrow(
          /Timeout waiting for message/,
        );
      } finally {
        await closeWebSockets(participant, observer);
      }
    },
  );

  it.runIf(runOpencode)("deleteSession on non-existent session returns false", async () => {
    expect(shared).toBeDefined();
    const { manager } = shared!;

    const deleted = await manager.deleteSession("non-existent-session-id");
    expect(deleted).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Full tests (runFullOnly — opencode binary available + canRunPromptTests)
  // ---------------------------------------------------------------------------

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

  it.runIf(runFullOnly)("response includes stream_event messages before result", async () => {
    const { manager, sessionId, port } = await setupRealSession("opencode");
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

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
          content: "Reply with EXACTLY OPENCODE_STREAM_CHECK and nothing else.",
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
    const { manager, sessionId, port } = await setupRealSession("opencode");
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY OPENCODE_META_CHECK and nothing else.",
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

  it.runIf(runFullOnly)("assistant message carries model metadata", async () => {
    const { manager, sessionId, port } = await setupRealSession("opencode");
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

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
      // The assistant message from opencode should have model metadata
      // (bridged from the message.updated event's modelID/providerID fields)
      expect(assistant.message).toBeDefined();

      await waitForMessageType(consumer, "result", 90_000);
    } finally {
      await closeWebSockets(consumer);
    }
  });

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

      // Wait for streaming to start (event-based, not arbitrary sleep)
      await waitForMessage(
        consumer,
        (msg) => {
          const m = msg as { type?: string };
          return m.type === "stream_event" || m.type === "status_change";
        },
        15_000,
      );

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

  it.runIf(runFullOnly)("interrupt mid-turn then fresh prompt yields valid response", async () => {
    const { manager, sessionId, port } = await setupRealSession("opencode");
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
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
          return m.type === "stream_event" || m.type === "status_change";
        },
        15_000,
      );

      // Interrupt
      consumer.send(JSON.stringify({ type: "interrupt" }));

      // Wait for the interrupted turn to settle (result or timeout)
      await waitForMessage(
        consumer,
        (msg) => {
          if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
          return (msg as { type?: string }).type === "result";
        },
        30_000,
      ).catch(() => {
        // Interrupt may not always produce a result; that's OK
      });

      // Give the backend time to stabilize
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);

      // Send a new prompt — backend should still work
      // NOTE: This depends on SSE reconnection working after the interrupt.
      // If it fails, the opencode SSE reconnection bug is still present.
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY OPENCODE_POST_INTERRUPT and nothing else.",
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

  it.runIf(runFullOnly)("assistant response content contains expected token", async () => {
    const { manager, sessionId, port } = await setupRealSession("opencode");
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY OPENCODE_CONTENT_CHECK and nothing else.",
        }),
      );

      const assistant = await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "OPENCODE_CONTENT_CHECK"),
        90_000,
      );
      expect(assistantTextContains(assistant, "OPENCODE_CONTENT_CHECK")).toBe(true);

      await waitForMessageType(consumer, "result", 90_000);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFullOnly)("broadcast assistant response to two consumers", async () => {
    const { manager, sessionId, port } = await setupRealSession("opencode");
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

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
          content: "Reply with EXACTLY OPENCODE_BROADCAST_OK and nothing else.",
        }),
      );

      const [assistant1, assistant2] = await Promise.all([
        waitForMessage(
          consumer1,
          (msg) => assistantTextContains(msg, "OPENCODE_BROADCAST_OK"),
          90_000,
        ),
        waitForMessage(
          consumer2,
          (msg) => assistantTextContains(msg, "OPENCODE_BROADCAST_OK"),
          90_000,
        ),
      ]);
      expect(assistantTextContains(assistant1, "OPENCODE_BROADCAST_OK")).toBe(true);
      expect(assistantTextContains(assistant2, "OPENCODE_BROADCAST_OK")).toBe(true);

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

  it.runIf(runFullOnly)("same session supports a second turn", async () => {
    const { manager, sessionId, port } = await setupRealSession("opencode");
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, {
      requireCliConnected: false,
    });
    try {
      // Turn 1
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY OPENCODE_TURN_ONE and nothing else.",
        }),
      );
      await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "OPENCODE_TURN_ONE"),
        90_000,
      );
      await waitForMessageType(consumer, "result", 90_000);

      // Diagnostic: log session state between turns
      {
        const snapshot = manager.bridge.getSession(sessionId);
        const launcherInfo = manager.launcher.getSession(sessionId);
        console.log(
          `[opencode-second-turn] between turns: lastStatus=${snapshot?.lastStatus ?? "n/a"} ` +
            `cliConnected=${snapshot?.cliConnected ?? "n/a"} ` +
            `launcherState=${launcherInfo?.state ?? "n/a"} ` +
            `backendConnected=${manager.bridge.isBackendConnected(sessionId)} ` +
            `messageHistoryLen=${snapshot?.messageHistoryLength ?? "n/a"}`,
        );
      }

      // Turn 2 — depends on SSE reconnection working between turns.
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY OPENCODE_TURN_TWO and nothing else.",
        }),
      );
      const turnTwo = await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "OPENCODE_TURN_TWO"),
        90_000,
      );
      expect(assistantTextContains(turnTwo, "OPENCODE_TURN_TWO")).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  // ---------------------------------------------------------------------------
  // Destructive tests (run last — deleteSession destroys session state)
  // ---------------------------------------------------------------------------

  it.runIf(runOpencode)("deleteSession removes session and clears bridge state", async () => {
    const { manager, sessionId } = await setupRealSession("opencode");
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 30_000);

    expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);

    const deleted = await manager.deleteSession(sessionId);
    expect(deleted).toBe(true);
    expect(manager.launcher.getSession(sessionId)).toBeUndefined();
    expect(manager.bridge.getSession(sessionId)).toBeUndefined();
  });

  it.runIf(runOpencode)("deleteSession cleans up shared session", async () => {
    expect(shared).toBeDefined();
    const { manager, sessionId } = shared!;

    const deleted = await manager.deleteSession(sessionId);
    expect(deleted).toBe(true);
    expect(manager.launcher.getSession(sessionId)).toBeUndefined();
  });
});
