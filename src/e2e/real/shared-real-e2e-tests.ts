/**
 * Shared e2e test factory for real backend adapters.
 *
 * Registers structurally identical smoke and full tests parameterized by
 * adapter name, token prefix, and connection options.  Each adapter file
 * calls registerSharedSmokeTests() + registerSharedFullTests() inside its
 * own describe(), then appends adapter-specific unique tests.
 */

import { expect, it } from "vitest";
import type { CliAdapterName } from "../../adapters/create-adapter.js";
import type { SessionManager } from "../../core/session-manager.js";
import type { Authenticator } from "../../interfaces/auth.js";
import {
  assistantTextContains,
  closeWebSockets,
  connectConsumerAndWaitReady,
  connectConsumerWithQueryAndWaitReady,
  waitForBackendConnectedOrExit,
  waitForMessage,
  waitForMessageType,
} from "./helpers.js";
import type { RealSessionContext, SetupRealSessionOptions } from "./session-manager-setup.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SharedE2eTestConfig {
  adapterName: CliAdapterName;
  tokenPrefix: string;
  setup: (opts?: SetupRealSessionOptions) => Promise<RealSessionContext>;
  runSmoke: boolean;
  runFull: boolean;
  activeManagers: SessionManager[];
  connectTimeoutMs?: number;
  requireCliConnected?: boolean;
}

// ---------------------------------------------------------------------------
// Smoke tests (binary available, no API key needed)
// ---------------------------------------------------------------------------

export function registerSharedSmokeTests(config: SharedE2eTestConfig): void {
  const {
    adapterName,
    tokenPrefix,
    setup,
    runSmoke,
    activeManagers,
    connectTimeoutMs = 30_000,
    requireCliConnected = true,
  } = config;

  const consumerOpts = requireCliConnected ? undefined : { requireCliConnected: false };

  it.runIf(runSmoke)(`createSession connects ${adapterName} backend`, async () => {
    const { manager, sessionId } = await setup();
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);
    expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
  });

  it.runIf(runSmoke)("session is registered in launcher after createSession", async () => {
    const { manager, sessionId } = await setup();
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

    const info = manager.launcher.getSession(sessionId);
    expect(info).toBeDefined();
    expect(info?.state).toBe("connected");
  });

  it.runIf(runSmoke)("consumer gets session_init + cli_connected", async () => {
    const { manager, sessionId, port } = await setup();
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
    try {
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runSmoke)("two consumers on same session both receive session_init", async () => {
    const { manager, sessionId, port } = await setup();
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

    const consumer1 = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
    const consumer2 = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
    try {
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(consumer1, consumer2);
    }
  });

  it.runIf(runSmoke)(
    "backend stays connected across consumer disconnect and reconnect",
    async () => {
      const { manager, sessionId, port } = await setup();
      activeManagers.push(manager);

      await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

      const consumer1 = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
      await closeWebSockets(consumer1);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);

      const consumer2 = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
      try {
        expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
      } finally {
        await closeWebSockets(consumer2);
      }
    },
  );

  it.runIf(runSmoke)("consumer reconnects without restarting the backend", async () => {
    const { manager, sessionId, port } = await setup();
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

    const first = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);

    const disconnected = new Promise<void>((resolve) => {
      manager.once("consumer:disconnected", ({ sessionId: sid }) => {
        if (sid === sessionId) resolve();
      });
    });
    await closeWebSockets(first);
    await disconnected;

    expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);

    const second = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
    try {
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(second);
    }
  });

  it.runIf(runSmoke)("deleteSession removes a live connected session", async () => {
    const { manager, sessionId } = await setup();
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

    expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
    const deleted = await manager.deleteSession(sessionId);
    expect(deleted).toBe(true);
    expect(manager.launcher.getSession(sessionId)).toBeUndefined();
    expect(manager.bridge.getSession(sessionId)).toBeUndefined();
  });

  it.runIf(runSmoke)(
    "consumer attaching immediately after createSession reaches ready state",
    async () => {
      const { manager, sessionId, port } = await setup();
      activeManagers.push(manager);

      const consumer = await connectConsumerAndWaitReady(port, sessionId, {
        requireCliConnected: false,
      });
      try {
        await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);
        expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
      } finally {
        await closeWebSockets(consumer);
      }
    },
  );

  it.runIf(runSmoke)(
    `two independent ${adapterName} sessions can connect concurrently`,
    async () => {
      const session1 = await setup();
      const session2 = await setup();
      activeManagers.push(session1.manager, session2.manager);

      await Promise.all([
        waitForBackendConnectedOrExit(session1.manager, session1.sessionId, connectTimeoutMs),
        waitForBackendConnectedOrExit(session2.manager, session2.sessionId, connectTimeoutMs),
      ]);

      expect(session1.manager.bridge.isBackendConnected(session1.sessionId)).toBe(true);
      expect(session2.manager.bridge.isBackendConnected(session2.sessionId)).toBe(true);
    },
  );

  it.runIf(runSmoke)(
    "second createSession on same manager yields independent session",
    async () => {
      const { manager, sessionId } = await setup();
      activeManagers.push(manager);

      await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

      const second = await manager.createSession({
        adapterName,
        cwd: process.cwd(),
      });

      try {
        await waitForBackendConnectedOrExit(manager, second.sessionId, connectTimeoutMs);

        expect(manager.bridge.isBackendConnected(second.sessionId)).toBe(true);
        expect(second.sessionId).not.toBe(sessionId);
        expect(second.adapterName).toBe(adapterName);
      } finally {
        await manager.deleteSession(second.sessionId);
      }
    },
  );

  it.runIf(runSmoke)(
    `stress: sequential ${adapterName} sessions connect and teardown (x3)`,
    async () => {
      for (let i = 0; i < 3; i++) {
        const { manager, sessionId } = await setup();
        activeManagers.push(manager);

        await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);
        expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);

        const deleted = await manager.deleteSession(sessionId);
        expect(deleted).toBe(true);
      }
    },
  );

  it.runIf(runSmoke)(
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

      const { manager, sessionId, port } = await setup({ authenticator });
      activeManagers.push(manager);
      await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

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
        manager.bridge.broadcastProcessOutput(
          sessionId,
          "stderr",
          `${tokenPrefix}_RBAC_OUTPUT_CHECK`,
        );
        await partOutput;
        await expect(waitForMessageType(observer, "process_output", 1000)).rejects.toThrow(
          /Timeout waiting for message/,
        );
      } finally {
        await closeWebSockets(participant, observer);
      }
    },
  );

  it.runIf(runSmoke)("deleteSession on non-existent session returns false", async () => {
    const { manager } = await setup();
    activeManagers.push(manager);

    const deleted = await manager.deleteSession("non-existent-session-id");
    expect(deleted).toBe(false);
  });
}

// ---------------------------------------------------------------------------
// Full tests (require API key + real-full profile)
// ---------------------------------------------------------------------------

export function registerSharedFullTests(config: SharedE2eTestConfig): void {
  const {
    adapterName,
    tokenPrefix,
    setup,
    runFull,
    activeManagers,
    connectTimeoutMs = 30_000,
    requireCliConnected = true,
  } = config;

  const consumerOpts = requireCliConnected ? undefined : { requireCliConnected: false };

  it.runIf(runFull)(`user_message gets an assistant reply from real ${adapterName}`, async () => {
    const { manager, sessionId, port } = await setup();
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: `Reply with EXACTLY ${tokenPrefix}_E2E_OK and nothing else.`,
        }),
      );

      const assistant = await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, `${tokenPrefix}_E2E_OK`),
        90_000,
      );
      expect(assistantTextContains(assistant, `${tokenPrefix}_E2E_OK`)).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFull)("response includes stream_event messages before result", async () => {
    const { manager, sessionId, port } = await setup();
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
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
          content: `Reply with EXACTLY ${tokenPrefix}_STREAM_CHECK and nothing else.`,
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

  it.runIf(runFull)("result message carries completion metadata", async () => {
    const { manager, sessionId, port } = await setup();
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: `Reply with EXACTLY ${tokenPrefix}_META_CHECK and nothing else.`,
        }),
      );

      const result = (await waitForMessageType(consumer, "result", 90_000)) as {
        type: string;
        status?: string;
        is_error?: boolean;
      };
      expect(result.type).toBe("result");
      expect(result.is_error).not.toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFull)("assistant response content contains expected token", async () => {
    const { manager, sessionId, port } = await setup();
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: `Reply with EXACTLY ${tokenPrefix}_CONTENT_CHECK and nothing else.`,
        }),
      );

      const assistant = await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, `${tokenPrefix}_CONTENT_CHECK`),
        90_000,
      );
      expect(assistantTextContains(assistant, `${tokenPrefix}_CONTENT_CHECK`)).toBe(true);

      await waitForMessageType(consumer, "result", 90_000);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFull)("same session supports a second turn", async () => {
    const { manager, sessionId, port } = await setup();
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: `Reply with EXACTLY ${tokenPrefix}_TURN_ONE and nothing else.`,
        }),
      );
      await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, `${tokenPrefix}_TURN_ONE`),
        90_000,
      );
      await waitForMessageType(consumer, "result", 90_000);

      // Diagnostic: log session state between turns
      {
        const snapshot = manager.bridge.getSession(sessionId);
        const launcherInfo = manager.launcher.getSession(sessionId);
        console.log(
          `[${adapterName}-second-turn] between turns: lastStatus=${snapshot?.lastStatus ?? "n/a"} ` +
            `cliConnected=${snapshot?.cliConnected ?? "n/a"} ` +
            `launcherState=${launcherInfo?.state ?? "n/a"} ` +
            `backendConnected=${manager.bridge.isBackendConnected(sessionId)} ` +
            `messageHistoryLen=${snapshot?.messageHistoryLength ?? "n/a"}`,
        );
      }

      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: `Reply with EXACTLY ${tokenPrefix}_TURN_TWO and nothing else.`,
        }),
      );
      const turnTwo = await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, `${tokenPrefix}_TURN_TWO`),
        90_000,
      );

      expect(assistantTextContains(turnTwo, `${tokenPrefix}_TURN_TWO`)).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFull)("broadcast assistant reply to two consumers", async () => {
    const { manager, sessionId, port } = await setup();
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

    const consumer1 = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
    const consumer2 = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
    try {
      consumer1.send(
        JSON.stringify({
          type: "user_message",
          content: `Reply with EXACTLY ${tokenPrefix}_BROADCAST_OK and nothing else.`,
        }),
      );

      const [assistant1, assistant2] = await Promise.all([
        waitForMessage(
          consumer1,
          (msg) => assistantTextContains(msg, `${tokenPrefix}_BROADCAST_OK`),
          90_000,
        ),
        waitForMessage(
          consumer2,
          (msg) => assistantTextContains(msg, `${tokenPrefix}_BROADCAST_OK`),
          90_000,
        ),
      ]);
      expect(assistantTextContains(assistant1, `${tokenPrefix}_BROADCAST_OK`)).toBe(true);
      expect(assistantTextContains(assistant2, `${tokenPrefix}_BROADCAST_OK`)).toBe(true);

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

  it.runIf(runFull)("set_permission_mode keeps real backend healthy", async () => {
    const { manager, sessionId, port } = await setup();
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
    try {
      consumer.send(JSON.stringify({ type: "set_permission_mode", mode: "delegate" }));
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFull)("interrupt mid-turn does not crash", async () => {
    const { manager, sessionId, port } = await setup();
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Write a very long essay about software engineering best practices.",
        }),
      );

      // Wait for streaming to start — accept any stream indicator type
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

      // Wait for the turn to finish; some adapters may not emit result on interrupt
      await waitForMessage(
        consumer,
        (msg) => {
          if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
          return (msg as { type?: string }).type === "result";
        },
        15_000,
      ).catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFull)("interrupt mid-turn then fresh prompt yields valid response", async () => {
    const { manager, sessionId, port } = await setup();
    activeManagers.push(manager);

    await waitForBackendConnectedOrExit(manager, sessionId, connectTimeoutMs);

    const consumer = await connectConsumerAndWaitReady(port, sessionId, consumerOpts);
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Write an extremely detailed essay about distributed systems.",
        }),
      );

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

      await waitForMessage(
        consumer,
        (msg) => {
          if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
          return (msg as { type?: string }).type === "result";
        },
        30_000,
      ).catch(() => {});

      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);

      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: `Reply with EXACTLY ${tokenPrefix}_POST_INTERRUPT and nothing else.`,
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
}
