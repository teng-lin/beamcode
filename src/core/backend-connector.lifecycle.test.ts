/**
 * Focused tests for BackendConnector branch coverage.
 *
 * Targets: cliUserEchoToText, passthrough handler, connect with
 * existing session, sendToBackend with no session, sendRaw failure
 * during flush, and unexpected backend disconnection.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CLIMessage } from "../types/cli-messages.js";
import type { BackendConnectorDeps } from "./backend-connector.js";
import { BackendConnector } from "./backend-connector.js";
import type {
  BackendAdapter,
  BackendSession,
  ConnectOptions,
} from "./interfaces/backend-adapter.js";
import { MessageTracerImpl, type TraceEvent } from "./message-tracer.js";
import type { Session } from "./session-repository.js";
import type { UnifiedMessage } from "./types/unified-message.js";
import { createUnifiedMessage } from "./types/unified-message.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createMessageChannel() {
  const queue: UnifiedMessage[] = [];
  let resolve: ((v: IteratorResult<UnifiedMessage>) => void) | null = null;
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
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => {
            resolve = r;
          });
        },
      };
    },
  };
}

class TestBackendSession implements BackendSession {
  readonly sessionId: string;
  readonly channel = createMessageChannel();
  readonly sentMessages: UnifiedMessage[] = [];
  readonly sentRaw: string[] = [];
  closed = false;
  private _sendRawFail = false;
  private _passthroughHandler: ((msg: CLIMessage) => boolean) | null = null;

  constructor(sessionId: string, opts?: { sendRawFail?: boolean; passthrough?: boolean }) {
    this.sessionId = sessionId;
    this._sendRawFail = opts?.sendRawFail ?? false;
    if (opts?.passthrough) {
      // Add setPassthroughHandler to make supportsPassthroughHandler return true
      (this as any).setPassthroughHandler = (handler: ((msg: CLIMessage) => boolean) | null) => {
        this._passthroughHandler = handler;
      };
    }
  }

  send(msg: UnifiedMessage): void {
    this.sentMessages.push(msg);
  }

  sendRaw(ndjson: string): void {
    if (this._sendRawFail) throw new Error("sendRaw not supported");
    this.sentRaw.push(ndjson);
  }

  get messages(): AsyncIterable<UnifiedMessage> {
    return this.channel;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.channel.close();
  }

  pushMessage(msg: UnifiedMessage) {
    this.channel.push(msg);
  }

  endStream() {
    this.channel.close();
  }

  get passthroughHandler() {
    return this._passthroughHandler;
  }
}

class TestAdapter implements BackendAdapter {
  readonly name = "test";
  readonly capabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local" as const,
    teams: false,
  };

  nextSession: TestBackendSession | null = null;

  async connect(options: ConnectOptions): Promise<BackendSession> {
    if (!this.nextSession) {
      this.nextSession = new TestBackendSession(options.sessionId);
    }
    return this.nextSession;
  }
}

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: "sess-1",
    name: "test",
    state: "idle",
    backendSession: null,
    backendAbort: null,
    pendingMessages: [],
    pendingPermissions: new Map(),
    pendingPassthroughs: [],
    consumers: new Set(),
    lastActivity: Date.now(),
    ...overrides,
  } as Session;
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createDeps(overrides?: Partial<BackendConnectorDeps>): BackendConnectorDeps {
  return {
    adapter: new TestAdapter(),
    adapterResolver: null,
    logger: noopLogger,
    metrics: null,
    broadcaster: {
      broadcast: vi.fn(),
      broadcastToParticipants: vi.fn(),
    } as any,
    routeUnifiedMessage: vi.fn(),
    emitEvent: vi.fn(),
    onBackendConnectedState: (session, params) => {
      (session as any).backendSession = params.backendSession;
      (session as any).backendAbort = params.backendAbort;
      (session as any).adapterSupportsSlashPassthrough = params.supportsSlashPassthrough;
      (session as any).adapterSlashExecutor = params.slashExecutor;
    },
    onBackendDisconnectedState: (session) => {
      (session as any).backendSession = null;
      (session as any).backendAbort = null;
      (session as any).backendSessionId = undefined;
      (session as any).adapterSupportsSlashPassthrough = false;
      (session as any).adapterSlashExecutor = null;
    },
    getBackendSession: (session) => (session as any).backendSession ?? null,
    getBackendAbort: (session) => (session as any).backendAbort ?? null,
    drainPendingMessages: (session) => {
      const pending = ((session as any).pendingMessages ?? []) as UnifiedMessage[];
      (session as any).pendingMessages = [];
      return pending;
    },
    drainPendingPermissionIds: (session) => {
      const pendingPermissions =
        ((session as any).pendingPermissions as Map<string, unknown> | undefined) ?? new Map();
      const ids = Array.from(pendingPermissions.keys());
      pendingPermissions.clear();
      (session as any).pendingPermissions = pendingPermissions;
      return ids;
    },
    peekPendingPassthrough: (session) => (session as any).pendingPassthroughs?.[0],
    shiftPendingPassthrough: (session) => (session as any).pendingPassthroughs?.shift(),
    setSlashCommandsState: (session, commands) => {
      const current = (session as any).state;
      if (current && typeof current === "object") {
        (session as any).state = { ...current, slash_commands: commands };
      }
    },
    registerCLICommands: (session, commands) => {
      const registry = (session as any).registry;
      if (!registry || typeof registry.registerFromCLI !== "function") return;
      registry.registerFromCLI(commands.map((name: string) => ({ name, description: "" })));
    },
    ...overrides,
  };
}

function createTraceCollector() {
  const lines: string[] = [];
  const tracer = new MessageTracerImpl({
    level: "smart",
    allowSensitive: false,
    write: (line) => lines.push(line),
    staleTimeoutMs: 60_000,
  });
  const events = () => lines.map((line) => JSON.parse(line) as TraceEvent);
  return { tracer, events };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BackendConnector", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("connectBackend", () => {
    it("connects and broadcasts events", async () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await mgr.connectBackend(session);

      expect(session.backendSession).not.toBeNull();
      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(session, { type: "cli_connected" });
      expect(deps.emitEvent).toHaveBeenCalledWith("backend:connected", { sessionId: "sess-1" });
    });

    it("closes existing backend session on reconnect", async () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);

      const oldSession = new TestBackendSession("sess-1");
      const oldAbort = new AbortController();
      const abortSpy = vi.spyOn(oldAbort, "abort");

      const session = createSession({
        backendSession: oldSession,
        backendAbort: oldAbort,
      });

      await mgr.connectBackend(session);

      expect(oldSession.closed).toBe(true);
      expect(abortSpy).toHaveBeenCalled();
    });

    it("records metrics when metrics collector is provided", async () => {
      const metrics = { recordEvent: vi.fn() };
      const deps = createDeps({ metrics });
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await mgr.connectBackend(session);

      expect(metrics.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "backend:connected", sessionId: "sess-1" }),
      );
    });

    it("flushes pending messages on connect", async () => {
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const msg1 = createUnifiedMessage({ type: "user_message", role: "user" });
      const msg2 = createUnifiedMessage({ type: "user_message", role: "user" });

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession({ pendingMessages: [msg1, msg2] as any });

      await mgr.connectBackend(session);

      expect(testSession.sentMessages).toEqual([msg1, msg2]);
      expect(session.pendingMessages).toEqual([]);
    });

    it("sets up passthrough handler when session supports it", async () => {
      const testSession = new TestBackendSession("sess-1", { passthrough: true });
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession({
        pendingPassthroughs: [{ command: "/test", requestId: "req-1" }],
      });

      await mgr.connectBackend(session);

      // Verify passthrough handler was installed
      expect(testSession.passthroughHandler).not.toBeNull();

      // Trigger the passthrough handler with a user message
      const result = testSession.passthroughHandler!({
        type: "user",
        message: { content: "echo result" },
      } as CLIMessage);

      expect(result).toBe(true);
      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "slash_command_result", content: "echo result" }),
      );
      expect(session.pendingPassthroughs).toHaveLength(0);
    });

    it("passthrough handler returns false for non-user messages", async () => {
      const testSession = new TestBackendSession("sess-1", { passthrough: true });
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await mgr.connectBackend(session);

      const result = testSession.passthroughHandler!({
        type: "assistant",
        message: { content: "hello" },
      } as CLIMessage);
      expect(result).toBe(false);
    });

    it("passthrough handler returns false when no pending passthrough", async () => {
      const testSession = new TestBackendSession("sess-1", { passthrough: true });
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession({ pendingPassthroughs: [] });

      await mgr.connectBackend(session);

      const result = testSession.passthroughHandler!({
        type: "user",
        message: { content: "hello" },
      } as CLIMessage);
      expect(result).toBe(false);
    });

    it("throws when no adapter configured", async () => {
      const deps = createDeps({ adapter: null });
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await expect(mgr.connectBackend(session)).rejects.toThrow("No BackendAdapter configured");
    });

    it("sets adapterSupportsSlashPassthrough true when adapter capabilities.slashCommands is true", async () => {
      const deps = createDeps();
      // Override slashCommands on the TestAdapter's capabilities
      (deps.adapter as TestAdapter).capabilities = {
        ...(deps.adapter as TestAdapter).capabilities,
        slashCommands: true,
      };
      const manager = new BackendConnector(deps);
      const session = createSession();
      await manager.connectBackend(session);
      expect(session.adapterSupportsSlashPassthrough).toBe(true);
    });

    it("sets adapterSupportsSlashPassthrough false when adapter capabilities.slashCommands is false", async () => {
      const deps = createDeps(); // TestAdapter has slashCommands: false by default
      const manager = new BackendConnector(deps);
      const session = createSession();
      await manager.connectBackend(session);
      expect(session.adapterSupportsSlashPassthrough).toBe(false);
    });
  });

  describe("sendToBackend", () => {
    it("warns and returns when no backend session", () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      const session = createSession();

      const msg = createUnifiedMessage({ type: "user_message", role: "user" });
      mgr.sendToBackend(session, msg);

      expect(noopLogger.warn).toHaveBeenCalledWith(expect.stringContaining("No backend session"));
    });

    it("emits error event when send throws", () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      const badSession = {
        send: () => {
          throw new Error("send failed");
        },
      } as unknown as BackendSession;
      const session = createSession({ backendSession: badSession });

      const msg = createUnifiedMessage({ type: "user_message", role: "user" });
      mgr.sendToBackend(session, msg);

      expect(deps.emitEvent).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({
          source: "sendToBackend",
        }),
      );
    });
  });

  describe("disconnectBackend", () => {
    it("disconnects and cancels pending permissions", async () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      const testSession = new TestBackendSession("sess-1");
      const session = createSession({
        backendSession: testSession,
        backendAbort: new AbortController(),
        pendingPermissions: new Map([["perm-1", {} as any]]),
      });

      await mgr.disconnectBackend(session);

      expect(testSession.closed).toBe(true);
      expect(session.backendSession).toBeNull();
      expect(session.backendAbort).toBeNull();
      expect(session.pendingPermissions.size).toBe(0);
      expect(deps.broadcaster.broadcastToParticipants).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "permission_cancelled" }),
      );
    });

    it("is a no-op when no backend session", async () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await mgr.disconnectBackend(session);

      // Should not broadcast or emit events for disconnection
      expect(deps.emitEvent).not.toHaveBeenCalledWith("backend:disconnected", expect.anything());
    });

    it("records metrics when disconnecting", async () => {
      const metrics = { recordEvent: vi.fn() };
      const deps = createDeps({ metrics });
      const mgr = new BackendConnector(deps);
      const session = createSession({
        backendSession: new TestBackendSession("sess-1"),
        backendAbort: new AbortController(),
      });

      await mgr.disconnectBackend(session);

      expect(metrics.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "backend:disconnected" }),
      );
    });

    it("resets adapterSupportsSlashPassthrough to false on disconnect", async () => {
      const deps = createDeps();
      (deps.adapter as TestAdapter).capabilities = {
        ...(deps.adapter as TestAdapter).capabilities,
        slashCommands: true,
      };
      const manager = new BackendConnector(deps);
      const session = createSession();
      await manager.connectBackend(session);
      expect(session.adapterSupportsSlashPassthrough).toBe(true);
      await manager.disconnectBackend(session);
      expect(session.adapterSupportsSlashPassthrough).toBe(false);
    });

    it("clears backendSessionId on disconnect to avoid stale resume ids", async () => {
      const deps = createDeps();
      const manager = new BackendConnector(deps);
      const session = createSession({
        backendSession: new TestBackendSession("sess-1"),
        backendAbort: new AbortController(),
        backendSessionId: "stale-session-id",
      });

      await manager.disconnectBackend(session);
      expect(session.backendSessionId).toBeUndefined();
    });
  });

  describe("backend message consumption", () => {
    it("routes incoming messages to routeUnifiedMessage", async () => {
      const routeUnifiedMessage = vi.fn();
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter, routeUnifiedMessage });
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await mgr.connectBackend(session);

      const msg = createUnifiedMessage({ type: "assistant", role: "assistant" });
      testSession.pushMessage(msg);

      await tick();

      expect(routeUnifiedMessage).toHaveBeenCalledWith(session, msg);
    });

    it("emits backend:message for each backend message", async () => {
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await mgr.connectBackend(session);

      const msg = createUnifiedMessage({ type: "assistant", role: "assistant" });
      testSession.pushMessage(msg);
      await tick();

      expect(deps.emitEvent).toHaveBeenCalledWith("backend:message", {
        sessionId: "sess-1",
        message: msg,
      });
    });

    it("converts pending passthrough assistant output into slash_command_result", async () => {
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession({
        pendingPassthroughs: [{ command: "/context", requestId: "req-ctx" }],
      });

      await mgr.connectBackend(session);

      testSession.pushMessage(
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text: "Context: 23% used" }],
        }),
      );

      await tick();

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          type: "slash_command_result",
          command: "/context",
          request_id: "req-ctx",
          content: "Context: 23% used",
          source: "cli",
        }),
      );
      expect(session.pendingPassthroughs).toHaveLength(0);
    });

    it("converts pending passthrough result output into slash_command_result", async () => {
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession({
        pendingPassthroughs: [{ command: "/context", requestId: "req-ctx" }],
      });

      await mgr.connectBackend(session);

      testSession.pushMessage(
        createUnifiedMessage({
          type: "result",
          role: "system",
          metadata: { result: "Context summary line" },
        }),
      );

      await tick();

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          type: "slash_command_result",
          command: "/context",
          request_id: "req-ctx",
          content: "Context summary line",
          source: "cli",
        }),
      );
      expect(session.pendingPassthroughs).toHaveLength(0);
    });

    it("converts pending passthrough stream text + empty result into slash_command_result", async () => {
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession({
        pendingPassthroughs: [{ command: "/context", requestId: "req-ctx" }],
      });

      await mgr.connectBackend(session);

      testSession.pushMessage(
        createUnifiedMessage({
          type: "stream_event",
          role: "system",
          metadata: {
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Context Usage\nTokens: 43.5k / 200k (22%)" },
            },
          },
        }),
      );
      testSession.pushMessage(
        createUnifiedMessage({
          type: "result",
          role: "system",
          metadata: { result: "" },
        }),
      );

      await tick();

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          type: "slash_command_result",
          command: "/context",
          request_id: "req-ctx",
          content: "Context Usage\nTokens: 43.5k / 200k (22%)",
          source: "cli",
        }),
      );
      expect(session.pendingPassthroughs).toHaveLength(0);
    });

    it("golden: empty /context result emits empty_result summary", async () => {
      const trace = createTraceCollector();
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter, tracer: trace.tracer });
      const mgr = new BackendConnector(deps);
      const session = createSession({
        pendingPassthroughs: [
          {
            command: "/context",
            requestId: "req-ctx",
            slashRequestId: "req-ctx",
            traceId: "t_ctx",
            startedAtMs: Date.now(),
          },
        ],
      });

      await mgr.connectBackend(session);

      testSession.pushMessage(
        createUnifiedMessage({
          type: "result",
          role: "system",
          metadata: { result: "" },
        }),
      );

      await tick();

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          type: "slash_command_error",
          command: "/context",
          request_id: "req-ctx",
        }),
      );
      expect(session.pendingPassthroughs).toHaveLength(0);

      const golden = trace
        .events()
        .filter(
          (e) =>
            e.messageType === "slash_command_error" || e.messageType === "slash_decision_summary",
        )
        .map((e) => ({
          messageType: e.messageType,
          requestId: e.requestId,
          command: e.command,
          phase: e.phase,
          outcome: e.outcome,
          matched_path:
            e.messageType === "slash_decision_summary"
              ? ((e.body as { matched_path?: string } | undefined)?.matched_path ?? null)
              : null,
        }));
      expect(golden).toMatchInlineSnapshot(`
        [
          {
            "command": "/context",
            "matched_path": null,
            "messageType": "slash_command_error",
            "outcome": "empty_result",
            "phase": "finalize_passthrough",
            "requestId": "req-ctx",
          },
          {
            "command": "/context",
            "matched_path": "none",
            "messageType": "slash_decision_summary",
            "outcome": "empty_result",
            "phase": "summary",
            "requestId": "req-ctx",
          },
        ]
      `);
    });

    it("broadcasts cli_disconnected when stream ends unexpectedly", async () => {
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession();

      await mgr.connectBackend(session);

      // End the stream (simulating unexpected backend disconnect)
      testSession.endStream();

      await tick(50);

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(session, {
        type: "cli_disconnected",
      });
      expect(deps.emitEvent).toHaveBeenCalledWith(
        "backend:disconnected",
        expect.objectContaining({
          sessionId: "sess-1",
          reason: "stream ended",
        }),
      );
      expect(session.backendSession).toBeNull();
    });

    it("clears backendSessionId when stream ends unexpectedly", async () => {
      const testSession = new TestBackendSession("sess-1");
      const adapter = new TestAdapter();
      adapter.nextSession = testSession;

      const deps = createDeps({ adapter });
      const mgr = new BackendConnector(deps);
      const session = createSession({ backendSessionId: "stale-session-id" });

      await mgr.connectBackend(session);
      testSession.endStream();
      await tick(50);

      expect(session.backendSessionId).toBeUndefined();
    });
  });

  describe("isBackendConnected", () => {
    it("returns true when backend session exists", () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      const session = createSession({ backendSession: new TestBackendSession("sess-1") });

      expect(mgr.isBackendConnected(session)).toBe(true);
    });

    it("returns false when no backend session", () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      const session = createSession();

      expect(mgr.isBackendConnected(session)).toBe(false);
    });
  });

  describe("hasAdapter", () => {
    it("returns true when adapter is configured", () => {
      const deps = createDeps();
      const mgr = new BackendConnector(deps);
      expect(mgr.hasAdapter).toBe(true);
    });

    it("returns false when adapter is null", () => {
      const deps = createDeps({ adapter: null });
      const mgr = new BackendConnector(deps);
      expect(mgr.hasAdapter).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// cliUserEchoToText (accessed via passthrough handler)
// ---------------------------------------------------------------------------

describe("BackendConnector — cliUserEchoToText via passthrough", () => {
  async function setupWithPassthrough() {
    const testSession = new TestBackendSession("sess-1", { passthrough: true });
    const adapter = new TestAdapter();
    adapter.nextSession = testSession;
    const deps = createDeps({ adapter });
    const mgr = new BackendConnector(deps);
    const session = createSession({
      pendingPassthroughs: [{ command: "/test", requestId: "req-1" }],
    });

    await mgr.connectBackend(session);
    return { testSession, session, deps };
  }

  it("handles array content with mixed items", async () => {
    const { testSession, session, deps } = await setupWithPassthrough();

    testSession.passthroughHandler!({
      type: "user",
      message: {
        content: [
          "plain string",
          { type: "text", text: " and object" },
          { type: "image", url: "ignored" },
        ],
      },
    } as unknown as CLIMessage);

    expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ content: "plain string and object" }),
    );
  });

  it("handles object content with text property", async () => {
    const { testSession, deps } = await setupWithPassthrough();

    // Reset pendingPassthroughs for another call
    const session2 = createSession({
      pendingPassthroughs: [{ command: "/test2", requestId: "req-2" }],
    });
    // Re-connect with a new session that has passthrough pending
    const testSession2 = new TestBackendSession("sess-2", { passthrough: true });
    const adapter2 = new TestAdapter();
    adapter2.nextSession = testSession2;
    const deps2 = createDeps({ adapter: adapter2 });
    const mgr2 = new BackendConnector(deps2);
    await mgr2.connectBackend(session2);

    testSession2.passthroughHandler!({
      type: "user",
      message: { content: { text: "object text" } },
    } as unknown as CLIMessage);

    expect(deps2.broadcaster.broadcast).toHaveBeenCalledWith(
      session2,
      expect.objectContaining({ content: "object text" }),
    );
  });

  it("handles null content", async () => {
    const { testSession, session, deps } = await setupWithPassthrough();

    testSession.passthroughHandler!({
      type: "user",
      message: { content: null },
    } as unknown as CLIMessage);

    expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ content: "" }),
    );
  });

  it("handles object content without text property", async () => {
    const testSession = new TestBackendSession("sess-1", { passthrough: true });
    const adapter = new TestAdapter();
    adapter.nextSession = testSession;
    const deps = createDeps({ adapter });
    const mgr = new BackendConnector(deps);
    const session = createSession({
      pendingPassthroughs: [{ command: "/x", requestId: "r-1" }],
    });
    await mgr.connectBackend(session);

    testSession.passthroughHandler!({
      type: "user",
      message: { content: { notText: "value" } },
    } as unknown as CLIMessage);

    expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ content: "" }),
    );
  });

  it("handles object content with non-string text property", async () => {
    const testSession = new TestBackendSession("sess-1", { passthrough: true });
    const adapter = new TestAdapter();
    adapter.nextSession = testSession;
    const deps = createDeps({ adapter });
    const mgr = new BackendConnector(deps);
    const session = createSession({
      pendingPassthroughs: [{ command: "/x", requestId: "r-1" }],
    });
    await mgr.connectBackend(session);

    testSession.passthroughHandler!({
      type: "user",
      message: { content: { text: 42 } },
    } as unknown as CLIMessage);

    expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ content: "" }),
    );
  });

  it("strips local-command-stdout wrapper from passthrough content", async () => {
    const testSession = new TestBackendSession("sess-1", { passthrough: true });
    const adapter = new TestAdapter();
    adapter.nextSession = testSession;
    const deps = createDeps({ adapter });
    const mgr = new BackendConnector(deps);
    const session = createSession({
      pendingPassthroughs: [{ command: "/context", requestId: "r-1" }],
    });
    await mgr.connectBackend(session);

    testSession.passthroughHandler!({
      type: "user",
      message: { content: "<local-command-stdout>Context Usage</local-command-stdout>" },
    } as unknown as CLIMessage);

    expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ content: "Context Usage" }),
    );
  });
});
