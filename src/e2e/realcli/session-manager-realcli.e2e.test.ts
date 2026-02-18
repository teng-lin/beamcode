import { afterEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../../adapters/memory-storage.js";
import { NodeWebSocketServer } from "../../adapters/node-ws-server.js";
import { SdkUrlAdapter } from "../../adapters/sdk-url/sdk-url-adapter.js";
import { SessionManager } from "../../core/session-manager.js";
import { getE2EProfile } from "../helpers/e2e-profile.js";
import {
  closeWebSockets,
  connectTestConsumer,
  createProcessManager,
  waitForMessage,
  waitForMessageType,
} from "../helpers/test-utils.js";
import { getRealCliPrereqState } from "./prereqs.js";

type SessionManagerEventPayload = { sessionId: string };

function waitForManagerEvent(
  manager: SessionManager,
  eventName: "process:spawned" | "backend:connected" | "backend:session_id" | "capabilities:ready",
  sessionId: string,
  timeoutMs = 45_000,
): Promise<SessionManagerEventPayload> {
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
        clearTimeout(timer);
        manager.off(eventName, handler);
        resolve(payload as SessionManagerEventPayload);
      }
    };

    manager.on(eventName, handler);
  });
}

async function setupRealCliSession() {
  const server = new NodeWebSocketServer({ port: 0 });
  const manager = new SessionManager({
    config: {
      port: 0,
      initializeTimeoutMs: 20_000,
    },
    processManager: createProcessManager(),
    storage: new MemoryStorage(),
    server,
    adapter: new SdkUrlAdapter(),
  });

  await manager.start();

  const launched = manager.launcher.launch({ cwd: process.cwd() });
  const port = server.port ?? 0;

  return { manager, server, sessionId: launched.sessionId, port };
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

const profile = getE2EProfile();
const prereqs = getRealCliPrereqState();
const runFullOnly = prereqs.ok && profile === "realcli-full";

describe("E2E Real CLI SessionManager integration", () => {
  const activeManagers: SessionManager[] = [];

  afterEach(async () => {
    while (activeManagers.length > 0) {
      const manager = activeManagers.pop();
      if (manager) {
        await manager.stop();
      }
    }
  });

  it.runIf(prereqs.ok)("launch emits process spawn and records PID", async () => {
    const { manager, sessionId } = await setupRealCliSession();
    activeManagers.push(manager);

    await waitForManagerEvent(manager, "process:spawned", sessionId, 15_000);

    const info = manager.launcher.getSession(sessionId);
    expect(info).toBeDefined();
    expect(typeof info?.pid).toBe("number");
    expect(info?.state === "starting" || info?.state === "connected").toBe(true);
  });

  it.runIf(prereqs.ok)("real CLI connects backend and session becomes connected", async () => {
    const { manager, sessionId } = await setupRealCliSession();
    activeManagers.push(manager);

    await waitForManagerEvent(manager, "backend:connected", sessionId, 45_000);

    expect(manager.bridge.isBackendConnected(sessionId)).toBe(true);
    expect(manager.launcher.getSession(sessionId)?.state).toBe("connected");
  });

  it.runIf(prereqs.ok)("real CLI emits session id and capabilities are marked ready", async () => {
    const { manager, sessionId } = await setupRealCliSession();
    activeManagers.push(manager);

    await waitForManagerEvent(manager, "backend:connected", sessionId, 45_000);
    await waitForManagerEvent(manager, "backend:session_id", sessionId, 45_000);
    await waitForManagerEvent(manager, "capabilities:ready", sessionId, 45_000);

    const info = manager.launcher.getSession(sessionId);
    expect(info?.cliSessionId).toBeTruthy();

    const models = manager.getSupportedModels(sessionId);
    const commands = manager.getSupportedCommands(sessionId);
    expect(models.length + commands.length).toBeGreaterThan(0);
  });

  it.runIf(prereqs.ok)("consumer receives cli_connected from real backend", async () => {
    const { manager, sessionId, port } = await setupRealCliSession();
    activeManagers.push(manager);

    const consumer = await connectTestConsumer(port, sessionId);
    try {
      await waitForMessageType(consumer, "session_init", 10_000);
      const connected = await waitForMessageType(consumer, "cli_connected", 45_000);
      expect((connected as { type: string }).type).toBe("cli_connected");
    } finally {
      await closeWebSockets(consumer);
    }
  });

  it.runIf(prereqs.ok)("two independent real sessions can connect concurrently", async () => {
    const session1 = await setupRealCliSession();
    const session2 = await setupRealCliSession();
    activeManagers.push(session1.manager, session2.manager);

    await Promise.all([
      waitForManagerEvent(session1.manager, "backend:connected", session1.sessionId, 45_000),
      waitForManagerEvent(session2.manager, "backend:connected", session2.sessionId, 45_000),
    ]);

    expect(session1.manager.bridge.isBackendConnected(session1.sessionId)).toBe(true);
    expect(session2.manager.bridge.isBackendConnected(session2.sessionId)).toBe(true);
  });

  it.runIf(runFullOnly)(
    "full mode: user_message gets an assistant reply from real CLI",
    async () => {
      const { manager, sessionId, port } = await setupRealCliSession();
      activeManagers.push(manager);

      const consumer = await connectTestConsumer(port, sessionId);
      try {
        await waitForMessageType(consumer, "session_init", 10_000);
        await waitForMessageType(consumer, "cli_connected", 45_000);

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

  it.runIf(runFullOnly)("full mode: same real session supports a second turn", async () => {
    const { manager, sessionId, port } = await setupRealCliSession();
    activeManagers.push(manager);

    const consumer = await connectTestConsumer(port, sessionId);
    try {
      await waitForMessageType(consumer, "session_init", 10_000);
      await waitForMessageType(consumer, "cli_connected", 45_000);

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
