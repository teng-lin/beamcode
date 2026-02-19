/**
 * Shared helpers for real backend e2e tests.
 *
 * Extracted from the claude test to be reusable across all
 * real backend test files (codex, gemini, opencode, etc.).
 */

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { expect } from "vitest";
import { WebSocket } from "ws";
import type { SessionManager } from "../../core/session-manager.js";
import { collectMessages, waitForMessageType } from "../helpers/test-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionManagerEventPayload = { sessionId: string };
export type TestContextLike = { task?: { name?: string; result?: { state?: string } } };
export type ManagerTrace = {
  events: string[];
  stdout: string[];
  stderr: string[];
};

// ---------------------------------------------------------------------------
// Trace infrastructure
// ---------------------------------------------------------------------------

const traceByManager = new Map<SessionManager, ManagerTrace>();

export function attachTrace(manager: SessionManager): void {
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

export function getTrace(manager: SessionManager): ManagerTrace | undefined {
  return traceByManager.get(manager);
}

export function deleteTrace(manager: SessionManager): void {
  traceByManager.delete(manager);
}

// ---------------------------------------------------------------------------
// Port reservation
// ---------------------------------------------------------------------------

export function reservePort(): Promise<number> {
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

export function canBindLocalhostSync(): boolean {
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

// ---------------------------------------------------------------------------
// Manager event waiters
// ---------------------------------------------------------------------------

export function waitForManagerEvent(
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

export function waitForBackendConnectedOrExit(
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

export async function waitForSessionExited(
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

// ---------------------------------------------------------------------------
// Consumer connection helpers
// ---------------------------------------------------------------------------

export async function connectConsumerAndWaitReady(
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

export async function connectConsumerWithQuery(
  port: number,
  sessionId: string,
  query: Record<string, string>,
): Promise<WebSocket> {
  const q = new URLSearchParams(query).toString();
  const consumer = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}?${q}`);
  await new Promise<void>((resolve, reject) => {
    consumer.once("open", () => resolve());
    consumer.once("error", (err) => reject(err));
  });
  return consumer;
}

export async function connectConsumerWithQueryAndWaitReady(
  port: number,
  sessionId: string,
  query: Record<string, string>,
  expectedRole: "participant" | "observer",
): Promise<WebSocket> {
  const q = new URLSearchParams(query).toString();
  const consumer = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}?${q}`);
  const initialMessagesPromise = collectMessages(consumer, 4, 20_000);
  await new Promise<void>((resolve, reject) => {
    consumer.once("open", () => resolve());
    consumer.once("error", (err) => reject(err));
  });

  const initialMessages = await initialMessagesPromise;
  const parsed = initialMessages
    .map((raw) => {
      try {
        return JSON.parse(raw) as { type?: string; role?: string };
      } catch {
        return { type: "raw" };
      }
    })
    .filter((m) => typeof m.type === "string");

  const types = parsed.map((m) => m.type);
  expect(types).toContain("identity");
  expect(types).toContain("session_init");
  const identity = parsed.find((m) => m.type === "identity");
  expect(identity?.role).toBe(expectedRole);
  return consumer;
}

// ---------------------------------------------------------------------------
// Message assertion helpers
// ---------------------------------------------------------------------------

export function assistantTextContains(msg: unknown, token: string): boolean {
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

// ---------------------------------------------------------------------------
// AfterEach trace dump helper
// ---------------------------------------------------------------------------

export function dumpTraceOnFailure(
  context: TestContextLike,
  managers: SessionManager[],
  prefix = "real-e2e-debug",
): void {
  if (context?.task?.result?.state !== "fail") return;

  console.error(
    `[${prefix}] failed test: ${context.task?.name ?? "unknown"} managers=${managers.length}`,
  );
  for (const manager of managers) {
    const trace = getTrace(manager);
    if (!trace) continue;
    const recentEvents = trace.events.slice(-20);
    const recentStderr = trace.stderr.slice(-15);
    const recentStdout = trace.stdout.slice(-10);
    if (recentEvents.length > 0) {
      console.error(`[${prefix}] recent events:`);
      for (const line of recentEvents) console.error(`  ${line}`);
    }
    if (recentStderr.length > 0) {
      console.error(`[${prefix}] recent stderr:`);
      for (const line of recentStderr) console.error(`  ${line}`);
    }
    if (recentStdout.length > 0) {
      console.error(`[${prefix}] recent stdout:`);
      for (const line of recentStdout) console.error(`  ${line}`);
    }
  }
}

// Re-export test-utils for convenience
export { closeWebSockets, waitForMessage, waitForMessageType } from "../helpers/test-utils.js";
