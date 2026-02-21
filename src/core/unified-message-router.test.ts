import { beforeEach, describe, expect, it, vi } from "vitest";
import { noopTracer } from "./message-tracer.js";
import { makeDefaultState, type Session } from "./session-repository.js";
import { createUnifiedMessage, type UnifiedMessage } from "./types/unified-message.js";
import { UnifiedMessageRouter, type UnifiedMessageRouterDeps } from "./unified-message-router.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockBroadcaster() {
  return {
    broadcast: vi.fn(),
    broadcastToParticipants: vi.fn(),
  };
}

function createMockCapabilitiesPolicy() {
  return {
    sendInitializeRequest: vi.fn(),
    applyCapabilities: vi.fn(),
    handleControlResponse: vi.fn(),
  };
}

function createMockQueueHandler() {
  return {
    autoSendQueuedMessage: vi.fn(),
  };
}

function createMockGitTracker() {
  return {
    resetAttempt: vi.fn(),
    resolveGitInfo: vi.fn(),
    refreshGitInfo: vi.fn().mockReturnValue(null),
  };
}

function createMockGitResolver() {
  return {
    resolve: vi.fn().mockReturnValue(null),
  };
}

function createMockSession(id = "sess-1", stateOverrides: Record<string, unknown> = {}): Session {
  const state = { ...makeDefaultState(id), ...stateOverrides };
  return {
    id,
    backendSession: null,
    backendAbort: null,
    consumerSockets: new Map(),
    consumerRateLimiters: new Map(),
    anonymousCounter: 0,
    state,
    pendingPermissions: new Map(),
    messageHistory: [],
    pendingMessages: [],
    queuedMessage: null,
    lastStatus: null,
    lastActivity: Date.now(),
    pendingInitialize: null,
    teamCorrelationBuffer: {
      onToolUse: vi.fn(),
      onToolResult: vi.fn().mockReturnValue(null),
      flush: vi.fn().mockReturnValue(0),
      get pendingCount() {
        return 0;
      },
    } as any,
    registry: {
      clearDynamic: vi.fn(),
      registerFromCLI: vi.fn(),
      registerSkills: vi.fn(),
    } as any,
    pendingPassthroughs: [],
    adapterName: undefined,
    adapterSlashExecutor: null,
    adapterSupportsSlashPassthrough: false,
  };
}

function createDeps(overrides: Partial<UnifiedMessageRouterDeps> = {}): UnifiedMessageRouterDeps {
  return {
    broadcaster: createMockBroadcaster(),
    capabilitiesPolicy: createMockCapabilitiesPolicy(),
    queueHandler: createMockQueueHandler(),
    gitTracker: createMockGitTracker(),
    gitResolver: createMockGitResolver(),
    emitEvent: vi.fn(),
    persistSession: vi.fn(),
    maxMessageHistoryLength: 100,
    tracer: noopTracer,
    getState: (session) => session.state,
    setState: (session, state) => {
      session.state = state;
    },
    setBackendSessionId: (session, backendSessionId) => {
      session.backendSessionId = backendSessionId;
    },
    getMessageHistory: (session) => session.messageHistory,
    setMessageHistory: (session, history) => {
      session.messageHistory = history;
    },
    getLastStatus: (session) => session.lastStatus,
    setLastStatus: (session, status) => {
      session.lastStatus = status;
    },
    storePendingPermission: (session, requestId, request) => {
      session.pendingPermissions.set(requestId, request);
    },
    clearDynamicSlashRegistry: (session) => {
      session.registry.clearDynamic();
    },
    registerCLICommands: (session, commands) => {
      session.registry.registerFromCLI(commands);
    },
    registerSkillCommands: (session, skills) => {
      session.registry.registerSkills(skills);
    },
    ...overrides,
  };
}

function msg(type: string, metadata: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: type as any,
    role: "system",
    metadata,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UnifiedMessageRouter", () => {
  let deps: UnifiedMessageRouterDeps;
  let router: UnifiedMessageRouter;
  let session: Session;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createDeps();
    router = new UnifiedMessageRouter(deps);
    session = createMockSession();
  });

  // ── session_init ──────────────────────────────────────────────────────

  describe("session_init", () => {
    it("stores backend session ID and emits event", () => {
      const m = msg("session_init", { session_id: "backend-42", model: "claude" });
      router.route(session, m);

      expect(session.backendSessionId).toBe("backend-42");
      expect(deps.emitEvent).toHaveBeenCalledWith("backend:session_id", {
        sessionId: "sess-1",
        backendSessionId: "backend-42",
      });
    });

    it("uses setBackendSessionId callback when provided", () => {
      const setBackendSessionId = vi.fn();
      deps = createDeps({ setBackendSessionId });
      router = new UnifiedMessageRouter(deps);

      const m = msg("session_init", { session_id: "backend-42", model: "claude" });
      router.route(session, m);

      expect(setBackendSessionId).toHaveBeenCalledWith(session, "backend-42");
      expect(session.backendSessionId).toBeUndefined();
    });

    it("uses getState/setState callbacks for authMethods updates", () => {
      let state = session.state;
      deps = createDeps({
        getState: () => state,
        setState: (_session, next) => {
          state = next;
        },
      });
      router = new UnifiedMessageRouter(deps);

      const m = msg("session_init", {
        model: "claude",
        authMethods: ["device_code"],
      });
      router.route(session, m);

      expect(state.authMethods).toEqual(["device_code"]);
      expect(session.state.authMethods).toBeUndefined();
    });

    it("sends initialize request when no capabilities in metadata", () => {
      const m = msg("session_init", { model: "claude" });
      router.route(session, m);

      expect(deps.capabilitiesPolicy.sendInitializeRequest).toHaveBeenCalledWith(session);
      expect(deps.capabilitiesPolicy.applyCapabilities).not.toHaveBeenCalled();
    });

    it("applies capabilities when provided in metadata", () => {
      const caps = {
        commands: [{ name: "/help", description: "Help" }],
        models: [{ value: "claude-sonnet", displayName: "Sonnet" }],
        account: { email: "test@test.com" },
      };
      const m = msg("session_init", { capabilities: caps });
      router.route(session, m);

      expect(deps.capabilitiesPolicy.applyCapabilities).toHaveBeenCalledWith(
        session,
        caps.commands,
        caps.models,
        caps.account,
      );
      expect(deps.capabilitiesPolicy.sendInitializeRequest).not.toHaveBeenCalled();
    });

    it("broadcasts session_init and persists", () => {
      const m = msg("session_init", { model: "claude" });
      router.route(session, m);

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "session_init" }),
      );
      expect(deps.persistSession).toHaveBeenCalledWith(session);
    });

    it("resolves git info when cwd is set", () => {
      session.state.cwd = "/projects/test";
      const gitResolver = createMockGitResolver();
      gitResolver.resolve.mockReturnValue({
        branch: "main",
        isWorktree: false,
        repoRoot: "/projects/test",
        ahead: 0,
        behind: 0,
      });
      deps = createDeps({ gitResolver });
      router = new UnifiedMessageRouter(deps);

      const m = msg("session_init", { model: "claude", cwd: "/projects/test" });
      router.route(session, m);

      expect(deps.gitTracker.resetAttempt).toHaveBeenCalledWith("sess-1");
    });

    it("registers slash commands and skills from session state", () => {
      session.state.slash_commands = ["/help", "/clear"];
      session.state.skills = ["golang-testing"];

      const m = msg("session_init", {
        slash_commands: ["/help", "/clear"],
        skills: ["golang-testing"],
      });
      router.route(session, m);

      expect(session.registry.clearDynamic).toHaveBeenCalled();
      expect(session.registry.registerFromCLI).toHaveBeenCalled();
      expect(session.registry.registerSkills).toHaveBeenCalled();
    });
  });

  // ── status_change ─────────────────────────────────────────────────────

  describe("status_change", () => {
    it("updates lastStatus and broadcasts", () => {
      const m = msg("status_change", { status: "running" });
      router.route(session, m);

      expect(session.lastStatus).toBe("running");
      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "status_change", status: "running" }),
      );
    });

    it("auto-sends queued message on idle", () => {
      const m = msg("status_change", { status: "idle" });
      router.route(session, m);

      expect(deps.queueHandler.autoSendQueuedMessage).toHaveBeenCalledWith(session);
    });

    it("does not auto-send queued message when not idle", () => {
      const m = msg("status_change", { status: "running" });
      router.route(session, m);

      expect(deps.queueHandler.autoSendQueuedMessage).not.toHaveBeenCalled();
    });

    it("broadcasts permissionMode change when present", () => {
      session.state.permissionMode = "bypassPermissions";
      const m = msg("status_change", { status: "idle", permissionMode: "bypassPermissions" });
      router.route(session, m);

      // Should broadcast both status_change and session_update
      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      const sessionUpdateCall = broadcastCalls.find(
        (call: unknown[]) => (call[1] as any).type === "session_update",
      );
      expect(sessionUpdateCall).toBeDefined();
    });
  });

  // ── assistant ─────────────────────────────────────────────────────────

  describe("assistant", () => {
    it("adds to history and broadcasts", () => {
      const m = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        metadata: {
          message_id: "msg-1",
          model: "claude",
          stop_reason: "end_turn",
          parent_tool_use_id: null,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
      router.route(session, m);

      expect(session.messageHistory).toHaveLength(1);
      expect(deps.broadcaster.broadcast).toHaveBeenCalled();
      expect(deps.persistSession).toHaveBeenCalledWith(session);
    });

    it("uses message history callbacks when provided", () => {
      let history: Session["messageHistory"] = [];
      deps = createDeps({
        getMessageHistory: () => history,
        setMessageHistory: (_session, next) => {
          history = next;
        },
      });
      router = new UnifiedMessageRouter(deps);

      const m = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        metadata: {
          message_id: "msg-callback-1",
          model: "claude",
          stop_reason: "end_turn",
          parent_tool_use_id: null,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
      router.route(session, m);

      expect(history).toHaveLength(1);
      expect(session.messageHistory).toHaveLength(0);
    });

    it("trims message history when exceeding max length", () => {
      deps = createDeps({ maxMessageHistoryLength: 2 });
      router = new UnifiedMessageRouter(deps);

      // Add 3 messages
      for (let i = 0; i < 3; i++) {
        const m = createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text: `msg-${i}` }],
          metadata: {
            message_id: `msg-${i}`,
            model: "claude",
            stop_reason: "end_turn",
            parent_tool_use_id: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        });
        router.route(session, m);
      }

      expect(session.messageHistory).toHaveLength(2);
    });

    it("preserves empty assistant content without stream backfill", () => {
      const stream = msg("stream_event", {
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "stream text" },
        },
      });
      router.route(session, stream);

      const emptyAssistant = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [],
        metadata: {
          message_id: "msg-empty",
          model: "claude",
          stop_reason: "end_turn",
          parent_tool_use_id: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
      router.route(session, emptyAssistant);

      const last = session.messageHistory[session.messageHistory.length - 1];
      expect(last.type).toBe("assistant");
      if (last.type === "assistant") {
        expect(last.message.content).toEqual([]);
      }
    });

    it("drops duplicate assistant events with same message id and content", () => {
      const m = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "same" }],
        metadata: {
          message_id: "msg-dup",
          model: "claude",
          stop_reason: "end_turn",
          parent_tool_use_id: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });

      router.route(session, m);
      router.route(session, m);

      expect(session.messageHistory).toHaveLength(1);
      expect(deps.broadcaster.broadcast).toHaveBeenCalledTimes(1);
    });

    it("updates prior assistant entry when same message id has new content", () => {
      const first = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "first" }],
        metadata: {
          message_id: "msg-update",
          model: "claude",
          stop_reason: "end_turn",
          parent_tool_use_id: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
      const second = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "second" }],
        metadata: {
          message_id: "msg-update",
          model: "claude",
          stop_reason: "end_turn",
          parent_tool_use_id: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });

      router.route(session, first);
      router.route(session, second);

      expect(session.messageHistory).toHaveLength(1);
      const item = session.messageHistory[0];
      expect(item.type).toBe("assistant");
      if (item.type === "assistant") {
        expect(item.message.id).toBe("msg-update");
        expect(item.message.content).toEqual([{ type: "text", text: "second" }]);
      }
      expect(deps.broadcaster.broadcast).toHaveBeenCalledTimes(2);
    });
  });

  // ── result ────────────────────────────────────────────────────────────

  describe("result", () => {
    it("marks session idle and triggers auto-send", () => {
      const m = msg("result", {
        subtype: "success",
        is_error: false,
        num_turns: 2, // Deliberately not 1 — avoids triggering first_turn_completed path
        total_cost_usd: 0.01,
      });
      router.route(session, m);

      expect(session.lastStatus).toBe("idle");
      expect(deps.queueHandler.autoSendQueuedMessage).toHaveBeenCalledWith(session);
    });

    it("emits first_turn_completed on first non-error turn", () => {
      // Add a user message to history
      session.messageHistory.push({
        type: "user_message",
        content: "What is Vitest?",
      } as any);

      const m = msg("result", {
        subtype: "success",
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.01,
      });
      router.route(session, m);

      expect(deps.emitEvent).toHaveBeenCalledWith("session:first_turn_completed", {
        sessionId: "sess-1",
        firstUserMessage: "What is Vitest?",
      });
    });

    it("does not emit first_turn_completed on error", () => {
      session.messageHistory.push({
        type: "user_message",
        content: "Hello",
      } as any);

      const m = msg("result", {
        subtype: "error_during_execution",
        is_error: true,
        num_turns: 1,
      });
      router.route(session, m);

      expect(deps.emitEvent).not.toHaveBeenCalledWith(
        "session:first_turn_completed",
        expect.anything(),
      );
    });

    it("refreshes git info after result", () => {
      const gitTracker = createMockGitTracker();
      gitTracker.refreshGitInfo.mockReturnValue({
        git_branch: "feature",
        git_ahead: 1,
        git_behind: 0,
        is_worktree: false,
      });
      deps = createDeps({ gitTracker });
      router = new UnifiedMessageRouter(deps);

      const m = msg("result", { subtype: "success", is_error: false, num_turns: 2 });
      router.route(session, m);

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          type: "session_update",
          session: expect.objectContaining({ git_branch: "feature" }),
        }),
      );
    });
  });

  // ── stream_event ──────────────────────────────────────────────────────

  describe("stream_event", () => {
    it("infers running status from message_start (not sub-agent)", () => {
      const m = msg("stream_event", {
        event: { type: "message_start" },
        parent_tool_use_id: undefined,
      });
      router.route(session, m);

      expect(session.lastStatus).toBe("running");
      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "status_change", status: "running" }),
      );
    });

    it("does not set running for sub-agent message_start", () => {
      const m = msg("stream_event", {
        event: { type: "message_start" },
        parent_tool_use_id: "tu-123",
      });
      router.route(session, m);

      expect(session.lastStatus).not.toBe("running");
    });

    it("does not set running for non-message_start events", () => {
      const m = msg("stream_event", {
        event: { type: "content_block_delta" },
      });
      router.route(session, m);

      expect(session.lastStatus).not.toBe("running");
    });
  });

  // ── permission_request ────────────────────────────────────────────────

  describe("permission_request", () => {
    it("stores pending permission and broadcasts to participants", () => {
      const m = msg("permission_request", {
        request_id: "perm-1",
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "tu-1",
      });
      router.route(session, m);

      expect(session.pendingPermissions.has("perm-1")).toBe(true);
      expect(deps.broadcaster.broadcastToParticipants).toHaveBeenCalled();
      expect(deps.emitEvent).toHaveBeenCalledWith(
        "permission:requested",
        expect.objectContaining({ sessionId: "sess-1" }),
      );
      expect(deps.persistSession).toHaveBeenCalledWith(session);
    });

    it("skips non-can_use_tool subtypes", () => {
      const m = msg("permission_request", {
        subtype: "other_type",
        request_id: "perm-1",
        tool_name: "Bash",
        input: {},
        tool_use_id: "tu-1",
      });
      router.route(session, m);

      expect(session.pendingPermissions.has("perm-1")).toBe(false);
      expect(deps.broadcaster.broadcastToParticipants).not.toHaveBeenCalled();
    });

    it("uses storePendingPermission callback when provided", () => {
      const storePendingPermission = vi.fn();
      deps = createDeps({ storePendingPermission });
      router = new UnifiedMessageRouter(deps);

      const m = msg("permission_request", {
        request_id: "perm-1",
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "tu-1",
      });
      router.route(session, m);

      expect(storePendingPermission).toHaveBeenCalledWith(
        session,
        "perm-1",
        expect.objectContaining({
          request_id: "perm-1",
          tool_name: "Bash",
          tool_use_id: "tu-1",
        }),
      );
      expect(session.pendingPermissions.has("perm-1")).toBe(false);
    });
  });

  // ── control_response ──────────────────────────────────────────────────

  describe("control_response", () => {
    it("delegates to capabilitiesPolicy", () => {
      const m = msg("control_response", { request_id: "req-1", subtype: "success" });
      router.route(session, m);

      expect(deps.capabilitiesPolicy.handleControlResponse).toHaveBeenCalledWith(session, m);
    });
  });

  // ── tool_progress ─────────────────────────────────────────────────────

  describe("tool_progress", () => {
    it("broadcasts tool progress", () => {
      const m = msg("tool_progress", {
        tool_use_id: "tu-1",
        tool_name: "Bash",
        elapsed_time_seconds: 5,
      });
      router.route(session, m);

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "tool_progress" }),
      );
    });
  });

  // ── tool_use_summary ──────────────────────────────────────────────────

  describe("tool_use_summary", () => {
    it("persists and broadcasts tool use summary", () => {
      const m = msg("tool_use_summary", {
        summary: "Ran command",
        tool_use_id: "tu-1",
        tool_use_ids: ["tu-1"],
        output: "ok",
      });
      router.route(session, m);

      expect(session.messageHistory).toHaveLength(1);
      expect(session.messageHistory[0]).toEqual(
        expect.objectContaining({
          type: "tool_use_summary",
          tool_use_id: "tu-1",
          output: "ok",
        }),
      );
      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "tool_use_summary" }),
      );
      expect(deps.persistSession).toHaveBeenCalledWith(session);
    });

    it("drops duplicate tool summaries with same tool_use_id and payload", () => {
      const m = msg("tool_use_summary", {
        summary: "Ran command",
        tool_use_id: "tu-dup",
        tool_use_ids: ["tu-dup"],
        output: "ok",
      });

      router.route(session, m);
      router.route(session, m);

      expect(session.messageHistory).toHaveLength(1);
      expect(deps.broadcaster.broadcast).toHaveBeenCalledTimes(1);
    });

    it("updates existing tool summary when same tool_use_id has new output", () => {
      const first = msg("tool_use_summary", {
        summary: "Ran command",
        tool_use_id: "tu-update",
        tool_use_ids: ["tu-update"],
        output: "line 1",
      });
      const second = msg("tool_use_summary", {
        summary: "Ran command",
        tool_use_id: "tu-update",
        tool_use_ids: ["tu-update"],
        output: "line 1\nline 2",
      });

      router.route(session, first);
      router.route(session, second);

      expect(session.messageHistory).toHaveLength(1);
      expect(session.messageHistory[0]).toEqual(
        expect.objectContaining({
          type: "tool_use_summary",
          tool_use_id: "tu-update",
          output: "line 1\nline 2",
        }),
      );
      expect(deps.broadcaster.broadcast).toHaveBeenCalledTimes(2);
    });
  });

  // ── auth_status ───────────────────────────────────────────────────────

  describe("auth_status", () => {
    it("broadcasts and emits auth_status event", () => {
      const m = msg("auth_status", {
        isAuthenticating: true,
        output: ["Authenticating..."],
      });
      router.route(session, m);

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "auth_status" }),
      );
      expect(deps.emitEvent).toHaveBeenCalledWith(
        "auth_status",
        expect.objectContaining({
          sessionId: "sess-1",
          isAuthenticating: true,
        }),
      );
    });
  });

  // ── configuration_change ──────────────────────────────────────────────

  describe("configuration_change", () => {
    it("broadcasts model patch via session_update", () => {
      const m = msg("configuration_change", { model: "claude-opus" });
      router.route(session, m);

      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      const updateCall = broadcastCalls.find(
        (call: unknown[]) => (call[1] as any).type === "session_update",
      );
      expect(updateCall).toBeDefined();
      expect((updateCall![1] as any).session.model).toBe("claude-opus");
      expect(deps.persistSession).toHaveBeenCalled();
    });

    it("broadcasts permissionMode from mode field", () => {
      const m = msg("configuration_change", { mode: "bypassPermissions" });
      router.route(session, m);

      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      const updateCall = broadcastCalls.find(
        (call: unknown[]) =>
          (call[1] as any).type === "session_update" &&
          (call[1] as any).session?.permissionMode !== undefined,
      );
      expect(updateCall).toBeDefined();
    });

    it("broadcasts permissionMode from permissionMode field", () => {
      const m = msg("configuration_change", { permissionMode: "plan" });
      router.route(session, m);

      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      const updateCall = broadcastCalls.find(
        (call: unknown[]) =>
          (call[1] as any).type === "session_update" &&
          (call[1] as any).session?.permissionMode !== undefined,
      );
      expect(updateCall).toBeDefined();
    });

    it("persists when patch has keys", () => {
      const m = msg("configuration_change", { model: "claude-opus" });
      router.route(session, m);

      expect(deps.persistSession).toHaveBeenCalledWith(session);
    });

    it("does not broadcast session_update when no model or mode", () => {
      const m = msg("configuration_change", { unrelated: true });
      router.route(session, m);

      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      // Should have the configuration_change broadcast but no session_update
      const updateCall = broadcastCalls.find(
        (call: unknown[]) => (call[1] as any).type === "session_update",
      );
      expect(updateCall).toBeUndefined();
    });
  });

  // ── session_lifecycle ─────────────────────────────────────────────────

  describe("session_lifecycle", () => {
    it("broadcasts session lifecycle message", () => {
      const m = msg("session_lifecycle", { subtype: "resumed" });
      router.route(session, m);

      expect(deps.broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "session_lifecycle" }),
      );
    });
  });

  // ── emitTeamEvents ────────────────────────────────────────────────────

  describe("emitTeamEvents", () => {
    it("skips broadcast when team state is unchanged (same reference)", () => {
      const teamState = { name: "team-1", role: "lead" as const, members: [], tasks: [] };
      session.state.team = teamState;

      // Route a message that doesn't change team state
      const m = msg("status_change", { status: "idle" });
      router.route(session, m);

      // session_update with team should NOT have been broadcast (only status_change)
      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      const teamUpdateCall = broadcastCalls.find(
        (call: unknown[]) =>
          (call[1] as any).type === "session_update" && "team" in ((call[1] as any).session ?? {}),
      );
      expect(teamUpdateCall).toBeUndefined();
    });

    it("broadcasts session_update with team:null when team is removed", () => {
      // Pre-set team state so the diff path detects deletion
      session.state.team = { name: "team-1", role: "lead" as const, members: [], tasks: [] };

      // Intercept the `session.state = reducedState` assignment inside route()
      // to simulate the reducer producing a state without team.
      const currentState = session.state;
      Object.defineProperty(session, "state", {
        get() {
          return currentState;
        },
        set(newState: typeof currentState) {
          // Clear team on the reduced state, simulating a team deletion
          newState.team = undefined;
          // Replace with normal writable property for subsequent reads
          Object.defineProperty(session, "state", {
            value: newState,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        },
        configurable: true,
        enumerable: true,
      });

      const m = msg("status_change", { status: "idle" });
      router.route(session, m);

      const broadcastCalls = (deps.broadcaster.broadcast as ReturnType<typeof vi.fn>).mock.calls;
      const teamUpdateCall = broadcastCalls.find(
        (call: unknown[]) =>
          (call[1] as any).type === "session_update" && "team" in ((call[1] as any).session ?? {}),
      );
      expect(teamUpdateCall).toBeDefined();
      // When team is deleted, broadcasts null (not undefined) so JSON preserves the key
      expect((teamUpdateCall![1] as any).session.team).toBeNull();

      // Verify diffTeamState events were emitted
      expect(deps.emitEvent).toHaveBeenCalled();
    });
  });
});
