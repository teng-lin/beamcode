/**
 * Shared e2e test utilities for backend adapter tests.
 *
 * Extracts and enhances mock patterns from the individual compliance tests
 * so that all adapter e2e tests can share the same infrastructure.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type {
  SDKMessage,
  SDKUserMessage,
} from "../../adapters/agent-sdk/sdk-message-translator.js";
import type { BackendSession } from "../../core/interfaces/backend-adapter.js";
import type { UnifiedMessage, UnifiedMessageType } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { ProcessHandle, ProcessManager } from "../../interfaces/process-manager.js";

// ---------------------------------------------------------------------------
// MessageReader — wraps a single iterator for consistent sequential reads
// ---------------------------------------------------------------------------

/**
 * Wraps a BackendSession's message stream in a single shared iterator.
 *
 * Important: AcpSession creates independent state (queue + listeners) per
 * iterator. Creating multiple iterators via repeated `for await` leads to
 * duplicate messages. MessageReader ensures a single iterator is reused.
 */
export class MessageReader {
  private readonly iter: AsyncIterator<UnifiedMessage>;

  constructor(session: BackendSession) {
    this.iter = session.messages[Symbol.asyncIterator]();
  }

  /** Collect N messages from the stream. */
  async collect(count: number, timeoutMs = 5000): Promise<UnifiedMessage[]> {
    const collected: UnifiedMessage[] = [];
    for (let i = 0; i < count; i++) {
      const result = await Promise.race([
        this.iter.next(),
        new Promise<IteratorResult<UnifiedMessage>>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), timeoutMs),
        ),
      ]);
      if (result.done) break;
      collected.push(result.value);
    }
    return collected;
  }

  /** Wait for a specific message type, collecting all messages along the way. */
  async waitFor(
    type: UnifiedMessageType,
    timeoutMs = 5000,
  ): Promise<{ target: UnifiedMessage; collected: UnifiedMessage[] }> {
    const collected: UnifiedMessage[] = [];

    while (true) {
      const result = await Promise.race([
        this.iter.next(),
        new Promise<IteratorResult<UnifiedMessage>>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), timeoutMs),
        ),
      ]);

      if (result.done) {
        throw new Error(
          `Stream ended/timed out without message type "${type}". Got: [${collected.map((m) => m.type).join(", ")}]`,
        );
      }

      collected.push(result.value);
      if (result.value.type === type) {
        return { target: result.value, collected };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Generic UnifiedMessage helpers (convenience wrappers using fresh iterators)
// ---------------------------------------------------------------------------

/**
 * Collect N UnifiedMessages from a BackendSession's message stream.
 * Creates a new iterator — suitable for sessions with shared queues
 * (AgentSdkSession, CodexSession) but NOT for AcpSession (use MessageReader).
 */
export function collectUnifiedMessages(
  session: BackendSession,
  count: number,
  timeoutMs = 5000,
): Promise<UnifiedMessage[]> {
  const reader = new MessageReader(session);
  return reader.collect(count, timeoutMs);
}

/**
 * Wait for a specific UnifiedMessage type from a BackendSession's message stream.
 * Creates a new iterator — suitable for sessions with shared queues
 * (AgentSdkSession, CodexSession) but NOT for AcpSession (use MessageReader).
 */
export function waitForUnifiedMessageType(
  session: BackendSession,
  type: UnifiedMessageType,
  timeoutMs = 5000,
): Promise<{ target: UnifiedMessage; collected: UnifiedMessage[] }> {
  const reader = new MessageReader(session);
  return reader.waitFor(type, timeoutMs);
}

// ---------------------------------------------------------------------------
// ACP mock helpers
// ---------------------------------------------------------------------------

export class MockStream extends EventEmitter {
  readonly chunks: string[] = [];

  write(data: string): boolean {
    this.chunks.push(data);
    return true;
  }
}

export function createMockChild() {
  const stdin = new MockStream();
  const stdout = new MockStream();
  const stderr = new MockStream();
  const child = new EventEmitter() as ChildProcess;

  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    killed: false,
    kill: vi.fn((_signal?: string) => {
      (child as unknown as { killed: boolean }).killed = true;
      child.emit("exit", 0, null);
      return true;
    }),
  });

  return { child, stdin, stdout, stderr };
}

export function respondToRequest(stdout: MockStream, id: number, result: unknown) {
  const response = `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
  stdout.emit("data", Buffer.from(response));
}

export function sendNotification(stdout: MockStream, method: string, params: unknown) {
  const notification = `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
  stdout.emit("data", Buffer.from(notification));
}

export function sendJsonRpcRequest(
  stdout: MockStream,
  id: number,
  method: string,
  params: unknown,
) {
  const request = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
  stdout.emit("data", Buffer.from(request));
}

/**
 * Auto-responder for ACP e2e tests.
 * Watches stdin for JSON-RPC requests and responds to:
 * - initialize handshake
 * - session/new and session/load
 * - session/prompt with scripted responses
 */
export function createAcpAutoResponder(
  stdin: MockStream,
  stdout: MockStream,
  options?: {
    onPrompt?: (parsed: { id: number; params: unknown }) => void;
    promptResponses?: Array<() => void>;
  },
) {
  let promptIndex = 0;
  const origWrite = stdin.write.bind(stdin);

  stdin.write = (data: string): boolean => {
    origWrite(data);
    try {
      const parsed = JSON.parse(data.trim());
      if (parsed.method === "initialize") {
        setTimeout(
          () =>
            respondToRequest(stdout, parsed.id, {
              protocolVersion: 1,
              agentCapabilities: { streaming: true },
              agentInfo: { name: "e2e-agent", version: "1.0" },
            }),
          0,
        );
      } else if (parsed.method === "session/new" || parsed.method === "session/load") {
        const sessionId = parsed.params?.sessionId ?? "e2e-session";
        setTimeout(() => respondToRequest(stdout, parsed.id, { sessionId }), 0);
      } else if (parsed.method === "session/prompt") {
        if (options?.onPrompt) {
          setTimeout(() => options.onPrompt?.(parsed), 0);
        } else if (options?.promptResponses && promptIndex < options.promptResponses.length) {
          const responder = options.promptResponses[promptIndex++];
          setTimeout(responder, 0);
        }
      }
    } catch {
      // ignore non-JSON
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// Codex mock helpers
// ---------------------------------------------------------------------------

export class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.emit("close");
  }
}

export function createMockProcessManager(): ProcessManager {
  const exitPromise = new Promise<number | null>(() => {});
  return {
    spawn: vi.fn().mockReturnValue({
      pid: 12345,
      exited: exitPromise,
      kill: vi.fn(),
      stdout: null,
      stderr: null,
    } satisfies ProcessHandle),
    isAlive: vi.fn().mockReturnValue(true),
  };
}

export function sendCodexNotification(ws: MockWebSocket, method: string, params: unknown) {
  ws.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params })));
}

export function sendCodexResponse(ws: MockWebSocket, id: number, result: unknown) {
  ws.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result })));
}

// ---------------------------------------------------------------------------
// Agent SDK mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a query function that yields scripted SDK messages.
 * Each call to the query function consumes the next batch from the script.
 */
export function createScriptedQueryFn(batches: SDKMessage[][]): {
  queryFn: (options: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Record<string, unknown>;
  }) => AsyncIterable<SDKMessage>;
  calls: Array<{
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Record<string, unknown>;
  }>;
} {
  let batchIndex = 0;
  const calls: Array<{
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Record<string, unknown>;
  }> = [];

  const queryFn = (options: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Record<string, unknown>;
  }) => {
    calls.push(options);
    const messages = batches[batchIndex++] ?? [];

    return {
      async *[Symbol.asyncIterator]() {
        // Consume the prompt to avoid hanging the input stream
        if (typeof options.prompt !== "string") {
          const iter = (options.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
          await iter.next();
        }
        for (const msg of messages) {
          yield msg;
        }
      },
    };
  };

  return { queryFn, calls };
}

/**
 * Create a query function that calls canUseTool for permission testing.
 */
export function createPermissionQueryFn(
  toolName: string,
  toolInput: Record<string, unknown>,
  onResult: (decision: { behavior: string }) => SDKMessage[],
): (options: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Record<string, unknown>;
}) => AsyncIterable<SDKMessage> {
  return (options) => ({
    async *[Symbol.asyncIterator]() {
      // Consume the prompt
      if (typeof options.prompt !== "string") {
        const iter = (options.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        await iter.next();
      }

      const canUseTool = options.options?.canUseTool as
        | ((name: string, input: Record<string, unknown>) => Promise<{ behavior: string }>)
        | undefined;

      if (canUseTool) {
        const decision = await canUseTool(toolName, toolInput);
        const messages = onResult(decision);
        for (const msg of messages) {
          yield msg;
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// UnifiedMessage factories for tests
// ---------------------------------------------------------------------------

export function createUserMessage(text: string, sessionId = "e2e-session"): UnifiedMessage {
  return createUnifiedMessage({
    type: "user_message",
    role: "user",
    content: [{ type: "text", text }],
    metadata: { sessionId, session_id: sessionId },
  });
}

export function createPermissionResponse(
  behavior: "allow" | "deny",
  requestId: string,
  metadata?: Record<string, unknown>,
): UnifiedMessage {
  return createUnifiedMessage({
    type: "permission_response",
    role: "user",
    metadata: { behavior, requestId, ...metadata },
  });
}

export function createInterruptMessage(): UnifiedMessage {
  return createUnifiedMessage({
    type: "interrupt",
    role: "user",
  });
}

// ---------------------------------------------------------------------------
// Gemini A2A mock helpers
// ---------------------------------------------------------------------------

/** Build an SSE string from event objects. */
export function makeSSE(...events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/** Build a Response with an SSE body. */
export function sseResponse(body: string, contentType = "text/event-stream"): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

export function buildA2ATaskEvent(taskId = "task-1") {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "task",
      id: taskId,
      contextId: "ctx-1",
      status: { state: "submitted", timestamp: new Date().toISOString() },
    },
  };
}

export function buildA2ATextEvent(text = "hello", taskId = "task-1") {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId,
      contextId: "ctx-1",
      status: {
        state: "working",
        message: {
          kind: "message",
          role: "agent",
          parts: [{ kind: "text", text }],
          messageId: "msg-1",
        },
      },
      metadata: { coderAgent: { kind: "text-content" } },
    },
  };
}

export function buildA2ACompletedEvent(taskId = "task-1") {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId,
      contextId: "ctx-1",
      status: { state: "completed" },
      final: true,
      metadata: { coderAgent: { kind: "state-change" } },
    },
  };
}

export function buildA2AInputRequiredEvent(taskId = "task-1") {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId,
      contextId: "ctx-1",
      status: { state: "input-required" },
      final: true,
      metadata: { coderAgent: { kind: "state-change" } },
    },
  };
}

export function buildA2AToolConfirmationEvent(
  toolCallId: string,
  toolName: string,
  taskId = "task-1",
) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId,
      contextId: "ctx-1",
      status: {
        state: "working",
        message: {
          kind: "message",
          role: "agent",
          parts: [
            {
              kind: "data",
              data: {
                tool_call_id: toolCallId,
                tool_name: toolName,
                status: "PENDING",
                description: `Confirm ${toolName}`,
                confirmation_request: {
                  options: [
                    { id: "proceed_once", name: "Allow once" },
                    { id: "reject", name: "Deny" },
                  ],
                },
              },
            },
          ],
          messageId: "msg-tool-1",
        },
      },
      metadata: { coderAgent: { kind: "tool-call-confirmation" } },
    },
  };
}

// ---------------------------------------------------------------------------
// Opencode mock helpers
// ---------------------------------------------------------------------------

import type { OpencodeHttpClient } from "../../adapters/opencode/opencode-http-client.js";
import type { OpencodeEvent } from "../../adapters/opencode/opencode-types.js";

export function createMockOpencodeHttpClient() {
  return {
    promptAsync: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    replyPermission: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn(),
    health: vi.fn(),
    connectSse: vi.fn(),
  } as unknown as OpencodeHttpClient & {
    promptAsync: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    replyPermission: ReturnType<typeof vi.fn>;
  };
}

export function createMockOpencodeSubscribe(): {
  subscribe: (h: (event: OpencodeEvent) => void) => () => void;
  push: (event: OpencodeEvent) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let handler: ((event: OpencodeEvent) => void) | null = null;
  const unsubscribe = vi.fn();

  const subscribe = (h: (event: OpencodeEvent) => void) => {
    handler = h;
    return unsubscribe;
  };

  const push = (event: OpencodeEvent) => {
    if (handler) handler(event);
  };

  return { subscribe, push, unsubscribe };
}

export function buildOpencodeTextPartEvent(
  text: string,
  delta: string,
  options?: { partId?: string; messageId?: string; sessionId?: string },
): OpencodeEvent {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "text",
        id: options?.partId ?? "p-1",
        messageID: options?.messageId ?? "m-1",
        sessionID: options?.sessionId ?? "opc-session-1",
        text,
        time: { created: 0, updated: 0 },
      },
      delta,
    },
  };
}

export function buildOpencodeIdleEvent(sessionId = "opc-session-1"): OpencodeEvent {
  return {
    type: "session.status",
    properties: {
      sessionID: sessionId,
      status: { type: "idle" },
    },
  };
}

export function buildOpencodeBusyEvent(sessionId = "opc-session-1"): OpencodeEvent {
  return {
    type: "session.status",
    properties: {
      sessionID: sessionId,
      status: { type: "busy" },
    },
  };
}

export function buildOpencodePermissionEvent(
  permId: string,
  permission: string,
  options?: { sessionId?: string; title?: string },
): OpencodeEvent {
  return {
    type: "permission.updated",
    properties: {
      id: permId,
      sessionID: options?.sessionId ?? "opc-session-1",
      permission,
      title: options?.title ?? `Confirm ${permission}`,
    },
  };
}

export function buildOpencodeConnectedEvent(): OpencodeEvent {
  return {
    type: "server.connected",
    properties: {} as Record<string, never>,
  };
}
