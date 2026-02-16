import { WebSocket } from "ws";
import { MemoryStorage } from "../../adapters/memory-storage.js";
import { MockProcessManager } from "../../adapters/mock-process-manager.js";
import { NodeProcessManager } from "../../adapters/node-process-manager.js";
import { NodeWebSocketServer } from "../../adapters/node-ws-server.js";
import { SessionManager } from "../../core/session-manager.js";
import type { ProcessManager } from "../../interfaces/process-manager.js";
import type { ProviderConfig } from "../../types/config.js";
import { isClaudeAvailable } from "../../utils/claude-detection.js";

// ── Adaptive Process Manager ────────────────────────────────────────────────

/**
 * Creates a ProcessManager that adapts based on environment:
 * - Returns MockProcessManager if:
 *   - USE_MOCK_CLI=true is set (forced mock mode)
 *   - Claude CLI is not available (auto-detect)
 * - Returns NodeProcessManager if:
 *   - USE_REAL_CLI=true is set (forced real mode)
 *   - Claude CLI is available and no forced mode is set
 *
 * This allows e2e tests to run in CI environments without Claude CLI,
 * while still testing with real CLI when available locally.
 */
export function createProcessManager(): ProcessManager {
  // Check for forced mock/real mode via environment variables
  if (process.env.USE_MOCK_CLI === "true") {
    console.log("[Test] Using MockProcessManager (forced via USE_MOCK_CLI=true)");
    return new MockProcessManager();
  }

  if (process.env.USE_REAL_CLI === "true") {
    console.log("[Test] Using NodeProcessManager (forced via USE_REAL_CLI=true)");
    return new NodeProcessManager();
  }

  // Auto-detect: use real CLI if available, mock otherwise
  const claudeAvailable = isClaudeAvailable();

  if (claudeAvailable) {
    console.log("[Test] Using NodeProcessManager (Claude CLI detected)");
    return new NodeProcessManager();
  }

  console.log("[Test] Using MockProcessManager (Claude CLI not available)");
  return new MockProcessManager();
}

// ── Session Manager Setup ────────────────────────────────────────────────────

export interface TestSessionManagerOptions {
  config?: Partial<ProviderConfig>;
}

export interface TestSessionManager {
  manager: SessionManager;
  server: NodeWebSocketServer;
}

export async function setupTestSessionManager(
  options: TestSessionManagerOptions = {},
): Promise<TestSessionManager> {
  const server = new NodeWebSocketServer({ port: 0 });
  const manager = new SessionManager({
    config: { port: 0, ...options.config },
    processManager: createProcessManager(),
    storage: new MemoryStorage(),
    server,
  });

  await manager.start();
  return { manager, server };
}

export interface TestSession {
  sessionId: string;
  port: number;
}

export function createTestSession(testManager: TestSessionManager): TestSession {
  const { sessionId } = testManager.manager.launcher.launch({ cwd: process.cwd() });
  const port = testManager.server.port ?? 0;
  return { sessionId, port };
}

// ── WebSocket Helpers ────────────────────────────────────────────────────────

type ClientRole = "cli" | "consumer";

function connectWebSocket(port: number, role: ClientRole, sessionId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/${role}/${sessionId}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

export function connectTestConsumer(port: number, sessionId: string): Promise<WebSocket> {
  return connectWebSocket(port, "consumer", sessionId);
}

export function connectTestCLI(port: number, sessionId: string): Promise<WebSocket> {
  return connectWebSocket(port, "cli", sessionId);
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

export function drainInitialMessages(ws: WebSocket, count = 2, timeoutMs = 500): Promise<string[]> {
  return collectMessages(ws, count, timeoutMs);
}

export function hasType(type: string): (msg: unknown) => boolean {
  return (msg: unknown) =>
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    (msg as { type: string }).type === type;
}

export function waitForMessageType(
  ws: WebSocket,
  type: string,
  timeoutMs = 2000,
): Promise<unknown> {
  return waitForMessage(ws, hasType(type), timeoutMs);
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

export function getMessageText(msg: unknown): string {
  // Validate the message structure before accessing nested properties
  if (typeof msg !== "object" || msg === null) {
    throw new Error(`Expected object, got ${typeof msg}. Raw message: ${JSON.stringify(msg)}`);
  }

  const msgObj = msg as Record<string, unknown>;

  if (!("message" in msgObj) || typeof msgObj.message !== "object" || msgObj.message === null) {
    throw new Error(`Message missing 'message' property. Raw message: ${JSON.stringify(msg)}`);
  }

  const message = msgObj.message as Record<string, unknown>;

  if (!("content" in message) || !Array.isArray(message.content) || message.content.length === 0) {
    throw new Error(`Message missing valid 'content' array. Raw message: ${JSON.stringify(msg)}`);
  }

  const firstContent = message.content[0];

  if (typeof firstContent !== "object" || firstContent === null || !("text" in firstContent)) {
    throw new Error(`Content[0] missing 'text' property. Raw message: ${JSON.stringify(msg)}`);
  }

  const text = (firstContent as { text: unknown }).text;

  if (typeof text !== "string") {
    throw new Error(
      `Expected text to be string, got ${typeof text}. Raw message: ${JSON.stringify(msg)}`,
    );
  }

  return text;
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

export async function cleanupSessionManager(testManager: TestSessionManager): Promise<void> {
  try {
    await testManager.manager.stop();
  } catch (err) {
    console.error("Error stopping session manager:", err);
  }
}
