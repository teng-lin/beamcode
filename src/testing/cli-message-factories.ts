/**
 * Shared CLI message factories and test helpers.
 *
 * Extracted from session-bridge.test.ts so that new component-level test files
 * (session-store, consumer-broadcaster, consumer-gatekeeper) can reuse them
 * without duplicating ~200 lines of boilerplate.
 *
 * NOTE: vi.mock("node:crypto") CANNOT be shared — vitest hoists mocks per-file.
 * Each test file that needs it must declare its own vi.mock().
 */

import { vi } from "vitest";
import type { Session } from "../core/session-store.js";
import { makeDefaultState } from "../core/session-store.js";
import type { AuthContext, ConsumerIdentity } from "../interfaces/auth.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import type { PermissionRequest } from "../types/cli-messages.js";
import type { ConsumerMessage } from "../types/consumer-messages.js";

// ─── Socket / Logger / AuthContext ──────────────────────────────────────────

/**
 * Create a vitest-based mock WebSocket. Distinct from mock-socket.ts which is
 * vitest-free for non-test (SDK consumer) usage.
 */
export function createTestSocket(opts?: { bufferedAmount?: number }): WebSocketLike & {
  sentMessages: string[];
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const sentMessages: string[] = [];
  return {
    send: vi.fn((data: string) => sentMessages.push(data)),
    close: vi.fn(),
    sentMessages,
    ...(opts?.bufferedAmount !== undefined ? { bufferedAmount: opts.bufferedAmount } : {}),
  };
}

export const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function authContext(
  sessionId: string,
  transport: Record<string, unknown> = {},
): AuthContext {
  return { sessionId, transport };
}

// ─── Session Factory ────────────────────────────────────────────────────────

export function createMockSession(overrides?: Partial<Session>): Session {
  return {
    id: "sess-1",
    cliSocket: null,
    backendSession: null,
    backendAbort: null,
    consumerSockets: new Map(),
    consumerRateLimiters: new Map(),
    anonymousCounter: 0,
    state: makeDefaultState("sess-1"),
    pendingPermissions: new Map<string, PermissionRequest>(),
    messageHistory: [] as ConsumerMessage[],
    pendingMessages: [],
    lastActivity: Date.now(),
    pendingInitialize: null,
    teamCorrelationBuffer: {
      queue: vi.fn(),
      flush: vi.fn(),
    } as any,
    registry: {
      registerFromCLI: vi.fn(),
      registerSkills: vi.fn(),
      getAll: vi.fn(() => []),
    } as any,
    ...overrides,
  };
}

// ─── Microtask Flushing ─────────────────────────────────────────────────────

/** Flush microtask queue deterministically (no wall-clock dependency). */
export const flushPromises = () => new Promise<void>((resolve) => queueMicrotask(resolve));

// ─── CLI Message Factories ──────────────────────────────────────────────────

export function makeInitMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cli-123",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/test",
    tools: ["Bash", "Read"],
    permissionMode: "default",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    output_style: "normal",
    uuid: "uuid-1",
    apiKeySource: "env",
    ...overrides,
  });
}

export function makeStatusMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "system",
    subtype: "status",
    status: null,
    uuid: "uuid-status",
    session_id: "cli-123",
    ...overrides,
  });
}

export function makeAssistantMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [{ type: "text", text: "Hello world" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: "uuid-2",
    session_id: "cli-123",
    ...overrides,
  });
}

export function makeResultMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "result",
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
    uuid: "uuid-3",
    session_id: "cli-123",
    ...overrides,
  });
}

export function makeStreamEventMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hi" },
    },
    parent_tool_use_id: null,
    uuid: "uuid-4",
    session_id: "cli-123",
    ...overrides,
  });
}

export function makeControlRequestMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "control_request",
    request_id: "perm-req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "ls" },
      tool_use_id: "tu-1",
      ...((overrides.request as Record<string, unknown>) ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "request")),
  });
}

export function makeToolProgressMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "tool_progress",
    tool_use_id: "tu-1",
    tool_name: "Bash",
    parent_tool_use_id: null,
    elapsed_time_seconds: 5,
    uuid: "uuid-5",
    session_id: "cli-123",
    ...overrides,
  });
}

export function makeToolUseSummaryMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "tool_use_summary",
    summary: "Ran bash command",
    preceding_tool_use_ids: ["tu-1", "tu-2"],
    uuid: "uuid-6",
    session_id: "cli-123",
    ...overrides,
  });
}

export function makeAuthStatusMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "auth_status",
    isAuthenticating: true,
    output: ["Authenticating..."],
    uuid: "uuid-7",
    session_id: "cli-123",
    ...overrides,
  });
}

export function makeKeepAliveMsg() {
  return JSON.stringify({ type: "keep_alive" });
}
