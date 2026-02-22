import { WebSocket } from "ws";
import { ClaudeAdapter } from "../../adapters/claude/claude-adapter.js";
import { ClaudeLauncher } from "../../adapters/claude/claude-launcher.js";
import { MemoryStorage } from "../../adapters/memory-storage.js";
import { MockProcessManager } from "../../adapters/mock-process-manager.js";
import { NodeProcessManager } from "../../adapters/node-process-manager.js";
import { NodeWebSocketServer } from "../../adapters/node-ws-server.js";
import { SessionCoordinator } from "../../core/session-coordinator.js";
import type { Authenticator } from "../../interfaces/auth.js";
import type { ProcessManager } from "../../interfaces/process-manager.js";
import type { ProviderConfig } from "../../types/config.js";
import { isClaudeAvailable } from "../../utils/claude-detection.js";
import { getE2EProfile, isRealCliProfile } from "./e2e-profile.js";

// Prebuffer: WebSocket messages arriving before a test starts listening are
// captured in a per-socket buffer so they're not lost to race conditions.
const PREBUFFER_KEY = Symbol("e2ePrebuffer");

type BufferedWebSocket = WebSocket & { [PREBUFFER_KEY]?: string[] };

function toBuffered(ws: WebSocket): BufferedWebSocket {
  return ws as BufferedWebSocket;
}

function getPrebuffer(ws: WebSocket): string[] {
  return toBuffered(ws)[PREBUFFER_KEY] ?? [];
}

/** Attach a message prebuffer to a WebSocket so early messages aren't lost. Idempotent. */
export function attachPrebuffer(ws: WebSocket): void {
  const buffered = toBuffered(ws);
  if (buffered[PREBUFFER_KEY]) return;
  buffered[PREBUFFER_KEY] = [];
  ws.on("message", (data: Buffer | string) => {
    buffered[PREBUFFER_KEY]?.push(data.toString());
  });
}

function removeFirstRaw(prebuffer: string[], raw: string): void {
  const idx = prebuffer.indexOf(raw);
  if (idx >= 0) prebuffer.splice(idx, 1);
}

// ── Adaptive Process Manager ────────────────────────────────────────────────

/**
 * Creates a ProcessManager based on the active E2E profile and explicit env overrides.
 *
 * Priority order:
 * 1. USE_MOCK_CLI=true -> MockProcessManager
 * 2. USE_REAL_CLI=true -> NodeProcessManager
 * 3. E2E_PROFILE in {real-smoke, real-full} -> NodeProcessManager
 * 4. mock profile -> auto-detect Claude availability
 */
export function createProcessManager(): ProcessManager {
  if (process.env.USE_MOCK_CLI === "true") {
    console.log("[Test] Using MockProcessManager (forced via USE_MOCK_CLI=true)");
    return new MockProcessManager();
  }

  if (process.env.USE_REAL_CLI === "true") {
    console.log("[Test] Using NodeProcessManager (forced via USE_REAL_CLI=true)");
    return new NodeProcessManager();
  }

  const profile = getE2EProfile();
  if (isRealCliProfile(profile)) {
    console.log("[Test] Using NodeProcessManager (E2E_PROFILE=" + profile + ")");
    return new NodeProcessManager();
  }

  const claudeAvailable = isClaudeAvailable();
  if (claudeAvailable) {
    console.log("[Test] Using NodeProcessManager (Claude CLI detected)");
    return new NodeProcessManager();
  }

  console.log("[Test] Using MockProcessManager (Claude CLI not available)");
  return new MockProcessManager();
}

// ── Session Coordinator Setup ────────────────────────────────────────────────

/** Options for spinning up a test SessionCoordinator with ephemeral port. */
export interface TestSessionCoordinatorOptions {
  config?: Partial<ProviderConfig>;
  authenticator?: Authenticator;
}

/** Running test coordinator with its backing WebSocket server. */
export interface TestSessionCoordinator {
  coordinator: SessionCoordinator;
  server: NodeWebSocketServer;
}

/** Boot a SessionCoordinator on an ephemeral port with in-memory storage. */
export async function setupTestSessionCoordinator(
  options: TestSessionCoordinatorOptions = {},
): Promise<TestSessionCoordinator> {
  const server = new NodeWebSocketServer({ port: 0 });
  const processManager = createProcessManager();
  const config = { port: 0, ...options.config };
  const storage = new MemoryStorage();
  const coordinator = new SessionCoordinator({
    config,
    storage,
    server,
    adapter: new ClaudeAdapter(),
    authenticator: options.authenticator,
    launcher: new ClaudeLauncher({ processManager, config, storage }),
  });

  await coordinator.start();
  return { coordinator, server };
}

/** A launched test session with its assigned port. */
export interface TestSession {
  sessionId: string;
  port: number;
}

/** Launch a new session within a test coordinator and return its ID + port. */
export function createTestSession(testCoordinator: TestSessionCoordinator): TestSession {
  const launched = testCoordinator.coordinator.launcher.launch({ cwd: process.cwd() });
  testCoordinator.coordinator.bridge.seedSessionState(launched.sessionId, {
    cwd: launched.cwd,
    model: launched.model,
  });
  testCoordinator.coordinator.bridge.setAdapterName(launched.sessionId, "claude");
  const port = testCoordinator.server.port ?? 0;
  return { sessionId: launched.sessionId, port };
}

// ── WebSocket Helpers ────────────────────────────────────────────────────────

type ClientRole = "cli" | "consumer";

function connectWebSocketUrl(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    attachPrebuffer(ws);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function connectWebSocket(port: number, role: ClientRole, sessionId: string): Promise<WebSocket> {
  return connectWebSocketUrl(`ws://localhost:${port}/ws/${role}/${sessionId}`);
}

/** Connect a consumer WebSocket to the given session. Resolves once the socket is open. */
export function connectTestConsumer(port: number, sessionId: string): Promise<WebSocket> {
  return connectWebSocket(port, "consumer", sessionId);
}

/** Connect a CLI WebSocket to the given session. Resolves once the socket is open. */
export function connectTestCLI(port: number, sessionId: string): Promise<WebSocket> {
  return connectWebSocket(port, "cli", sessionId);
}

/** Connect a consumer WebSocket with additional query-string parameters (e.g. auth tokens). */
export function connectTestConsumerWithQuery(
  port: number,
  sessionId: string,
  query: Record<string, string>,
): Promise<WebSocket> {
  const params = new URLSearchParams(query);
  return connectWebSocketUrl(
    `ws://localhost:${port}/ws/consumer/${sessionId}?${params.toString()}`,
  );
}

// ── Message Collection ───────────────────────────────────────────────────────

/**
 * Collect `count` raw JSON messages from a WebSocket, draining the prebuffer first.
 * Resolves with whatever was collected when the timeout fires (may be fewer than `count`).
 */
export function collectMessages(ws: WebSocket, count: number, timeoutMs = 2000): Promise<string[]> {
  return new Promise((resolve) => {
    const prebuffer = getPrebuffer(ws);
    const messages: string[] = [];
    while (messages.length < count && prebuffer.length > 0) {
      const next = prebuffer.shift();
      if (next !== undefined) messages.push(next);
    }
    if (messages.length >= count) {
      resolve(messages);
      return;
    }

    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      resolve(messages);
    }, timeoutMs);

    const handler = (data: Buffer | string) => {
      const raw = data.toString();
      removeFirstRaw(prebuffer, raw);
      messages.push(raw);
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(messages);
      }
    };

    ws.on("message", handler);
  });
}

/**
 * Wait for a WebSocket message matching `predicate`. Checks the prebuffer first,
 * then listens for new arrivals. Rejects with diagnostics on timeout.
 */
export function waitForMessage(
  ws: WebSocket,
  predicate: (msg: unknown) => boolean,
  timeoutMs = 2000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const prebuffer = getPrebuffer(ws);
    for (let i = 0; i < prebuffer.length; i += 1) {
      try {
        const parsed = JSON.parse(prebuffer[i]);
        if (predicate(parsed)) {
          prebuffer.splice(i, 1);
          resolve(parsed);
          return;
        }
      } catch {
        // Ignore parse errors, keep waiting.
      }
    }

    const receivedDuringWait: string[] = [];

    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      const diagnostics = [
        `Timeout waiting for message after ${timeoutMs}ms`,
        `WebSocket readyState: ${ws.readyState}`,
        `Prebuffer (${prebuffer.length}): ${prebuffer
          .slice(-5)
          .map((m) => {
            try {
              const p = JSON.parse(m) as { type?: string };
              return p.type ?? "unknown";
            } catch {
              return "unparseable";
            }
          })
          .join(", ")}`,
        `Received during wait (${receivedDuringWait.length}): ${receivedDuringWait
          .slice(-10)
          .map((m) => {
            try {
              const p = JSON.parse(m) as { type?: string };
              return p.type ?? "unknown";
            } catch {
              return "unparseable";
            }
          })
          .join(", ")}`,
      ];
      reject(new Error(diagnostics.join("\n")));
    }, timeoutMs);

    const handler = (data: Buffer | string) => {
      try {
        const raw = data.toString();
        receivedDuringWait.push(raw);
        const parsed = JSON.parse(raw);
        if (predicate(parsed)) {
          removeFirstRaw(prebuffer, raw);
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

function hasType(type: string): (msg: unknown) => boolean {
  return (msg: unknown) =>
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    (msg as { type: string }).type === type;
}

/** Shorthand for `waitForMessage` with a type-field predicate. */
export function waitForMessageType(
  ws: WebSocket,
  type: string,
  timeoutMs = 2000,
): Promise<unknown> {
  return waitForMessage(ws, hasType(type), timeoutMs);
}

/** Extract the first text content block from an assistant-style message. Throws on bad shape. */
export function getMessageText(msg: unknown): string {
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

/** Build a mock CLI assistant message with a single text content block. */
export function mockAssistantMessage(text: string, id = "test-msg") {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-test-model",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    // parent_tool_use_id is intentionally null for test messages that are not part of a tool use chain
    parent_tool_use_id: null,
  };
}

/** Build a mock CLI system:init message for a given session. */
export function mockSystemInit(
  sessionId: string,
  options?: {
    model?: string;
    slashCommands?: string[] | Array<{ name: string; description: string; argumentHint?: string }>;
    skills?: string[];
    tools?: string[];
  },
) {
  const slashCommands = (options?.slashCommands ?? []).map((cmd) =>
    typeof cmd === "string" ? cmd : cmd.name,
  );

  return {
    type: "system",
    subtype: "init",
    model: options?.model ?? "claude-sonnet-4-5-20250929",
    session_id: sessionId,
    cwd: "/tmp/test",
    slash_commands: slashCommands,
    skills: options?.skills ?? [],
    tools: options?.tools ?? ["Bash", "Read", "Write", "Edit"],
  };
}

/** Build a mock inbound slash_command message. */
export function mockSlashCommand(command: string, requestId?: string) {
  return {
    type: "slash_command",
    command,
    ...(requestId ? { request_id: requestId } : {}),
  };
}

/** Build a mock CLI result message with optional cost and error overrides. */
export function mockResultMessage(
  sessionId: string,
  options?: { text?: string; costUsd?: number; isError?: boolean },
) {
  return {
    type: "result",
    subtype: options?.isError ? "error" : "success",
    cost_usd: options?.costUsd ?? 0.001,
    duration_ms: 500,
    duration_api_ms: 400,
    is_error: options?.isError ?? false,
    num_turns: 1,
    session_id: sessionId,
    result: options?.text ?? "",
  };
}

/** Send a message on `sender` and wait for a response of `responseType` on `receiver`. */
export function sendAndWait(
  sender: WebSocket,
  receiver: WebSocket,
  message: unknown,
  responseType: string,
  timeoutMs = 3000,
): Promise<unknown> {
  const promise = waitForMessageType(receiver, responseType, timeoutMs);
  sender.send(JSON.stringify(message));
  return promise;
}

// ── Cleanup Helpers ──────────────────────────────────────────────────────────

/** Close all provided WebSockets and wait briefly for graceful shutdown. */
export async function closeWebSockets(...sockets: WebSocket[]): Promise<void> {
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
  // Give sockets time to close gracefully
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Stop a test SessionCoordinator, swallowing errors to avoid masking test failures. */
export async function cleanupSessionCoordinator(
  testCoordinator: TestSessionCoordinator,
): Promise<void> {
  try {
    await testCoordinator.coordinator.stop();
  } catch (err) {
    console.error("Error stopping session coordinator:", err);
  }
}
