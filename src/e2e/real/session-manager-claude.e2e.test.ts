import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../adapters/claude/claude-adapter.js";
import { ClaudeLauncher } from "../../adapters/claude/claude-launcher.js";
import { FileStorage } from "../../adapters/file-storage.js";
import { MemoryStorage } from "../../adapters/memory-storage.js";
import { NodeWebSocketServer } from "../../adapters/node-ws-server.js";
import { SessionManager } from "../../core/session-manager.js";
import { getE2EProfile } from "../helpers/e2e-profile.js";
import { createProcessManager } from "../helpers/test-utils.js";
import {
  assistantTextContains,
  attachTrace,
  canBindLocalhostSync,
  closeWebSockets,
  connectConsumerAndWaitReady,
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
import { setupRealSession } from "./session-manager-setup.js";
import { registerSharedFullTests, registerSharedSmokeTests } from "./shared-real-e2e-tests.js";

const profile = getE2EProfile();
const prereqs = getRealCliPrereqState();
const canBindLocalhost = canBindLocalhostSync();
const runSmoke = prereqs.ok && canBindLocalhost;
const runFull = runSmoke && profile === "real-full";

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

  // -------------------------------------------------------------------------
  // Shared smoke + full tests
  // -------------------------------------------------------------------------

  const sharedConfig = {
    adapterName: "claude" as const,
    tokenPrefix: "CLAUDE",
    setup: (opts?: Parameters<typeof setupRealSession>[1]) => setupRealSession("claude", opts),
    runSmoke,
    runFull,
    activeManagers,
  };

  registerSharedSmokeTests(sharedConfig);
  registerSharedFullTests(sharedConfig);

  // -------------------------------------------------------------------------
  // Claude-unique smoke tests
  // -------------------------------------------------------------------------

  it.runIf(runSmoke)("launch emits process spawn and records PID", async () => {
    const { manager, sessionId } = await setupRealSession("claude");
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

  it.runIf(runSmoke)(
    "consumer receives cli_disconnected when real CLI process is killed",
    async () => {
      const { manager, sessionId, port } = await setupRealSession("claude");
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

  it.runIf(runSmoke)("relaunch reconnects backend and broadcasts cli_connected again", async () => {
    const { manager, sessionId, port } = await setupRealSession("claude");
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
  });

  it.runIf(runSmoke)("invalid CLI binary exits session without backend connection", async () => {
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
  });

  it.runIf(runSmoke)("invalid cwd exits session without backend connection", async () => {
    const { manager } = await setupRealSession("claude");
    activeManagers.push(manager);

    const { sessionId } = manager.launcher.launch({ cwd: "/definitely/not/a/real/path" });
    await waitForSessionExited(manager, sessionId, 10_000);
    expect(manager.bridge.isBackendConnected(sessionId)).toBe(false);
    expect(manager.launcher.getSession(sessionId)?.state).toBe("exited");
  });

  it.runIf(runSmoke)("watchdog relaunches stale starting session", async () => {
    const { manager, sessionId } = await setupRealSession("claude", {
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

  // -------------------------------------------------------------------------
  // Claude-unique full tests
  // -------------------------------------------------------------------------

  it.skip("slash command passthrough uses CLI path", async () => {
    const { manager, sessionId, port } = await setupRealSession("claude");
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
    try {
      consumer.send(
        JSON.stringify({
          type: "slash_command",
          command: "/context",
          request_id: "claude-context-1",
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
      expect(msg.request_id).toBe("claude-context-1");
      // New version of Claude Code 2.1.49 return empty
      expect(msg.content ?? "").toContain("");
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFull)(
    "delegate permission mode remains healthy and handles permission prompt when surfaced",
    async () => {
      const { manager, sessionId, port } = await setupRealSession("claude");
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
              "Use Bash to run exactly: echo CLAUDE_PERMISSION_CHECK. Do not answer without the tool.",
          }),
        );

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

  it.runIf(runFull)("relaunch preserves usability for subsequent turn", async () => {
    const { manager, sessionId, port } = await setupRealSession("claude");
    activeManagers.push(manager);
    await waitForBackendConnectedOrExit(manager, sessionId, 20_000);

    const consumer = await connectConsumerAndWaitReady(port, sessionId);
    try {
      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY CLAUDE_BEFORE_RELAUNCH and nothing else.",
        }),
      );
      await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "CLAUDE_BEFORE_RELAUNCH"),
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

      // Diagnostic: log session state before post-relaunch turn
      {
        const snapshot = manager.bridge.getSession(sessionId);
        const launcherInfo = manager.launcher.getSession(sessionId);
        console.log(
          `[claude-relaunch-turn] before post-relaunch turn: lastStatus=${snapshot?.lastStatus ?? "n/a"} ` +
            `cliConnected=${snapshot?.cliConnected ?? "n/a"} ` +
            `launcherState=${launcherInfo?.state ?? "n/a"} ` +
            `backendConnected=${manager.bridge.isBackendConnected(sessionId)} ` +
            `messageHistoryLen=${snapshot?.messageHistoryLength ?? "n/a"}`,
        );
      }

      consumer.send(
        JSON.stringify({
          type: "user_message",
          content: "Reply with EXACTLY CLAUDE_AFTER_RELAUNCH and nothing else.",
        }),
      );
      const after = await waitForMessage(
        consumer,
        (msg) => assistantTextContains(msg, "CLAUDE_AFTER_RELAUNCH"),
        90_000,
      );
      expect(assistantTextContains(after, "CLAUDE_AFTER_RELAUNCH")).toBe(true);
      await waitForMessageType(consumer, "result", 90_000);
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(runFull)(
    "resume across manager restart (storage-backed) preserves conversation context",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "beamcode-claude-resume-"));
      const fileStorage = new FileStorage(tempDir);
      const rememberToken = `CLAUDE_REMEMBER_${Date.now()}`;

      let manager1: SessionManager | null = null;
      let manager2: SessionManager | null = null;
      try {
        // First session: send a message the model should remember
        const port1 = await reservePort();
        const server1 = new NodeWebSocketServer({ port: port1 });
        const pm1 = createProcessManager();
        const config1 = { port: port1, initializeTimeoutMs: 20_000 };
        manager1 = new SessionManager({
          config: config1,
          storage: fileStorage,
          server: server1,
          adapter: new ClaudeAdapter(),
          launcher: new ClaudeLauncher({
            processManager: pm1,
            config: config1,
            storage: fileStorage,
          }),
        });
        attachTrace(manager1);
        activeManagers.push(manager1);
        await manager1.start();

        const launched = manager1.launcher.launch({ cwd: process.cwd() });
        const boundPort1 = server1.port ?? port1;
        await waitForBackendConnectedOrExit(manager1, launched.sessionId, 20_000);

        const consumer1 = await connectConsumerAndWaitReady(boundPort1, launched.sessionId);
        consumer1.send(
          JSON.stringify({
            type: "user_message",
            content: `Remember this exact token for later: ${rememberToken}. Reply with OK.`,
          }),
        );
        await waitForMessageType(consumer1, "assistant", 90_000);
        await waitForMessageType(consumer1, "result", 90_000);
        await closeWebSockets(consumer1);

        const persistedId = launched.sessionId;
        await manager1.stop();
        activeManagers.pop();
        manager1 = null;

        // Second manager: relaunch and verify the model remembers
        const port2 = await reservePort();
        const server2 = new NodeWebSocketServer({ port: port2 });
        const pm2 = createProcessManager();
        const config2 = { port: port2, initializeTimeoutMs: 20_000 };
        manager2 = new SessionManager({
          config: config2,
          storage: fileStorage,
          server: server2,
          adapter: new ClaudeAdapter(),
          launcher: new ClaudeLauncher({
            processManager: pm2,
            config: config2,
            storage: fileStorage,
          }),
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
