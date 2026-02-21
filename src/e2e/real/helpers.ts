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
import type { SessionCoordinator } from "../../core/session-coordinator.js";
import { attachPrebuffer, collectMessages, waitForMessageType } from "../helpers/test-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionCoordinatorEventPayload = { sessionId: string };
export type TestContextLike = { task?: { name?: string; result?: { state?: string } } };
export type CoordinatorTrace = {
  events: string[];
  stdout: string[];
  stderr: string[];
};

// ---------------------------------------------------------------------------
// Trace infrastructure
// ---------------------------------------------------------------------------

const traceByCoordinator = new Map<SessionCoordinator, CoordinatorTrace>();

export function attachTrace(coordinator: SessionCoordinator): void {
  if (traceByCoordinator.has(coordinator)) return;
  const trace: CoordinatorTrace = { events: [], stdout: [], stderr: [] };
  const stamp = () => new Date().toISOString();
  coordinator.on("process:spawned", ({ sessionId, pid }) => {
    trace.events.push(`${stamp()} process:spawned session=${sessionId} pid=${pid}`);
  });
  coordinator.on("process:exited", ({ sessionId, exitCode, uptimeMs }) => {
    trace.events.push(
      `${stamp()} process:exited session=${sessionId} code=${exitCode} uptimeMs=${uptimeMs}`,
    );
  });
  coordinator.on("backend:connected", ({ sessionId }) => {
    trace.events.push(`${stamp()} backend:connected session=${sessionId}`);
  });
  coordinator.on("backend:disconnected", ({ sessionId, reason }) => {
    trace.events.push(`${stamp()} backend:disconnected session=${sessionId} reason=${reason}`);
  });
  coordinator.on("capabilities:ready", ({ sessionId }) => {
    trace.events.push(`${stamp()} capabilities:ready session=${sessionId}`);
  });
  coordinator.on("error", ({ source, sessionId, error }) => {
    trace.events.push(
      `${stamp()} error source=${source} session=${sessionId ?? "n/a"} msg=${String(error)}`,
    );
  });
  coordinator.on("process:stdout", ({ data }) => {
    trace.stdout.push(data.trim());
    if (trace.stdout.length > 40) trace.stdout.splice(0, trace.stdout.length - 40);
  });
  coordinator.on("process:stderr", ({ data }) => {
    trace.stderr.push(data.trim());
    if (trace.stderr.length > 40) trace.stderr.splice(0, trace.stderr.length - 40);
  });
  traceByCoordinator.set(coordinator, trace);
}

function getTrace(coordinator: SessionCoordinator): CoordinatorTrace | undefined {
  return traceByCoordinator.get(coordinator);
}

export function deleteTrace(coordinator: SessionCoordinator): void {
  traceByCoordinator.delete(coordinator);
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
// Coordinator event waiters
// ---------------------------------------------------------------------------

export function waitForCoordinatorEvent(
  coordinator: SessionCoordinator,
  eventName: "process:spawned" | "backend:connected" | "backend:session_id" | "capabilities:ready",
  sessionId: string,
  isSatisfied: () => boolean,
  timeoutMs = 45_000,
): Promise<SessionCoordinatorEventPayload> {
  if (isSatisfied()) {
    return Promise.resolve({ sessionId });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      coordinator.off(eventName, handler);
      reject(new Error(`Timed out waiting for ${eventName} for session ${sessionId}`));
    }, timeoutMs);

    const handler = (payload: unknown) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "sessionId" in payload &&
        (payload as SessionCoordinatorEventPayload).sessionId === sessionId
      ) {
        if (!isSatisfied()) return;
        clearTimeout(timer);
        coordinator.off(eventName, handler);
        resolve(payload as SessionCoordinatorEventPayload);
      }
    };

    coordinator.on(eventName, handler);
  });
}

export function waitForBackendConnectedOrExit(
  coordinator: SessionCoordinator,
  sessionId: string,
  timeoutMs = 20_000,
): Promise<void> {
  if (coordinator.bridge.isBackendConnected(sessionId)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onConnected = (payload: unknown) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "sessionId" in payload &&
        (payload as SessionCoordinatorEventPayload).sessionId === sessionId &&
        coordinator.bridge.isBackendConnected(sessionId)
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
        (payload as SessionCoordinatorEventPayload).sessionId === sessionId
      ) {
        const info = coordinator.launcher.getSession(sessionId);
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
      if (coordinator.bridge.isBackendConnected(sessionId)) {
        cleanup();
        resolve();
        return;
      }
      const info = coordinator.launcher.getSession(sessionId);
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
      coordinator.off("backend:connected", onConnected);
      coordinator.off("process:exited", onExited);
    };

    coordinator.on("backend:connected", onConnected);
    coordinator.on("process:exited", onExited);
  });
}

export async function waitForSessionExited(
  coordinator: SessionCoordinator,
  sessionId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (coordinator.launcher.getSession(sessionId)?.state === "exited") {
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
  attachPrebuffer(consumer);
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

export async function connectConsumerWithQueryAndWaitReady(
  port: number,
  sessionId: string,
  query: Record<string, string>,
  expectedRole: "participant" | "observer",
): Promise<WebSocket> {
  const q = new URLSearchParams(query).toString();
  const consumer = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}?${q}`);
  attachPrebuffer(consumer);
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
  coordinators: SessionCoordinator[],
  prefix = "real-e2e-debug",
): void {
  if (context?.task?.result?.state !== "fail") return;

  console.error(
    `[${prefix}] failed test: ${context.task?.name ?? "unknown"} coordinators=${coordinators.length}`,
  );
  for (const coordinator of coordinators) {
    // Dump session state for each active session
    for (const info of coordinator.launcher.listSessions()) {
      const connected = coordinator.bridge.isBackendConnected(info.sessionId);
      const snapshot = coordinator.bridge.getSession(info.sessionId);
      console.error(
        `[${prefix}] session=${info.sessionId} backendConnected=${connected} ` +
          `launcherState=${info.state} exitCode=${info.exitCode ?? "n/a"} ` +
          `pid=${info.pid ?? "n/a"} lastStatus=${snapshot?.lastStatus ?? "n/a"} ` +
          `cliConnected=${snapshot?.cliConnected ?? "n/a"} ` +
          `consumerCount=${snapshot?.consumerCount ?? "n/a"} ` +
          `messageHistoryLen=${snapshot?.messageHistoryLength ?? "n/a"}`,
      );
    }

    const trace = getTrace(coordinator);
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
