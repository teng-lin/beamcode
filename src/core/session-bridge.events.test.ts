import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  makeAssistantUnifiedMsg,
  makeAuthStatusUnifiedMsg,
  makePermissionRequestUnifiedMsg,
  makeResultUnifiedMsg,
  makeSessionInitMsg,
  makeStreamEventUnifiedMsg,
  noopLogger,
  tick,
} from "../testing/adapter-test-helpers.js";
import {
  authContext,
  createTestSocket as createMockSocket,
} from "../testing/cli-message-factories.js";
import type { SessionBridge as SessionBridgeType } from "./session-bridge.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — Event emission", () => {
  let bridge: SessionBridgeType;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  it("emits backend:session_id on system init", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    const handler = vi.fn();
    bridge.on("backend:session_id", handler);

    backendSession.pushMessage(makeSessionInitMsg({ session_id: "cli-xyz" }));
    await tick();

    expect(handler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      backendSessionId: "cli-xyz",
    });
  });

  it("emits backend:connected on connectBackend", async () => {
    const handler = vi.fn();
    bridge.on("backend:connected", handler);

    await bridge.connectBackend("sess-1");
    expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("emits backend:disconnected on disconnectBackend", async () => {
    await bridge.connectBackend("sess-1");

    const handler = vi.fn();
    bridge.on("backend:disconnected", handler);

    await bridge.disconnectBackend("sess-1");
    expect(handler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      code: 1000,
      reason: "normal",
    });
  });

  it("emits backend:relaunch_needed when consumer opens and backend is dead", () => {
    bridge.getOrCreateSession("sess-1");
    const handler = vi.fn();
    bridge.on("backend:relaunch_needed", handler);

    bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
    expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("does not emit backend:relaunch_needed when backend is connected", async () => {
    await bridge.connectBackend("sess-1");

    const handler = vi.fn();
    bridge.on("backend:relaunch_needed", handler);

    bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("emits consumer:connected with correct count", async () => {
    await bridge.connectBackend("sess-1");

    const handler = vi.fn();
    bridge.on("consumer:connected", handler);

    bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", consumerCount: 1 }),
    );

    bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", consumerCount: 2 }),
    );
  });

  it("emits consumer:disconnected with correct count", () => {
    bridge.getOrCreateSession("sess-1");
    const ws1 = createMockSocket();
    const ws2 = createMockSocket();
    bridge.handleConsumerOpen(ws1, authContext("sess-1"));
    bridge.handleConsumerOpen(ws2, authContext("sess-1"));

    const handler = vi.fn();
    bridge.on("consumer:disconnected", handler);

    bridge.handleConsumerClose(ws1, "sess-1");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", consumerCount: 1 }),
    );

    bridge.handleConsumerClose(ws2, "sess-1");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", consumerCount: 0 }),
    );
  });

  it("emits message:outbound for every consumer broadcast", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;
    bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));

    const handler = vi.fn();
    bridge.on("message:outbound", handler);

    backendSession.pushMessage(makeAssistantUnifiedMsg());
    await tick();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        message: expect.objectContaining({ type: "assistant" }),
      }),
    );
  });

  it("emits message:inbound for every consumer message", async () => {
    await bridge.connectBackend("sess-1");
    const ws = createMockSocket();
    bridge.handleConsumerOpen(ws, authContext("sess-1"));

    const handler = vi.fn();
    bridge.on("message:inbound", handler);

    bridge.handleConsumerMessage(ws, "sess-1", JSON.stringify({ type: "interrupt" }));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        message: { type: "interrupt" },
      }),
    );
  });

  it("emits permission:requested on permission_request", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    const handler = vi.fn();
    bridge.on("permission:requested", handler);

    backendSession.pushMessage(makePermissionRequestUnifiedMsg());
    await tick();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        request: expect.objectContaining({
          request_id: "perm-req-1",
          tool_name: "Bash",
        }),
      }),
    );
  });

  it("emits permission:resolved when permission response is sent", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    backendSession.pushMessage(makePermissionRequestUnifiedMsg());
    await tick();

    const handler = vi.fn();
    bridge.on("permission:resolved", handler);

    bridge.sendPermissionResponse("sess-1", "perm-req-1", "deny");

    expect(handler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      requestId: "perm-req-1",
      behavior: "deny",
    });
  });

  it("emits session:first_turn_completed on successful first turn", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;
    bridge.sendUserMessage("sess-1", "Explain monads");

    const handler = vi.fn();
    bridge.on("session:first_turn_completed", handler);

    backendSession.pushMessage(makeResultUnifiedMsg({ num_turns: 1, is_error: false }));
    await tick();

    expect(handler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      firstUserMessage: "Explain monads",
    });
  });

  it("emits session:closed on closeSession", () => {
    bridge.getOrCreateSession("sess-1");
    const handler = vi.fn();
    bridge.on("session:closed", handler);

    bridge.closeSession("sess-1");
    expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("emits auth_status on auth_status message", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    const handler = vi.fn();
    bridge.on("auth_status", handler);

    backendSession.pushMessage(
      makeAuthStatusUnifiedMsg({ isAuthenticating: false, error: "Auth failed" }),
    );
    await tick();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        isAuthenticating: false,
        error: "Auth failed",
      }),
    );
  });

  it("emits error when sendToBackend fails", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    // Make the backend session's send throw
    backendSession.send = () => {
      throw new Error("Backend write failed");
    };

    const handler = vi.fn();
    bridge.on("error", handler);

    // Use sendToBackend which routes through BackendLifecycleManager (try/catch + error emit)
    bridge.sendToBackend("sess-1", makeAssistantUnifiedMsg());

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "sendToBackend",
        error: expect.any(Error),
        sessionId: "sess-1",
      }),
    );
  });
});

// ─── Error paths ──────────────────────────────────────────────────────────────

describe("SessionBridge — error paths", () => {
  let bridge: SessionBridgeType;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  it("handleConsumerMessage exceeding MAX_CONSUMER_MESSAGE_SIZE closes socket with 1009", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    const ws = createMockSocket();
    bridge.handleConsumerOpen(ws, authContext("sess-1"));
    backendSession.pushMessage(makeSessionInitMsg());
    await tick();

    // 256KB + 1
    const oversized = "x".repeat(262_145);
    bridge.handleConsumerMessage(ws, "sess-1", oversized);

    expect(ws.close).toHaveBeenCalledWith(1009, "Message Too Big");
  });

  it("messages queue when backend is not connected and flush on connect", async () => {
    bridge.getOrCreateSession("sess-1");
    const ws = createMockSocket();
    bridge.handleConsumerOpen(ws, authContext("sess-1"));

    // Send a consumer message without backend being connected
    bridge.handleConsumerMessage(
      ws,
      "sess-1",
      JSON.stringify({ type: "user_message", content: "hello" }),
    );

    // Connect backend and check flush
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    backendSession.pushMessage(makeSessionInitMsg());
    await tick();

    // After backend connects, queued messages should have been flushed via send()
    const flushed = backendSession.sentMessages.some((m) => m.type === "user_message");
    expect(flushed).toBe(true);
  });

  it("consumer open with unknown session is rejected", () => {
    const ws = createMockSocket();

    // No backend has connected to "new-session" yet
    bridge.handleConsumerOpen(ws, authContext("new-session"));

    // Session should not be auto-created
    const snapshot = bridge.getSession("new-session");
    expect(snapshot).toBeUndefined();
    expect(ws.close).toHaveBeenCalledWith(4404, "Session not found");
  });

  it("consumer message for session with no backend does not crash", () => {
    bridge.getOrCreateSession("no-cli");
    const ws = createMockSocket();
    bridge.handleConsumerOpen(ws, authContext("no-cli"));

    // Try to send a message without any backend
    expect(() => {
      bridge.handleConsumerMessage(
        ws,
        "no-cli",
        JSON.stringify({ type: "user_message", content: "test" }),
      );
    }).not.toThrow();
  });
});

// ─── seedSessionState ─────────────────────────────────────────────────────────

describe("SessionBridge — seedSessionState", () => {
  let bridge: SessionBridgeType;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
  });

  it("populates cwd and model on session state", () => {
    bridge.seedSessionState("seed-1", { cwd: "/home/user/project", model: "opus" });
    const snap = bridge.getSession("seed-1");
    expect(snap).toBeDefined();
    expect(snap!.state.cwd).toBe("/home/user/project");
    expect(snap!.state.model).toBe("opus");
  });

  it("resolves git info when gitResolver is provided", () => {
    const mockGitResolver = {
      resolve: vi.fn().mockReturnValue({
        branch: "feat/test",
        isWorktree: true,
        repoRoot: "/repo",
        ahead: 2,
        behind: 1,
      }),
    };
    const gitBridge = new SessionBridge({
      gitResolver: mockGitResolver,
      config: { port: 3456 },
      logger: noopLogger,
    });

    gitBridge.seedSessionState("seed-2", { cwd: "/repo", model: "sonnet" });

    const snap = gitBridge.getSession("seed-2");
    expect(snap!.state.git_branch).toBe("feat/test");
    expect(snap!.state.is_worktree).toBe(true);
    expect(snap!.state.repo_root).toBe("/repo");
    expect(snap!.state.git_ahead).toBe(2);
    expect(snap!.state.git_behind).toBe(1);
    expect(mockGitResolver.resolve).toHaveBeenCalledWith("/repo");
  });

  it("does not overwrite cwd or model when params are undefined", () => {
    bridge.seedSessionState("seed-3", { cwd: "/first", model: "opus" });
    bridge.seedSessionState("seed-3", {});

    const snap = bridge.getSession("seed-3");
    expect(snap!.state.cwd).toBe("/first");
    expect(snap!.state.model).toBe("opus");
  });

  it("is idempotent: second call does not re-resolve git info", () => {
    const mockGitResolver = {
      resolve: vi.fn().mockReturnValue({
        branch: "main",
        isWorktree: false,
        repoRoot: "/repo",
      }),
    };
    const gitBridge = new SessionBridge({
      gitResolver: mockGitResolver,
      config: { port: 3456 },
      logger: noopLogger,
    });

    gitBridge.seedSessionState("seed-4", { cwd: "/repo" });
    gitBridge.seedSessionState("seed-4", { cwd: "/repo" });

    // resolve called only once -- second call skips due to git_branch already set
    expect(mockGitResolver.resolve).toHaveBeenCalledTimes(1);
  });

  it("does not spawn subprocesses repeatedly for non-git directories", () => {
    const mockGitResolver = {
      resolve: vi.fn().mockReturnValue(null), // non-git dir
    };
    const gitBridge = new SessionBridge({
      gitResolver: mockGitResolver,
      config: { port: 3456 },
      logger: noopLogger,
    });

    gitBridge.seedSessionState("seed-5", { cwd: "/tmp" });
    // Simulate consumer connecting
    const ws = createMockSocket();
    gitBridge.handleConsumerOpen(ws, authContext("seed-5"));

    // resolve called only once -- second call skipped due to attempt tracking
    expect(mockGitResolver.resolve).toHaveBeenCalledTimes(1);
  });

  it("does not crash when gitResolver.resolve() throws", () => {
    const mockGitResolver = {
      resolve: vi.fn().mockImplementation(() => {
        throw new Error("git not found");
      }),
    };
    const gitBridge = new SessionBridge({
      gitResolver: mockGitResolver,
      config: { port: 3456 },
      logger: noopLogger,
    });

    expect(() => {
      gitBridge.seedSessionState("seed-6", { cwd: "/repo" });
    }).not.toThrow();

    const snap = gitBridge.getSession("seed-6");
    expect(snap!.state.cwd).toBe("/repo");
    expect(snap!.state.git_branch).toBe("");
  });

  it("consumer connecting before backend receives seeded state in session_init", () => {
    const mockGitResolver = {
      resolve: vi.fn().mockReturnValue({
        branch: "develop",
        isWorktree: false,
        repoRoot: "/project",
        ahead: 0,
        behind: 0,
      }),
    };
    const gitBridge = new SessionBridge({
      gitResolver: mockGitResolver,
      config: { port: 3456 },
      logger: noopLogger,
    });

    // Seed state (simulating launcher.launch + seedSessionState)
    gitBridge.seedSessionState("seed-7", { cwd: "/project", model: "opus" });

    // Consumer connects before backend
    const ws = createMockSocket();
    gitBridge.handleConsumerOpen(ws, authContext("seed-7"));

    // Consumer should receive session_init with seeded state
    const parsed = ws.sentMessages.map((m: string) => JSON.parse(m));
    const initMsg = parsed.find((m: any) => m.type === "session_init");
    expect(initMsg).toBeDefined();
    expect(initMsg.session.cwd).toBe("/project");
    expect(initMsg.session.model).toBe("opus");
    expect(initMsg.session.git_branch).toBe("develop");
  });
});

// ─── Behavior lock: lifecycle signal dispatch ─────────────────────────────────

describe("SessionBridge — lifecycle signal dispatch (behavior lock)", () => {
  let bridge: SessionBridgeType;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  it("backend:connected transitions lifecycle to active", async () => {
    await bridge.connectBackend("sess-1");
    expect(bridge.getLifecycleState("sess-1")).toBe("active");
  });

  it("backend:disconnected transitions lifecycle to degraded", async () => {
    await bridge.connectBackend("sess-1");
    expect(bridge.getLifecycleState("sess-1")).toBe("active");

    await bridge.disconnectBackend("sess-1");
    expect(bridge.getLifecycleState("sess-1")).toBe("degraded");
  });

  it("session:closed transitions lifecycle to closed (session removed)", async () => {
    await bridge.connectBackend("sess-1");
    expect(bridge.getLifecycleState("sess-1")).toBe("active");

    await bridge.closeSession("sess-1");
    // Session is removed after close — getLifecycleState returns undefined
    expect(bridge.getLifecycleState("sess-1")).toBeUndefined();
  });

  it("non-lifecycle event types do NOT trigger handleSignal", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    // Push a regular message — forwardEvent("backend:message", ...) should
    // NOT call handleSignal; lifecycle state stays "active"
    backendSession.pushMessage(makeAssistantUnifiedMsg());
    await tick();

    expect(bridge.getLifecycleState("sess-1")).toBe("active");
  });
});

// ─── Behavior lock: connectBackend event ordering ─────────────────────────────

describe("SessionBridge — connectBackend event ordering (behavior lock)", () => {
  let bridge: SessionBridgeType;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  it("backend:connected is emitted before backend:session_id", async () => {
    const events: string[] = [];

    bridge.on("backend:connected", () => events.push("backend:connected"));
    bridge.on("backend:session_id", () => events.push("backend:session_id"));

    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    // At this point only backend:connected should have fired
    expect(events).toEqual(["backend:connected"]);

    // backend:session_id arrives later via system_init from the CLI
    backendSession.pushMessage(makeSessionInitMsg({ session_id: "cli-xyz" }));
    await tick();

    expect(events).toEqual(["backend:connected", "backend:session_id"]);
  });

  it("backend:session_id does NOT fire until system_init arrives", async () => {
    const sessionIdHandler = vi.fn();
    bridge.on("backend:session_id", sessionIdHandler);

    await bridge.connectBackend("sess-1");

    // Not yet — no system_init has been pushed
    expect(sessionIdHandler).not.toHaveBeenCalled();

    const backendSession = adapter.getSession("sess-1")!;
    backendSession.pushMessage(makeSessionInitMsg({ session_id: "cli-abc" }));
    await tick();

    expect(sessionIdHandler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      backendSessionId: "cli-abc",
    });
  });
});
