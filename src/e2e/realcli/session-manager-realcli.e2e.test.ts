import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { MemoryStorage } from "../../adapters/memory-storage.js";
import { NodeWebSocketServer } from "../../adapters/node-ws-server.js";
import { SdkUrlAdapter } from "../../adapters/sdk-url/sdk-url-adapter.js";
import { SessionManager } from "../../core/session-manager.js";
import { getE2EProfile } from "../helpers/e2e-profile.js";
import {
  closeWebSockets,
  collectMessages,
  createProcessManager,
  waitForMessage,
  waitForMessageType,
} from "../helpers/test-utils.js";
import { getRealCliPrereqState } from "./prereqs.js";

type SessionManagerEventPayload = { sessionId: string };
type TestContextLike = { task?: { name?: string; result?: { state?: string } } };
type ManagerTrace = {
  events: string[];
  stdout: string[];
  stderr: string[];
};
const traceByManager = new Map<SessionManager, ManagerTrace>();

function attachTrace(manager: SessionManager): void {
  if (traceByManager.has(manager)) return;
  const trace: ManagerTrace = { events: [], stdout: [], stderr: [] };
  const stamp = () => new Date().toISOString();
  manager.on("process:spawned", ({ sessionId, pid }) => {
    trace.events.push(`${stamp()} process:spawned session=${sessionId} pid=${pid}`);
  });
  manager.on("process:exited", ({ sessionId, exitCode, uptimeMs }) => {
    trace.events.push(
      `${stamp()} process:exited session=${sessionId} code=${exitCode} uptimeMs=${uptimeMs}`,
    );
  });
  manager.on("backend:connected", ({ sessionId }) => {
    trace.events.push(`${stamp()} backend:connected session=${sessionId}`);
  });
  manager.on("backend:disconnected", ({ sessionId, reason }) => {
    trace.events.push(`${stamp()} backend:disconnected session=${sessionId} reason=${reason}`);
  });
  manager.on("capabilities:ready", ({ sessionId }) => {
    trace.events.push(`${stamp()} capabilities:ready session=${sessionId}`);
  });
  manager.on("error", ({ source, sessionId, error }) => {
    trace.events.push(
      `${stamp()} error source=${source} session=${sessionId ?? "n/a"} msg=${String(error)}`,
    );
  });
  manager.on("process:stdout", ({ data }) => {
    trace.stdout.push(data.trim());
    if (trace.stdout.length > 40) trace.stdout.splice(0, trace.stdout.length - 40);
  });
  manager.on("process:stderr", ({ data }) => {
    trace.stderr.push(data.trim());
    if (trace.stderr.length > 40) trace.stderr.splice(0, trace.stderr.length - 40);
  });
  traceByManager.set(manager, trace);
}

function canBindLocalhostSync(): boolean {
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      [
        "const net=require('node:net');",
        "const s=net.createServer();",
        "s.once('error',()=>process.exit(1));",
        "s.listen(0,'127.0.0.1',()=>s.close(()=>process.exit(0)));",
      ].join(""),
    ],
    { timeout: 3000, stdio: "ignore" },
  );
  return probe.status === 0;
}

function waitForManagerEvent(
  manager: SessionManager,
  eventName: "process:spawned" | "backend:connected" | "backend:session_id" | "capabilities:ready",
  sessionId: string,
  isSatisfied: () => boolean,
  timeoutMs = 45_000,
): Promise<SessionManagerEventPayload> {
  if (isSatisfied()) {
    return Promise.resolve({ sessionId });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      manager.off(eventName, handler);
      reject(new Error(`Timed out waiting for ${eventName} for session ${sessionId}`));
    }, timeoutMs);

    const handler = (payload: unknown) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "sessionId" in payload &&
        (payload as SessionManagerEventPayload).sessionId === sessionId
      ) {
        if (!isSatisfied()) return;
        clearTimeout(timer);
        manager.off(eventName, handler);
        resolve(payload as SessionManagerEventPayload);
      }
    };

    manager.on(eventName, handler);
  });
}

function waitForBackendConnectedOrExit(
  manager: SessionManager,
  sessionId: string,
  timeoutMs = 20_000,
): Promise<void> {
  if (manager.bridge.isBackendConnected(sessionId)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onConnected = (payload: unknown) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "sessionId" in payload &&
        (payload as SessionManagerEventPayload).sessionId === sessionId &&
        manager.bridge.isBackendConnected(sessionId)
      ) {
        cleanup();
        resolve();
      }
    };

    const onExited = (payload: unknown) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "sessionId" in payload &&
        (payload as SessionManagerEventPayload).sessionId === sessionId
      ) {
        const info = manager.launcher.getSession(sessionId);
        cleanup();
        reject(
          new Error(
            `CLI process exited before backend connected for session ${sessionId} ` +
              `(state=${info?.state ?? "unknown"}, exitCode=${info?.exitCode ?? "unknown"})`,
          ),
        );
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for backend connection for session ${sessionId}`));
    }, timeoutMs);

    const poll = setInterval(() => {
      if (manager.bridge.isBackendConnected(sessionId)) {
        cleanup();
        resolve();
        return;
      }
      const info = manager.launcher.getSession(sessionId);
      if (info?.state === "exited") {
        cleanup();
        reject(
          new Error(
            `CLI process exited before backend connected for session ${sessionId} ` +
              `(exitCode=${info.exitCode ?? "unknown"})`,
          ),
        );
      }
    }, 100);

    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poll);
      manager.off("backend:connected", onConnected);
      manager.off("process:exited", onExited);
    };

    manager.on("backend:connected", onConnected);
    manager.on("process:exited", onExited);
  });
}

async function setupRealCliSession() {
  const port = await reservePort();
  const server = new NodeWebSocketServer({ port });
  const manager = new SessionManager({
    config: {
      port,
      initializeTimeoutMs: 20_000,
    },
    processManager: createProcessManager(),
    storage: new MemoryStorage(),
    server,
    adapter: new SdkUrlAdapter(),
  });
  attachTrace(manager);

  await manager.start();

  const launched = manager.launcher.launch({ cwd: process.cwd() });
  const boundPort = server.port ?? port;

  return { manager, server, sessionId: launched.sessionId, port: boundPort };
}

async function waitForSessionExited(
  manager: SessionManager,
  sessionId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (manager.launcher.getSession(sessionId)?.state === "exited") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for session ${sessionId} to exit`);
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Failed to reserve ephemeral port")));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function assistantTextContains(msg: unknown, token: string): boolean {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
  if ((msg as { type?: string }).type !== "assistant") return false;

  const message = (msg as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return false;

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;

  return content.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    return "text" in item && typeof (item as { text?: unknown }).text === "string"
      ? (item as { text: string }).text.includes(token)
      : false;
  });
}

async function connectConsumerAndWaitReady(
  port: number,
  sessionId: string,
  options?: { requireCliConnected?: boolean; timeoutMs?: number },
): Promise<WebSocket> {
  const requireCliConnected = options?.requireCliConnected ?? true;
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const consumer = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}`);
  const initialMessagesPromise = collectMessages(consumer, 4, timeoutMs);
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
  if (requireCliConnected && !types.includes("cli_connected")) {
    const connected = await waitForMessageType(consumer, "cli_connected", timeoutMs);
    expect((connected as { type: string }).type).toBe("cli_connected");
  }
  return consumer;
}

const profile = getE2EProfile();
const prereqs = getRealCliPrereqState();
const canBindLocalhost = canBindLocalhostSync();
const runSessionManagerRealCli = prereqs.ok && canBindLocalhost;
const runFullOnly = runSessionManagerRealCli && profile === "realcli-full";

describe("E2E Real CLI SessionManager integration", () => {
  const activeManagers: SessionManager[] = [];

  afterEach(async (context: TestContextLike) => {
    if (context?.task?.result?.state === "fail") {
      console.error(
        `[realcli-e2e-debug] failed test: ${context.task?.name ?? "unknown"} managers=${activeManagers.length}`,
      );
      for (const manager of activeManagers) {
        const trace = traceByManager.get(manager);
        if (!trace) continue;
        const recentEvents = trace.events.slice(-20);
        const recentStderr = trace.stderr.slice(-15);
        const recentStdout = trace.stdout.slice(-10);
        if (recentEvents.length > 0) {
          console.error("[realcli-e2e-debug] recent events:");
          for (const line of recentEvents) console.error(`  ${line}`);
        }
        if (recentStderr.length > 0) {
          console.error("[realcli-e2e-debug] recent stderr:");
          for (const line of recentStderr) console.error(`  ${line}`);
        }
        if (recentStdout.length > 0) {
          console.error("[realcli-e2e-debug] recent stdout:");
          for (const line of recentStdout) console.error(`  ${line}`);
        }
      }
    }

    while (activeManagers.length > 0) {
      const manager = activeManagers.pop();
      if (manager) {
        await manager.stop();
        traceByManager.delete(manager);
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
      const manager = new SessionManager({
        config: {
          port,
          initializeTimeoutMs: 20_000,
        },
        processManager: createProcessManager(),
        storage: new MemoryStorage(),
        server,
        adapter: new SdkUrlAdapter(),
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
      const manager = new SessionManager({
        config: {
          port,
          defaultClaudeBinary: "__beamcode_nonexistent_claude_binary__",
        },
        processManager: createProcessManager(),
        storage: new MemoryStorage(),
        server,
        adapter: new SdkUrlAdapter(),
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
});
