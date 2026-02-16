import { WebSocket } from "ws";
import { MemoryStorage } from "../../adapters/memory-storage.js";
import { NodeProcessManager } from "../../adapters/node-process-manager.js";
import { NodeWebSocketServer } from "../../adapters/node-ws-server.js";
import { SessionManager } from "../../core/session-manager.js";
import type { ProviderConfig } from "../../types/config.js";

// ── Session Manager Setup ────────────────────────────────────────────────────

export interface TestSessionManagerOptions {
  config?: Partial<ProviderConfig>;
}

export async function setupTestSessionManager(
  options: TestSessionManagerOptions = {},
): Promise<SessionManager> {
  const manager = new SessionManager({
    config: { port: 0, ...options.config },
    processManager: new NodeProcessManager(),
    storage: new MemoryStorage(),
    server: new NodeWebSocketServer({ port: 0 }),
  });

  await manager.start();
  return manager;
}

export interface TestSession {
  sessionId: string;
  port: number;
}

export function createTestSession(manager: SessionManager): TestSession {
  const { sessionId } = manager.launcher.launch({ cwd: process.cwd() });
  const port = manager.bridge.config.port;
  return { sessionId, port };
}

// ── WebSocket Helpers ────────────────────────────────────────────────────────

export async function connectTestConsumer(port: number, sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  return ws;
}

export async function connectTestCLI(port: number, sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/ws/cli/${sessionId}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  return ws;
}

// ── Message Collection ───────────────────────────────────────────────────────

export function collectMessages(ws: WebSocket, count: number, timeoutMs = 2000): Promise<string[]> {
  return new Promise((resolve) => {
    const messages: string[] = [];
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      resolve(messages);
    }, timeoutMs);

    const handler = (data: Buffer | string) => {
      messages.push(data.toString());
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(messages);
      }
    };

    ws.on("message", handler);
  });
}

export function waitForMessage(
  ws: WebSocket,
  predicate: (msg: unknown) => boolean,
  timeoutMs = 2000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error(`Timeout waiting for message after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (data: Buffer | string) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (predicate(parsed)) {
          clearTimeout(timer);
          ws.removeListener("message", handler);
          resolve(parsed);
        }
      } catch {
        // Ignore parse errors, keep waiting
      }
    };

    ws.on("message", handler);
  });
}

export async function drainInitialMessages(
  ws: WebSocket,
  count = 2,
  timeoutMs = 500,
): Promise<string[]> {
  return collectMessages(ws, count, timeoutMs);
}

// ── Assertion Helpers ────────────────────────────────────────────────────────

export function assertValidSessionId(sessionId: string): void {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuidRegex.test(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
}

export function parseMessages(messages: string[]): unknown[] {
  return messages.map((m) => {
    try {
      return JSON.parse(m);
    } catch {
      return { _raw: m };
    }
  });
}

export function extractMessageTypes(messages: string[]): string[] {
  return parseMessages(messages)
    .filter((m) => typeof m === "object" && m !== null && "type" in m)
    .map((m) => (m as { type: string }).type);
}

// ── Mock Data Generators ─────────────────────────────────────────────────────

export function mockAssistantMessage(text: string, id = "test-msg") {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
  };
}

export function mockUserMessage(content: string) {
  return {
    type: "user_message",
    content,
    timestamp: Date.now(),
  };
}

export function mockPermissionRequest(toolName: string, params: unknown, requestId = "perm-123") {
  return {
    type: "permission_request",
    request_id: requestId,
    tool_name: toolName,
    params,
  };
}

// ── Cleanup Helpers ──────────────────────────────────────────────────────────

export async function closeWebSockets(...sockets: WebSocket[]): Promise<void> {
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
  // Give sockets time to close gracefully
  await new Promise((resolve) => setTimeout(resolve, 50));
}

export async function cleanupSessionManager(manager: SessionManager): Promise<void> {
  try {
    await manager.stop();
  } catch (err) {
    console.error("Error stopping session manager:", err);
  }
}
