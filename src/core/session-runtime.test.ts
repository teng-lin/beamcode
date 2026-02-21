import { describe, expect, it, vi } from "vitest";
import { createMockSession, createTestSocket } from "../testing/cli-message-factories.js";
import { SessionRuntime, type SessionRuntimeDeps } from "./session-runtime.js";
import { createUnifiedMessage } from "./types/unified-message.js";

function makeDeps(overrides?: Partial<SessionRuntimeDeps>): SessionRuntimeDeps {
  const tracedNormalizeInbound = vi.fn((_session, msg) =>
    createUnifiedMessage({ type: "interrupt", role: "system", metadata: { source: msg.type } }),
  );
  return {
    now: () => 1700000000000,
    maxMessageHistoryLength: 100,
    broadcaster: {
      broadcast: vi.fn(),
      broadcastPresence: vi.fn(),
      sendTo: vi.fn(),
    } as any,
    queueHandler: {
      handleQueueMessage: vi.fn(),
      handleUpdateQueuedMessage: vi.fn(),
      handleCancelQueuedMessage: vi.fn(),
    },
    slashService: {
      handleInbound: vi.fn(),
      executeProgrammatic: vi.fn(async () => null),
    },
    sendToBackend: vi.fn(),
    tracedNormalizeInbound,
    persistSession: vi.fn(),
    warnUnknownPermission: vi.fn(),
    emitPermissionResolved: vi.fn(),
    onInvalidLifecycleTransition: vi.fn(),
    ...overrides,
  };
}

describe("SessionRuntime", () => {
  it("hydrates slash registry from persisted state on runtime creation", () => {
    const session = createMockSession({ id: "s1" });
    session.state = {
      ...session.state,
      slash_commands: ["/help", "/clear"],
      skills: ["tdd-guide"],
    };
    const clearDynamic = vi.fn();
    const registerFromCLI = vi.fn();
    const registerSkills = vi.fn();
    session.registry = {
      clearDynamic,
      registerFromCLI,
      registerSkills,
    } as any;

    new SessionRuntime(session, makeDeps());

    expect(clearDynamic).toHaveBeenCalledTimes(1);
    expect(registerFromCLI).toHaveBeenCalledWith([
      { name: "/help", description: "" },
      { name: "/clear", description: "" },
    ]);
    expect(registerSkills).toHaveBeenCalledWith(["tdd-guide"]);
  });

  it("handles user_message with optimistic running state", () => {
    const send = vi.fn();
    const session = createMockSession({
      id: "s1",
      lastStatus: null,
      backendSession: { send } as any,
    });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.handleInboundCommand(
      {
        type: "user_message",
        content: "hello",
        session_id: "backend-1",
      },
      createTestSocket(),
    );

    expect(session.lastStatus).toBe("running");
    expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: "user_message", content: "hello" }),
    );
    expect(deps.tracedNormalizeInbound).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "user_message",
        content: "hello",
        session_id: "backend-1",
      }),
      expect.objectContaining({
        traceId: undefined,
        requestId: undefined,
        command: undefined,
      }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(runtime.getLifecycleState()).toBe("active");
  });

  it("trims message history using runtime-owned max length", () => {
    const send = vi.fn();
    const session = createMockSession({
      id: "s1",
      backendSession: { send } as any,
      messageHistory: [{ type: "user_message", content: "old", timestamp: 1 }] as any,
    });
    const runtime = new SessionRuntime(session, makeDeps({ maxMessageHistoryLength: 1 }));

    runtime.sendUserMessage("new");

    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0]).toEqual(
      expect.objectContaining({ type: "user_message", content: "new" }),
    );
  });

  it("delegates slash_command handling to slash service", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.handleInboundCommand(
      {
        type: "slash_command",
        command: "/help",
      },
      createTestSocket(),
    );

    expect(deps.slashService.handleInbound).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "slash_command",
        command: "/help",
      }),
    );
  });

  it("rejects set_adapter for active sessions", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const ws = createTestSocket();
    const runtime = new SessionRuntime(session, deps);

    runtime.handleInboundCommand(
      {
        type: "set_adapter",
        adapter: "codex",
      },
      ws,
    );

    expect(deps.broadcaster.sendTo).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({ type: "error" }),
    );
  });

  it("invokes backend message callbacks in order", () => {
    const session = createMockSession({ id: "s1" });
    const calls: string[] = [];
    const deps = makeDeps({
      onBackendMessageObserved: () => calls.push("observed"),
      routeBackendMessage: () => calls.push("route"),
      onBackendMessageHandled: () => calls.push("handled"),
    });
    const runtime = new SessionRuntime(session, deps);

    runtime.handleBackendMessage(
      createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: "idle" },
      }),
    );

    expect(calls).toEqual(["observed", "route", "handled"]);
    expect(runtime.getLifecycleState()).toBe("idle");
  });

  it("invokes signal callback", () => {
    const session = createMockSession({ id: "s1" });
    const onSignal = vi.fn();
    const deps = makeDeps({ onSignal });
    const runtime = new SessionRuntime(session, deps);

    runtime.handleSignal("backend:connected");

    expect(runtime.getLifecycleState()).toBe("active");
    expect(onSignal).toHaveBeenCalledWith(session, "backend:connected");
  });

  it("warns on permission response for unknown request id", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.sendPermissionResponse("missing", "deny");

    expect(deps.warnUnknownPermission).toHaveBeenCalledWith("s1", "missing");
    expect(deps.emitPermissionResolved).not.toHaveBeenCalled();
  });

  it("delegates programmatic slash execution to slash service", async () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    (deps.slashService.executeProgrammatic as any).mockResolvedValueOnce({
      content: "help",
      source: "emulated",
    });
    const runtime = new SessionRuntime(session, deps);

    const result = await runtime.executeSlashCommand("/help");

    expect(result).toEqual({ content: "help", source: "emulated" });
    expect(deps.slashService.executeProgrammatic).toHaveBeenCalledWith(session, "/help");
  });

  it("returns null when slash service does not emulate programmatic command", async () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    (deps.slashService.executeProgrammatic as any).mockResolvedValueOnce(null);
    const runtime = new SessionRuntime(session, deps);

    const result = await runtime.executeSlashCommand("/status");

    expect(result).toBeNull();
    expect(deps.slashService.executeProgrammatic).toHaveBeenCalledWith(session, "/status");
  });

  it("reports invalid lifecycle transitions via callback", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.transitionLifecycle("closed", "force-close");
    runtime.transitionLifecycle("active", "invalid-reopen");

    expect(deps.onInvalidLifecycleTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        from: "closed",
        to: "active",
      }),
    );
  });

  it("applies reconnect_timeout policy by transitioning to degraded", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());

    runtime.handleSignal("backend:connected");
    runtime.handlePolicyCommand({ type: "reconnect_timeout" });

    expect(runtime.getLifecycleState()).toBe("degraded");
  });

  it("applies idle_reap policy by transitioning to closing", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());

    runtime.handlePolicyCommand({ type: "idle_reap" });

    expect(runtime.getLifecycleState()).toBe("closing");
  });

  it("sets adapter name and persists session", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);

    runtime.setAdapterName("codex");

    expect(session.adapterName).toBe("codex");
    expect(session.state.adapterName).toBe("codex");
    expect(deps.persistSession).toHaveBeenCalledWith(session);
  });

  it("seeds session state and invokes seed hook", () => {
    const session = createMockSession({ id: "s1" });
    const onSessionSeeded = vi.fn();
    const runtime = new SessionRuntime(session, makeDeps({ onSessionSeeded }));

    runtime.seedSessionState({ cwd: "/tmp/project", model: "claude-test" });

    expect(session.state.cwd).toBe("/tmp/project");
    expect(session.state.model).toBe("claude-test");
    expect(onSessionSeeded).toHaveBeenCalledWith(session);
  });

  it("manages anonymous identity index and consumer registration lifecycle", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());
    const ws = createTestSocket();

    expect(runtime.allocateAnonymousIdentityIndex()).toBe(1);
    expect(runtime.allocateAnonymousIdentityIndex()).toBe(2);

    runtime.addConsumer(ws, {
      userId: "u1",
      displayName: "User One",
      role: "participant",
    });
    session.consumerRateLimiters.set(ws, { allow: () => true } as any);

    const identity = runtime.removeConsumer(ws);
    expect(identity).toEqual({
      userId: "u1",
      displayName: "User One",
      role: "participant",
    });
    expect(session.consumerSockets.has(ws)).toBe(false);
    expect(session.consumerRateLimiters.has(ws)).toBe(false);
  });

  it("owns state, backend session id, status, queued message, and history accessors", () => {
    const session = createMockSession({ id: "s1", lastStatus: null, queuedMessage: null });
    const runtime = new SessionRuntime(session, makeDeps());
    const queued = {
      consumerId: "u1",
      displayName: "User One",
      content: "queued",
      queuedAt: 1,
    };
    const nextState = { ...session.state, model: "claude-sonnet-4-5" };
    const history = [{ type: "user_message", content: "hello", timestamp: 1 }] as any;

    runtime.setState(nextState);
    runtime.setBackendSessionId("backend-123");
    runtime.setLastStatus("running");
    runtime.setMessageHistory(history);
    runtime.setQueuedMessage(queued as any);

    expect(session.state.model).toBe("claude-sonnet-4-5");
    expect(runtime.getState().model).toBe("claude-sonnet-4-5");
    expect(session.backendSessionId).toBe("backend-123");
    expect(runtime.getLastStatus()).toBe("running");
    expect(runtime.getMessageHistory()).toEqual(history);
    expect(runtime.getQueuedMessage()).toEqual(queued);
  });

  it("owns rate limiter map mutation for consumer throttling", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());
    const ws = createTestSocket();
    const limiter = { tryConsume: vi.fn(() => true) };
    const createLimiter = vi.fn(() => limiter as any);

    expect(runtime.checkRateLimit(ws, createLimiter)).toBe(true);
    expect(createLimiter).toHaveBeenCalledTimes(1);
    expect(session.consumerRateLimiters.get(ws)).toBe(limiter);

    expect(runtime.checkRateLimit(ws, createLimiter)).toBe(true);
    expect(createLimiter).toHaveBeenCalledTimes(1);
    expect(limiter.tryConsume).toHaveBeenCalledTimes(2);
  });

  it("closes and unregisters all consumers during shutdown cleanup", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());
    const ws1 = createTestSocket();
    const ws2 = createTestSocket();
    runtime.addConsumer(ws1, { userId: "u1", displayName: "U1", role: "participant" });
    runtime.addConsumer(ws2, { userId: "u2", displayName: "U2", role: "observer" });
    session.consumerRateLimiters.set(ws1, { tryConsume: () => true } as any);
    session.consumerRateLimiters.set(ws2, { tryConsume: () => true } as any);

    runtime.closeAllConsumers();

    expect(ws1.close).toHaveBeenCalledTimes(1);
    expect(ws2.close).toHaveBeenCalledTimes(1);
    expect(session.consumerSockets.size).toBe(0);
    expect(session.consumerRateLimiters.size).toBe(0);
  });

  it("clears backend connection references", () => {
    const abort = new AbortController();
    const session = createMockSession({
      id: "s1",
      backendSession: { send: vi.fn(), close: vi.fn() } as any,
      backendAbort: abort,
    });
    const runtime = new SessionRuntime(session, makeDeps());

    runtime.clearBackendConnection();

    expect(session.backendSession).toBeNull();
    expect(session.backendAbort).toBeNull();
  });

  it("attaches and resets backend connection state", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());
    const backendSession = { send: vi.fn(), close: vi.fn() } as any;
    const abort = new AbortController();
    const slashExecutor = {
      handles: vi.fn(() => false),
      execute: vi.fn(async () => null),
      supportedCommands: vi.fn(() => ["/compact"]),
    } as any;

    runtime.attachBackendConnection({
      backendSession,
      backendAbort: abort,
      supportsSlashPassthrough: true,
      slashExecutor,
    });

    expect(session.backendSession).toBe(backendSession);
    expect(session.backendAbort).toBe(abort);
    expect(session.adapterSupportsSlashPassthrough).toBe(true);
    expect(session.adapterSlashExecutor).toBe(slashExecutor);

    session.backendSessionId = "stale-id";
    runtime.resetBackendConnectionState();

    expect(session.backendSession).toBeNull();
    expect(session.backendAbort).toBeNull();
    expect(session.backendSessionId).toBeUndefined();
    expect(session.adapterSupportsSlashPassthrough).toBe(false);
    expect(session.adapterSlashExecutor).toBeNull();
  });

  it("drains pending messages atomically", () => {
    const m1 = createUnifiedMessage({ type: "interrupt", role: "system" });
    const m2 = createUnifiedMessage({ type: "interrupt", role: "system", metadata: { seq: 2 } });
    const session = createMockSession({ id: "s1", pendingMessages: [m1, m2] as any });
    const runtime = new SessionRuntime(session, makeDeps());

    const drained = runtime.drainPendingMessages();

    expect(drained).toEqual([m1, m2]);
    expect(session.pendingMessages).toEqual([]);
  });

  it("drains pending permission ids atomically", () => {
    const session = createMockSession({ id: "s1" });
    session.pendingPermissions.set("p1", {
      id: "p1",
      request_id: "p1",
      command: "cmd",
      input: {},
      timestamp: Date.now(),
      expires_at: Date.now() + 1000,
      tool_name: "test",
      tool_use_id: "tu1",
      safety_risk: null,
    } as any);
    session.pendingPermissions.set("p2", {
      id: "p2",
      request_id: "p2",
      command: "cmd",
      input: {},
      timestamp: Date.now(),
      expires_at: Date.now() + 1000,
      tool_name: "test",
      tool_use_id: "tu2",
      safety_risk: null,
    } as any);
    const runtime = new SessionRuntime(session, makeDeps());

    const ids = runtime.drainPendingPermissionIds();

    expect(ids).toEqual(["p1", "p2"]);
    expect(session.pendingPermissions.size).toBe(0);
  });

  it("owns pending passthrough queue operations", () => {
    const session = createMockSession({ id: "s1" });
    const runtime = new SessionRuntime(session, makeDeps());

    runtime.enqueuePendingPassthrough({
      command: "/compact",
      requestId: "r1",
      slashRequestId: "sr1",
      traceId: "t1",
      startedAtMs: 1,
    });
    runtime.enqueuePendingPassthrough({
      command: "/status",
      requestId: "r2",
      slashRequestId: "sr2",
      traceId: "t2",
      startedAtMs: 2,
    });

    expect(runtime.peekPendingPassthrough()).toEqual(
      expect.objectContaining({ command: "/compact", requestId: "r1" }),
    );
    expect(runtime.shiftPendingPassthrough()).toEqual(
      expect.objectContaining({ command: "/compact", requestId: "r1" }),
    );
    expect(runtime.shiftPendingPassthrough()).toEqual(
      expect.objectContaining({ command: "/status", requestId: "r2" }),
    );
    expect(runtime.shiftPendingPassthrough()).toBeUndefined();
  });

  it("sends unified messages to backend when connected", () => {
    const session = createMockSession({ id: "s1" });
    const deps = makeDeps();
    const runtime = new SessionRuntime(session, deps);
    const message = createUnifiedMessage({ type: "interrupt", role: "system" });

    runtime.sendToBackend(message);

    expect(deps.sendToBackend).toHaveBeenCalledWith(session, message);
  });
});
