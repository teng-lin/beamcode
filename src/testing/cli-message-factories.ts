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
import type { Session } from "../core/session-repository.js";
import { makeDefaultState } from "../core/session-repository.js";
import type { AuthContext } from "../interfaces/auth.js";
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
  const socket: ReturnType<typeof createTestSocket> = {
    send: vi.fn((data: string) => sentMessages.push(data)),
    close: vi.fn<(code?: number, reason?: string) => void>(),
    sentMessages,
  };
  if (opts?.bufferedAmount !== undefined) {
    Object.defineProperty(socket, "bufferedAmount", { value: opts.bufferedAmount });
  }
  return socket;
}

/** Parse all JSON messages sent to a test socket. */
function parseSent(socket: { sentMessages: string[] }): any[] {
  return socket.sentMessages.map((m) => JSON.parse(m));
}

/** Find the first message of a given type in a test socket's sent messages. */
export function findMessage(socket: { sentMessages: string[] }, type: string): any {
  return parseSent(socket).find((m: { type: string }) => m.type === type);
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
    backendSession: null,
    backendAbort: null,
    consumerSockets: new Map(),
    consumerRateLimiters: new Map(),
    anonymousCounter: 0,
    state: makeDefaultState("sess-1"),
    pendingPermissions: new Map<string, PermissionRequest>(),
    messageHistory: [] as ConsumerMessage[],
    pendingMessages: [],
    queuedMessage: null,
    lastStatus: null,
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
    pendingPassthroughs: [],
    adapterSlashExecutor: null,
    adapterSupportsSlashPassthrough: false,
    ...overrides,
  };
}

// ─── Microtask Flushing ─────────────────────────────────────────────────────

/** Flush microtask queue deterministically (no wall-clock dependency). */
export const flushPromises = () => new Promise<void>((resolve) => queueMicrotask(resolve));
