/**
 * OpencodeAdapter compliance test — runs the BackendAdapter compliance suite
 * against a thin wrapper that constructs OpencodeSession instances directly
 * with mocks, bypassing real server launch and HTTP calls.
 *
 * Mock pattern:
 *   - subscribe() registers an event handler and returns a push/unsubscribe pair
 *   - promptAsync() pushes a message.part.updated text event followed by a
 *     session.status idle event, simulating an echo response
 *   - replyPermission() and abort() are no-ops
 */

import { vi } from "vitest";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";
import { runBackendAdapterComplianceTests } from "../../core/interfaces/backend-adapter-compliance.js";
import type { OpencodeHttpClient } from "./opencode-http-client.js";
import { OpencodeSession } from "./opencode-session.js";
import type { OpencodeEvent } from "./opencode-types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock OpencodeHttpClient and a subscribe function that are wired
 * together for a single OpencodeSession.
 *
 * Returns:
 *   - httpClient  — the mock with vi.fn() methods
 *   - subscribe   — registers the session event handler and returns an
 *                   unsubscribe function; also stores the push function so
 *                   promptAsync can inject events
 */
function createMockPair(opcSessionId: string): {
  httpClient: OpencodeHttpClient;
  subscribe: (handler: (event: OpencodeEvent) => void) => () => void;
} {
  // Will be populated when subscribe() is called by the OpencodeSession ctor
  let pushEvent: ((event: OpencodeEvent) => void) | null = null;

  const subscribe = (handler: (event: OpencodeEvent) => void): (() => void) => {
    pushEvent = handler;
    return () => {
      pushEvent = null;
    };
  };

  const httpClient = {
    promptAsync: vi.fn().mockImplementation((_sessionId: string) => {
      // Simulate an async echo response: text delta followed by idle status
      setTimeout(() => {
        if (!pushEvent) return;

        // 1. Push a text part update (produces a stream_event UnifiedMessage)
        pushEvent({
          type: "message.part.updated",
          properties: {
            part: {
              type: "text",
              id: "part-mock-1",
              messageID: "msg-mock-1",
              sessionID: opcSessionId,
              text: "echo",
              time: { created: Date.now(), updated: Date.now() },
            },
            delta: "echo",
          },
        });

        // 2. Push session.status idle (produces a result UnifiedMessage)
        pushEvent({
          type: "session.status",
          properties: {
            sessionID: opcSessionId,
            status: { type: "idle" },
          },
        });
      }, 0);

      return Promise.resolve();
    }),

    replyPermission: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),

    // The following methods are not exercised by OpencodeSession directly
    // but must be present to satisfy the interface shape
    createSession: vi.fn().mockResolvedValue({ id: opcSessionId }),
    health: vi.fn().mockResolvedValue({ healthy: true }),
    connectSse: vi.fn().mockResolvedValue(new ReadableStream()),
  } as unknown as OpencodeHttpClient;

  return { httpClient, subscribe };
}

// ---------------------------------------------------------------------------
// Compliance wrapper adapter — constructs OpencodeSession instances directly
// ---------------------------------------------------------------------------

class ComplianceOpencodeAdapter implements BackendAdapter {
  readonly name = "opencode";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: false,
  };

  async connect(options: ConnectOptions): Promise<BackendSession> {
    // Use the beamcode sessionId as the opencode session ID for simplicity
    const opcSessionId = options.sessionId;
    const { httpClient, subscribe } = createMockPair(opcSessionId);

    return new OpencodeSession({
      sessionId: options.sessionId,
      opcSessionId,
      httpClient,
      subscribe,
    });
  }
}

runBackendAdapterComplianceTests("OpencodeAdapter", () => new ComplianceOpencodeAdapter());
