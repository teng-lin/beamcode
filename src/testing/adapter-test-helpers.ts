/**
 * Shared adapter-path test helpers.
 *
 * Extracted from session-bridge-adapter.test.ts so that migrated test files
 * can use the adapter path (MockBackendAdapter + MockBackendSession) without
 * duplicating ~200 lines of boilerplate.
 *
 * Two layers:
 * - Layer 1 (plumbing): createMessageChannel, MockBackendSession, MockBackendAdapter, tick
 * - Layer 2 (scenario): setupInitializedSession, translateAndPush
 */

import { translate } from "../adapters/claude/message-translator.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../core/interfaces/backend-adapter.js";
import { SessionBridge } from "../core/session-bridge.js";
import type { UnifiedMessage } from "../core/types/unified-message.js";
import { createUnifiedMessage } from "../core/types/unified-message.js";
import type { CLIMessage } from "../types/cli-messages.js";

// ─── Layer 1: Plumbing ──────────────────────────────────────────────────────

export function createMessageChannel() {
  const queue: UnifiedMessage[] = [];
  let resolve: ((value: IteratorResult<UnifiedMessage>) => void) | null = null;
  let done = false;

  return {
    push(msg: UnifiedMessage) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },
    close() {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<UnifiedMessage> {
      return {
        next(): Promise<IteratorResult<UnifiedMessage>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((r) => {
            resolve = r;
          });
        },
      };
    },
  };
}

export class MockBackendSession implements BackendSession {
  readonly sessionId: string;
  readonly channel = createMessageChannel();
  readonly sentMessages: UnifiedMessage[] = [];
  readonly sentRawMessages: string[] = [];
  private _closed = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  send(message: UnifiedMessage): void {
    if (this._closed) throw new Error("Session is closed");
    this.sentMessages.push(message);
  }

  sendRaw(ndjson: string): void {
    if (this._closed) throw new Error("Session is closed");
    this.sentRawMessages.push(ndjson);
  }

  get messages(): AsyncIterable<UnifiedMessage> {
    return this.channel;
  }

  async close(): Promise<void> {
    this._closed = true;
    this.channel.close();
  }

  get closed() {
    return this._closed;
  }

  /** Push a message into the channel (simulating backend → bridge). */
  pushMessage(msg: UnifiedMessage) {
    this.channel.push(msg);
  }
}

export class MockBackendAdapter implements BackendAdapter {
  readonly name = "mock";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: false,
  };

  private sessions = new Map<string, MockBackendSession>();
  private _shouldFail = false;

  setShouldFail(fail: boolean) {
    this._shouldFail = fail;
  }

  async connect(options: ConnectOptions): Promise<BackendSession> {
    if (this._shouldFail) {
      throw new Error("Connection failed");
    }
    const session = new MockBackendSession(options.sessionId);
    this.sessions.set(options.sessionId, session);
    return session;
  }

  getSession(id: string): MockBackendSession | undefined {
    return this.sessions.get(id);
  }
}

/** Wait for async operations (message channel push → for-await → handlers). */
export function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Layer 2: Scenario Helpers ──────────────────────────────────────────────

export const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Create a SessionBridge wired with a MockBackendAdapter.
 * Returns the bridge, storage, and adapter for test assertions.
 */
export function createBridgeWithAdapter(options?: {
  storage?: MemoryStorage;
  adapter?: BackendAdapter;
  config?: Record<string, unknown>;
}) {
  const storage = options?.storage ?? new MemoryStorage();
  const adapter = options?.adapter ?? new MockBackendAdapter();
  const bridge = new SessionBridge({
    storage,
    config: { port: 3456, ...options?.config },
    logger: noopLogger,
    adapter,
  });
  return { bridge, storage, adapter: adapter as MockBackendAdapter };
}

/**
 * Connect a session via the adapter path and push a session_init message.
 * Returns the backend session ready for pushing more messages.
 */
export async function setupInitializedSession(
  bridge: SessionBridge,
  adapter: MockBackendAdapter,
  sessionId = "sess-1",
): Promise<MockBackendSession> {
  await bridge.connectBackend(sessionId);
  const backendSession = adapter.getSession(sessionId)!;
  backendSession.pushMessage(makeSessionInitMsg());
  await tick();
  return backendSession;
}

/**
 * Translate an NDJSON string (from CLI message factories) into a UnifiedMessage
 * and push it to the backend session. Returns the translated message.
 */
export function translateAndPush(
  backendSession: MockBackendSession,
  ndjsonString: string,
): UnifiedMessage | null {
  const parsed = JSON.parse(ndjsonString) as CLIMessage;
  const unified = translate(parsed);
  if (unified) {
    backendSession.pushMessage(unified);
  }
  return unified;
}

// ─── UnifiedMessage Factory Helpers ─────────────────────────────────────────

export function makeSessionInitMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "session_init",
    role: "system",
    metadata: {
      session_id: "backend-123",
      model: "claude-sonnet-4-5-20250929",
      cwd: "/test",
      tools: ["Bash", "Read"],
      permissionMode: "default",
      claude_code_version: "1.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      ...overrides,
    },
  });
}

export function makeStatusChangeMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "status_change",
    role: "system",
    metadata: { status: null, ...overrides },
  });
}

export function makeAssistantUnifiedMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "assistant",
    role: "assistant",
    content: [{ type: "text", text: "Hello world" }],
    metadata: {
      message_id: "msg-1",
      model: "claude-sonnet-4-5-20250929",
      stop_reason: "end_turn",
      parent_tool_use_id: null,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...overrides,
    },
  });
}

export function makeResultUnifiedMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "result",
    role: "system",
    metadata: {
      subtype: "success",
      is_error: false,
      result: "Done",
      duration_ms: 1000,
      duration_api_ms: 800,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...overrides,
    },
  });
}

export function makeStreamEventUnifiedMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "stream_event",
    role: "system",
    metadata: {
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      parent_tool_use_id: null,
      ...overrides,
    },
  });
}

export function makePermissionRequestUnifiedMsg(
  overrides: Record<string, unknown> = {},
): UnifiedMessage {
  return createUnifiedMessage({
    type: "permission_request",
    role: "system",
    metadata: {
      request_id: "perm-req-1",
      tool_name: "Bash",
      input: { command: "ls" },
      tool_use_id: "tu-1",
      ...overrides,
    },
  });
}

export function makeToolProgressUnifiedMsg(
  overrides: Record<string, unknown> = {},
): UnifiedMessage {
  return createUnifiedMessage({
    type: "tool_progress",
    role: "system",
    metadata: {
      tool_use_id: "tu-1",
      tool_name: "Bash",
      elapsed_time_seconds: 5,
      ...overrides,
    },
  });
}

export function makeToolUseSummaryUnifiedMsg(
  overrides: Record<string, unknown> = {},
): UnifiedMessage {
  return createUnifiedMessage({
    type: "tool_use_summary",
    role: "system",
    metadata: {
      summary: "Ran bash command",
      tool_use_ids: ["tu-1", "tu-2"],
      ...overrides,
    },
  });
}

export function makeAuthStatusUnifiedMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "auth_status",
    role: "system",
    metadata: {
      isAuthenticating: true,
      output: ["Authenticating..."],
      ...overrides,
    },
  });
}

export function makeControlResponseUnifiedMsg(
  overrides: Record<string, unknown> = {},
): UnifiedMessage {
  return createUnifiedMessage({
    type: "control_response",
    role: "system",
    metadata: {
      request_id: "test-uuid",
      subtype: "success",
      response: {
        commands: [{ name: "/help", description: "Get help" }],
        models: [{ value: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5" }],
        account: { email: "test@example.com" },
      },
      ...overrides,
    },
  });
}
