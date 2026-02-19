import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ClaudeAdapter } from "../../adapters/claude/claude-adapter.js";
import { ClaudeLauncher } from "../../adapters/claude/claude-launcher.js";
import { FileStorage } from "../../adapters/file-storage.js";
import { MemoryStorage } from "../../adapters/memory-storage.js";
import { NodeWebSocketServer } from "../../adapters/node-ws-server.js";
import { SessionManager } from "../../core/session-manager.js";
import type { Authenticator } from "../../interfaces/auth.js";
import { getE2EProfile } from "../helpers/e2e-profile.js";
import { collectMessages, createProcessManager } from "../helpers/test-utils.js";
import {
  assistantTextContains,
  attachTrace,
  canBindLocalhostSync,
  closeWebSockets,
  connectConsumerAndWaitReady,
  connectConsumerWithQuery,
  connectConsumerWithQueryAndWaitReady,
  deleteTrace,
  dumpTraceOnFailure,
  reservePort,
  type TestContextLike,
  waitForBackendConnectedOrExit,
  waitForManagerEvent,
  waitForMessage,
  waitForMessageType,
  waitForSessionExited,
} from "./helpers.js";
import { getRealCliPrereqState } from "./prereqs.js";

async function setupRealCliSession() {
  const port = await reservePort();
  const server = new NodeWebSocketServer({ port });
  const processManager = createProcessManager();
  const config = { port, initializeTimeoutMs: 20_000 };
  const storage = new MemoryStorage();
  const manager = new SessionManager({
    config,
    storage,
    server,
    adapter: new ClaudeAdapter(),
    launcher: new ClaudeLauncher({ processManager, config, storage }),
  });
  attachTrace(manager);

  await manager.start();

  const launched = manager.launcher.launch({ cwd: process.cwd() });
  const boundPort = server.port ?? port;

  return { manager, server, sessionId: launched.sessionId, port: boundPort };
}

async function setupRealCliSessionWithOptions(options?: {
  config?: { initializeTimeoutMs?: number; reconnectGracePeriodMs?: number };
  storage?: MemoryStorage | FileStorage;
  authenticator?: Authenticator;
}): Promise<{
  manager: SessionManager;
  server: NodeWebSocketServer;
  sessionId: string;
  port: number;
}> {
  const port = await reservePort();
  const server = new NodeWebSocketServer({ port });
  const processManager = createProcessManager();
  const config = {
    port,
    initializeTimeoutMs: options?.config?.initializeTimeoutMs ?? 20_000,
    reconnectGracePeriodMs: options?.config?.reconnectGracePeriodMs ?? 10_000,
  };
  const storage = options?.storage ?? new MemoryStorage();
  const manager = new SessionManager({
    config,
    storage,
    server,
    adapter: new ClaudeAdapter(),
    authenticator: options?.authenticator,
    launcher: new ClaudeLauncher({ processManager, config, storage }),
  });
  attachTrace(manager);
  await manager.start();
  const launched = manager.launcher.launch({ cwd: process.cwd() });
  return { manager, server, sessionId: launched.sessionId, port: server.port ?? port };
}

const profile = getE2EProfile();
const prereqs = getRealCliPrereqState();
const canBindLocalhost = canBindLocalhostSync();
const runSessionManagerRealCli = prereqs.ok && canBindLocalhost;
const runFullOnly = runSessionManagerRealCli && profile === "real-full";

describe("E2E Real SDK-URL SessionManager", () => {
  const activeManagers: SessionManager[] = [];

  afterEach(async (context: TestContextLike) => {
    dumpTraceOnFailure(context, activeManagers, "claude-e2e-debug");

    while (activeManagers.length > 0) {
      const manager = activeManagers.pop();
      if (manager) {
        await manager.stop();
        deleteTrace(manager);
      }
    }
  });

  it.runIf(runSessionManagerRealCli)("launch emits process spawn and records PID", async () => {
    const { manager, sessionId } = await setupRealCliSession();
    activeManagers.push(manager);

    await waitForManagerEvent(
      manager,
      "process:spawned",
      sessionId,
      () => typeof manager.launcher.getSession(sessionId)?.pid === "number",
      15_000,
    );

    const info = manager.launcher.getSession(sessionId);
    expect(info).toBeDefined();
    expect(typeof info?.pid).toBe("number");
    expect(info?.state === "starting" || info?.state === "connected").toBe(true);
  });

  it.runIf(runSessionManagerRealCli)(
    "real CLI connects backend and session becomes connected",
    async () => {
      const { manager, sessionId } = await setupRealCliSession();
      activeManagers.push(manager);

      await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
      expect(manager.launcher.getSession(sessionId)?.state).toBe("connected");
    },
  );

  it.runIf(runSessionManagerRealCli)(
    "consumer gets base session_init after real backend connection",
    async () => {
      const { manager, sessionId, port } = await setupRealCliSession();
      activeManagers.push(manager);

      await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

      const consumer = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}`);
      const initialMessagesPromise = collectMessages(consumer, 3, 10_000);
      try {
        await new Promise<void>((resolve, reject) => {
          consumer.once("open", () => resolve());
          consumer.once("error", (err) => reject(err));
        });
        const initialMessages = await initialMessagesPromise;
        const types = initialMessages
          .map((m) => {
            try {
              return (JSON.parse(m) as { type?: string }).type;
            } catch {
              return undefined;
            }
          })
          .filter((t): t is string => typeof t === "string");
        expect(types).toContain("session_init");
      } finally {
        await closeWebSockets(consumer);
      }
    },
  );

  it.runIf(runSessionManagerRealCli)(
    "consumer receives cli_connected from real backend",
    async () => {
      const { manager, sessionId, port } = await setupRealCliSession();
      activeManagers.push(manager);
      await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

      const consumer = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}`);
      const initialMessagesPromise = collectMessages(consumer, 4, 10_000);
      try {
        await new Promise<void>((resolve, reject) => {
          consumer.once("open", () => resolve());
          consumer.once("error", (err) => reject(err));
        });
        const initialMessages = await initialMessagesPromise;
        const types = initialMessages
          .map((m) => {
            try {
              return (JSON.parse(m) as { type?: string }).type;
            } catch {
              return undefined;
            }
          })
          .filter((t): t is string => typeof t === "string");
        expect(types).toContain("session_init");
        expect(types).toContain("cli_connected");
      } finally {
        await closeWebSockets(consumer);
      }
    },
  );

  it.runIf(runSessionManagerRealCli)(
    "two independent real sessions can connect concurrently",
    async () => {
      const session1 = await setupRealCliSession();
      const session2 = await setupRealCliSession();
      activeManagers.push(session1.manager, session2.manager);

      await Promise.all([
        waitForBackendConnectedOrExit(session1.manager, session1.sessionId, 30_000),
        waitForBackendConnectedOrExit(session2.manager, session2.sessionId, 30_000),
      ]);

      expect(session1.manager.bridge.isBackendConnected(session1.sessionId)).toBe(true);
      expect(session2.manager.bridge.isBackendConnected(session2.sessionId)).toBe(true);
    },
  );

  it.runIf(runSessionManagerRealCli)(
    "backend stays connected across consumer disconnect and reconnect",
    async () => {
      const { manager, sessionId, port } = await setupRealCliSession();
      activeManagers.push(manager);
      await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

      const consumer1 = await connectConsumerAndWaitReady(port, sessionId);
      await closeWebSockets(consumer1);

      // Give the bridge a brief moment to process close handlers.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);

      const consumer2 = await connectConsumerAndWaitReady(port, sessionId);
      await closeWebSockets(consumer2);
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
    },
  );

  it.runIf(runSessionManagerRealCli)(
    "deleteSession removes a live connected real CLI session",
    async () => {
      const { manager, sessionId } = await setupRealCliSession();
      activeManagers.push(manager);
      await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

      expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
      const deleted = await manager.deleteSession(sessionId);
      expect(deleted).toBe(true);
      expect(manager.launcher.getSession(sessionId)).toBeUndefined();
      expect(manager.bridge.getSession(sessionId)).toBeUndefined();
    },
  );

  it.runIf(runSessionManagerRealCli)(
    "consumer receives cli_disconnected when real CLI process is killed",
    async () => {
      const { manager, sessionId, port } = await setupRealCliSession();
      activeManagers.push(manager);
      await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

      const consumer = await connectConsumerAndWaitReady(port, sessionId);
      try {
        const disconnectedPromise = waitForMessageType(consumer, "cli_disconnected", 20_000);
        const killed = await manager.launcher.kill(sessionId);
        expect(killed).toBe(true);
        const disconnected = await disconnectedPromise;
        expect((disconnected as { type: string }).type).toBe("cli_disconnected");
      } finally {
        await closeWebSockets(consumer);
      }
    },
  );

  it.runIf(runSessionManagerRealCli)(
    "relaunch reconnects backend and broadcasts cli_connected again",
    async () => {
      const { manager, sessionId, port } = await setupRealCliSession();
      activeManagers.push(manager);
      await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

      const consumer = await connectConsumerAndWaitReady(port, sessionId);
      try {
        const disconnectedPromise = waitForMessageType(consumer, "cli_disconnected", 20_000);
        const killed = await manager.launcher.kill(sessionId);
        expect(killed).toBe(true);
        await disconnectedPromise;

        const connectedAgainPromise = waitForMessageType(consumer, "cli_connected", 30_000);
        const relaunched = await manager.launcher.relaunch(sessionId);
        expect(relaunched).toBe(true);
        await waitForBackendConnectedOrExit(manager, sessionId, 30_000);
        const connectedAgain = await connectedAgainPromise;
        expect((connectedAgain as { type: string }).type).toBe("cli_connected");
      } finally {
        await closeWebSockets(consumer);
      }
    },
  );

  it.runIf(runSessionManagerRealCli)(
    "consumer attaching immediately after launch still reaches ready state",
    async () => {
      const port = await reservePort();
      const server = new NodeWebSocketServer({ port });
      const processManager = createProcessManager();
      const config = { port, initializeTimeoutMs: 20_000 };
      const storage = new MemoryStorage();
      const manager = new SessionManager({
        config,
        storage,
        server,
        adapter: new ClaudeAdapter(),
        launcher: new ClaudeLauncher({ processManager, config, storage }),
      });
      attachTrace(manager);
      activeManagers.push(manager);
      await manager.start();

      const launched = manager.launcher.launch({ cwd: process.cwd() });
      const consumer = await connectConsumerAndWaitReady(port, launched.sessionId, {
        requireCliConnected: false,
      });
      try {
        await waitForBackendConnectedOrExit(manager, launched.sessionId, 20_000);
        expect(manager.bridge.isBackendConnected(launched.sessionId)).toBe(true);
      } finally {
        await closeWebSockets(consumer);
      }
    },
  );

  it.runIf(runSessionManagerRealCli)(
    "invalid CLI binary exits session without backend connection",
    async () => {
      const port = await reservePort();
      const server = new NodeWebSocketServer({ port });
      const processManager = createProcessManager();
      const config = { port, defaultClaudeBinary: "__beamcode_nonexistent_claude_binary__" };
      const storage = new MemoryStorage();
      const manager = new SessionManager({
        config,
        storage,
        server,
        adapter: new ClaudeAdapter(),
        launcher: new ClaudeLauncher({ processManager, config, storage }),
      });
      attachTrace(manager);
      activeManagers.push(manager);
      await manager.start();

      const { sessionId } = manager.launcher.launch({ cwd: process.cwd() });
      await waitForSessionExited(manager, sessionId, 10_000);
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(false);
      expect(manager.launcher.getSession(sessionId)?.state).toBe("exited");
    },
  );

  it.runIf(runSessionManagerRealCli)(
    "invalid cwd exits session without backend connection",
    async () => {
      const { manager } = await setupRealCliSession();
      activeManagers.push(manager);

      const { sessionId } = manager.launcher.launch({ cwd: "/definitely/not/a/real/path" });
      await waitForSessionExited(manager, sessionId, 10_000);
      expect(manager.bridge.isBackendConnected(sessionId)).toBe(false);
      expect(manager.launcher.getSession(sessionId)?.state).toBe("exited");
    },
  );

  it.runIf(runSessionManagerRealCli)(
    "stress: sequential real sessions connect and teardown (x3)",
    async () => {
      for (let i = 0; i < 3; i++) {
        const { manager, sessionId } = await setupRealCliSession();
        activeManagers.push(manager);
        await waitForBackendConnectedOrExit(manager, sessionId, 25_000);
        const removed = await manager.deleteSession(sessionId);
        expect(removed).toBe(true);
      }
    },
  );

  it.runIf(runSessionManagerRealCli)(
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

      const { manager, sessionId, port } = await setupRealCliSessionWithOptions({
        authenticator,
      });
      activeManagers.push(manager);
      await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

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
        manager.bridge.broadcastProcessOutput(sessionId, "stderr", "REALCLI_RBAC_OUTPUT_CHECK");
        await partOutput;
        await expect(waitForMessageType(observer, "process_output", 1000)).rejects.toThrow(
          /Timeout waiting for message/,
        );
      } finally {
        await closeWebSockets(participant, observer);
      }
    },
  );

  it.runIf(runSessionManagerRealCli)("watchdog relaunches stale starting session", async () => {
    const { manager, sessionId } = await setupRealCliSessionWithOptions({
      config: { reconnectGracePeriodMs: 200 },
    });
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

    const info = manager.launcher.getSession(sessionId);
    expect(info).toBeDefined();
    if (!info) return;
    info.state = "starting";

    const launcherAny = manager.launcher as unknown as {
      getStartingSessions: () => Array<{ sessionId: string; state: string; archived?: boolean }>;
      relaunch: (id: string) => Promise<boolean>;
    };
    const originalGetStarting = launcherAny.getStartingSessions.bind(manager.launcher);
    const originalRelaunch = launcherAny.relaunch.bind(manager.launcher);
    let relaunchCount = 0;
    launcherAny.getStartingSessions = () => [info];
    launcherAny.relaunch = async (id: string) => {
      if (id === sessionId) relaunchCount += 1;
      return true;
    };

    try {
      const managerAny = manager as unknown as { startReconnectWatchdog: () => void };
      managerAny.startReconnectWatchdog();
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(relaunchCount).toBeGreaterThan(0);
    } finally {
      launcherAny.getStartingSessions = originalGetStarting;
      launcherAny.relaunch = originalRelaunch;
    }
  });

  it.runIf(runFullOnly)(
    "control path: set_permission_mode keeps real backend healthy",
    async () => {
      const { manager, sessionId, port } = await setupRealCliSession();
      activeManagers.push(manager);
      await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

      const consumer = await connectConsumerAndWaitReady(port, sessionId);
      try {
        consumer.send(JSON.stringify({ type: "set_permission_mode", mode: "delegate" }));
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
      } finally {
        await closeWebSockets(consumer);
      }
    },
  );

  it.runIf(runFullOnly)("slash command passthrough uses CLI path", async () => {
    const { manager, sessionId, port } = await setupRealCliSession();
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
    try {
      consumer.send(
        JSON.stringify({
          type: "slash_command",
          command: "/context",
          request_id: "realcli-context-1",
        }),
      );
      const msg = (await waitForMessageType(consumer, "slash_command_result", 60_000)) as {
        type: string;
        source?: string;
        request_id?: string;
        content?: string;
      };
      expect(msg.type).toBe("slash_command_result");
      expect(msg.source).toBe("cli");
      expect(msg.request_id).toBe("realcli-context-1");
      expect((msg.content ?? "").length).toBeGreaterThan(0);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFullOnly)(
    "delegate permission mode remains healthy and handles permission prompt when surfaced",
    async () => {
      const { manager, sessionId, port } = await setupRealCliSession();
      activeManagers.push(manager);
      await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

      const consumer = await connectConsumerAndWaitReady(port, sessionId);
      try {
        consumer.send(JSON.stringify({ type: "set_permission_mode", mode: "delegate" }));
        await new Promise((resolve) => setTimeout(resolve, 1000));

        consumer.send(
          JSON.stringify({
            type: "user_message",
            content:
              "Use Bash to run exactly: echo REALCLI_PERMISSION_CHECK. Do not answer without the tool.",
          }),
        );

        // In some environments/models this emits permission_request, in others
        // the assistant responds directly. Accept either path, but keep it bounded.
        const observed = (await waitForMessage(
          consumer,
          (msg) =>
            typeof msg === "object" &&
            msg !== null &&
            "type" in msg &&
            ["permission_request", "assistant", "result"].includes(
              (msg as { type?: string }).type ?? "",
            ),
          15_000,
        )) as { type: string; request?: { request_id?: string } };

        if (observed.type === "permission_request") {
          const requestId = observed.request?.request_id;
          expect(requestId).toBeTruthy();
          if (!requestId) return;
          consumer.send(
            JSON.stringify({
              type: "permission_response",
              request_id: requestId,
              behavior: "deny",
              message: "Denied by e2e test",
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
      } finally {
        await closeWebSockets(consumer);
      }
    },
  );

  it.runIf(runFullOnly)(
    "full mode: user_message gets an assistant reply from real CLI",
    async () => {
      const { manager, sessionId, port } = await setupRealCliSession();
      activeManagers.push(manager);
      await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

      const consumer = await connectConsumerAndWaitReady(port, sessionId);
      try {
        consumer.send(
          JSON.stringify({
            type: "user_message",
            content: "Reply with EXACTLY REALCLI_E2E_OK and nothing else.",
          }),
        );

        const assistant = await waitForMessage(
          consumer,
          (msg) => assistantTextContains(msg, "REALCLI_E2E_OK"),
          90_000,
        );

        expect(assistantTextContains(assistant, "REALCLI_E2E_OK")).toBe(true);
        const result = await waitForMessageType(consumer, "result", 90_000);
        expect((result as { type: string }).type).toBe("result");
      } finally {
        await closeWebSockets(consumer);
      }
    },
  );

  it.runIf(runFullOnly)("full mode: broadcast live assistant/result to two consumers", async () => {
    const { manager, sessionId, port } = await setupRealCliSession();
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

    const consumer1 = await connectConsumerAndWaitReady(port, sessionId);
    const consumer2 = await connectConsumerAndWaitReady(port, sessionId);
    try {
      consumer1.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY REALCLI_BROADCAST_OK and nothing else.",
        }),
      );

      const [assistant1, assistant2] = await Promise.all([
        waitForMessage(
          consumer1,
          (msg) => assistantTextContains(msg, "REALCLI_BROADCAST_OK"),
          90_000,
        ),
        waitForMessage(
          consumer2,
          (msg) => assistantTextContains(msg, "REALCLI_BROADCAST_OK"),
          90_000,
        ),
      ]);
      expect(assistantTextContains(assistant1, "REALCLI_BROADCAST_OK")).toBe(true);
      expect(assistantTextContains(assistant2, "REALCLI_BROADCAST_OK")).toBe(true);

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

  it.runIf(runFullOnly)("full mode: relaunch preserves usability for subsequent turn", async () => {
    const { manager, sessionId, port } = await setupRealCliSession();
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY REALCLI_BEFORE_RELAUNCH and nothing else.",
        }),
      );
      await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "REALCLI_BEFORE_RELAUNCH"),
        90_000,
      );
      await waitForMessageType(consumer, "result", 90_000);

      const disconnected = waitForMessageType(consumer, "cli_disconnected", 20_000);
      const killed = await manager.launcher.kill(sessionId);
      expect(killed).toBe(true);
      await disconnected;

      const reconnected = waitForMessageType(consumer, "cli_connected", 30_000);
      const relaunched = await manager.launcher.relaunch(sessionId);
      expect(relaunched).toBe(true);
      await waitForBackendConnectedOrExit(manager, sessionId, 30_000);
      await reconnected;

      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY REALCLI_AFTER_RELAUNCH and nothing else.",
        }),
      );
      const after = await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "REALCLI_AFTER_RELAUNCH"),
        90_000,
      );
      expect(assistantTextContains(after, "REALCLI_AFTER_RELAUNCH")).toBe(true);
      await waitForMessageType(consumer, "result", 90_000);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFullOnly)("full mode: same real session supports a second turn", async () => {
    const { manager, sessionId, port } = await setupRealCliSession();
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY REALCLI_TURN_ONE and nothing else.",
        }),
      );
      await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "REALCLI_TURN_ONE"),
        90_000,
      );
      await waitForMessageType(consumer, "result", 90_000);

      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY REALCLI_TURN_TWO and nothing else.",
        }),
      );
      const turnTwo = await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "REALCLI_TURN_TWO"),
        90_000,
      );

      expect(assistantTextContains(turnTwo, "REALCLI_TURN_TWO")).toBe(true);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFullOnly)(
    "resume across manager restart (storage-backed) preserves conversation context",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "beamcode-realcli-resume-"));
      const storage = new FileStorage(tempDir);
      const rememberToken = `REALCLI_REMEMBER_${Date.now()}`;

      let manager1: SessionManager | null = null;
      let manager2: SessionManager | null = null;
      try {
        const first = await setupRealCliSessionWithOptions({ storage });
        manager1 = first.manager;
        activeManagers.push(manager1);
        await waitForBackendConnectedOrExit(manager1, first.sessionId, 20_000);

        const consumer1 = await connectConsumerAndWaitReady(first.port, first.sessionId);
        consumer1.send(
          JSON.stringify({
            type: "user_message",
            content: `Remember this exact token for later: ${rememberToken}. Reply with OK.`,
          }),
        );
        await waitForMessageType(consumer1, "assistant", 90_000);
        await waitForMessageType(consumer1, "result", 90_000);
        await closeWebSockets(consumer1);

        const persistedId = first.sessionId;
        await manager1.stop();
        activeManagers.pop();
        manager1 = null;

        const port2 = await reservePort();
        const server2 = new NodeWebSocketServer({ port: port2 });
        const pm2 = createProcessManager();
        const config2 = { port: port2, initializeTimeoutMs: 20_000 };
        manager2 = new SessionManager({
          config: config2,
          storage,
          server: server2,
          adapter: new ClaudeAdapter(),
          launcher: new ClaudeLauncher({ processManager: pm2, config: config2, storage }),
        });
        attachTrace(manager2);
        activeManagers.push(manager2);
        await manager2.start();

        expect(manager2.launcher.getSession(persistedId)).toBeDefined();
        expect(await manager2.launcher.relaunch(persistedId)).toBe(true);
        await waitForBackendConnectedOrExit(manager2, persistedId, 30_000);

        const consumer2 = await connectConsumerAndWaitReady(server2.port ?? port2, persistedId);
        consumer2.send(
          JSON.stringify({
            type: "user_message",
            content: "What was the exact token I asked you to remember? Reply with the token only.",
          }),
        );
        const resumed = await waitForMessage(
          consumer2,
          (msg) => assistantTextContains(msg, rememberToken),
          90_000,
        );
        expect(assistantTextContains(resumed, rememberToken)).toBe(true);
        await waitForMessageType(consumer2, "result", 90_000);
        await closeWebSockets(consumer2);
      } finally {
        if (manager1) await manager1.stop();
        if (manager2) await manager2.stop();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );
});
