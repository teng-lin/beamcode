import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import {
  createBridgeWithAdapter,
  MockBackendAdapter,
  type MockBackendSession,
  makeAssistantUnifiedMsg,
  makeAuthStatusUnifiedMsg,
  makePermissionRequestUnifiedMsg,
  makeResultUnifiedMsg,
  makeSessionInitMsg,
  makeStatusChangeMsg,
  makeStreamEventUnifiedMsg,
  makeToolProgressUnifiedMsg,
  makeToolUseSummaryUnifiedMsg,
  noopLogger,
  tick,
} from "../testing/adapter-test-helpers.js";
import {
  noopLogger as _cliNoopLogger,
  authContext,
  createTestSocket as createMockSocket,
} from "../testing/cli-message-factories.js";
import { SessionBridge } from "./session-bridge.js";
import { createUnifiedMessage } from "./types/unified-message.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — CLI message routing", () => {
  let bridge: SessionBridge;
  let adapter: MockBackendAdapter;
  let backendSession: MockBackendSession;
  let consumerSocket: ReturnType<typeof createMockSocket>;

  beforeEach(async () => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;

    // Connect backend (replaces handleCLIOpen)
    await bridge.connectBackend("sess-1");
    backendSession = adapter.getSession("sess-1")!;

    // Connect consumer
    consumerSocket = createMockSocket();
    bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
    consumerSocket.sentMessages.length = 0;
  });

  it("system init updates session state and emits backend:session_id", async () => {
    const handler = vi.fn();
    bridge.on("backend:session_id", handler);

    backendSession.pushMessage(makeSessionInitMsg({ session_id: "cli-abc" }));
    await tick();

    expect(handler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      backendSessionId: "cli-abc",
    });

    const state = bridge.getSession("sess-1")!.state;
    expect(state.model).toBe("claude-sonnet-4-5-20250929");
    expect(state.cwd).toBe("/test");
    expect(state.tools).toEqual(["Bash", "Read"]);
    expect(state.permissionMode).toBe("default");
    expect(state.claude_code_version).toBe("1.0");
  });

  it("system init broadcasts session_init to consumers", async () => {
    backendSession.pushMessage(makeSessionInitMsg());
    await tick();

    const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
    const initMsg = parsed.find((m: any) => m.type === "session_init");
    expect(initMsg).toBeDefined();
    expect(initMsg.session.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("system status updates is_compacting and broadcasts status_change", async () => {
    backendSession.pushMessage(makeStatusChangeMsg({ status: "compacting" }));
    await tick();

    const state = bridge.getSession("sess-1")!.state;
    expect(state.is_compacting).toBe(true);

    const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
    expect(parsed.some((m: any) => m.type === "status_change" && m.status === "compacting")).toBe(
      true,
    );
  });

  it("system status with null status clears is_compacting", async () => {
    // First set compacting
    backendSession.pushMessage(makeStatusChangeMsg({ status: "compacting" }));
    await tick();
    expect(bridge.getSession("sess-1")!.state.is_compacting).toBe(true);

    // Then clear it
    backendSession.pushMessage(makeStatusChangeMsg({ status: null }));
    await tick();
    expect(bridge.getSession("sess-1")!.state.is_compacting).toBe(false);
  });

  it("system status with permissionMode updates session state", async () => {
    backendSession.pushMessage(makeStatusChangeMsg({ permissionMode: "plan" }));
    await tick();
    expect(bridge.getSession("sess-1")!.state.permissionMode).toBe("plan");
  });

  it("system status with permissionMode broadcasts session_update to consumers", async () => {
    backendSession.pushMessage(makeStatusChangeMsg({ permissionMode: "plan" }));
    await tick();

    const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
    const updateMsg = parsed.find(
      (m: any) => m.type === "session_update" && m.session?.permissionMode,
    );
    expect(updateMsg).toBeDefined();
    expect(updateMsg.session.permissionMode).toBe("plan");
  });

  it("system status without permissionMode does not broadcast session_update", async () => {
    backendSession.pushMessage(makeStatusChangeMsg({ status: "idle" }));
    await tick();

    const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
    const updateMsg = parsed.find((m: any) => m.type === "session_update");
    expect(updateMsg).toBeUndefined();
  });

  it("assistant message is stored in history and broadcast", async () => {
    backendSession.pushMessage(makeAssistantUnifiedMsg());
    await tick();

    const snapshot = bridge.getSession("sess-1")!;
    expect(snapshot.messageHistoryLength).toBe(1);

    const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
    const assistantMsg = parsed.find((m: any) => m.type === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.message.content[0].text).toBe("Hello world");
    expect(assistantMsg.parent_tool_use_id).toBeNull();
  });

  it("result message updates session cost/turns and broadcasts", async () => {
    backendSession.pushMessage(
      makeResultUnifiedMsg({
        total_cost_usd: 0.05,
        num_turns: 3,
        total_lines_added: 10,
        total_lines_removed: 5,
      }),
    );
    await tick();

    const state = bridge.getSession("sess-1")!.state;
    expect(state.total_cost_usd).toBe(0.05);
    expect(state.num_turns).toBe(3);
    expect(state.total_lines_added).toBe(10);
    expect(state.total_lines_removed).toBe(5);

    const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
    expect(parsed.some((m: any) => m.type === "result")).toBe(true);
  });

  it("result message computes context_used_percent from modelUsage", async () => {
    backendSession.pushMessage(
      makeResultUnifiedMsg({
        modelUsage: {
          "claude-sonnet-4-5-20250929": {
            inputTokens: 5000,
            outputTokens: 5000,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            contextWindow: 200000,
            maxOutputTokens: 8192,
            costUSD: 0.01,
          },
        },
      }),
    );
    await tick();

    const state = bridge.getSession("sess-1")!.state;
    expect(state.context_used_percent).toBe(5); // (5000+5000)/200000*100 = 5
  });

  it("result with num_turns=1 and user message emits session:first_turn_completed", async () => {
    // First add a user message to history
    bridge.sendUserMessage("sess-1", "What is TypeScript?");

    const handler = vi.fn();
    bridge.on("session:first_turn_completed", handler);

    backendSession.pushMessage(makeResultUnifiedMsg({ num_turns: 1, is_error: false }));
    await tick();

    expect(handler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      firstUserMessage: "What is TypeScript?",
    });
  });

  it("result with is_error=true does not emit session:first_turn_completed", async () => {
    bridge.sendUserMessage("sess-1", "test");

    const handler = vi.fn();
    bridge.on("session:first_turn_completed", handler);

    backendSession.pushMessage(makeResultUnifiedMsg({ num_turns: 1, is_error: true }));
    await tick();

    expect(handler).not.toHaveBeenCalled();
  });

  it("result message refreshes git info and broadcasts session_update if changed", async () => {
    // Create a bridge with a mock gitResolver
    const mockGitResolver = {
      resolve: vi.fn().mockReturnValue({
        branch: "main",
        isWorktree: false,
        repoRoot: "/repo",
        ahead: 0,
        behind: 0,
      }),
    };
    const gitAdapter = new MockBackendAdapter();
    const gitBridge = new SessionBridge({
      gitResolver: mockGitResolver,
      config: { port: 3456 },
      logger: noopLogger,
      adapter: gitAdapter,
    });

    // Connect backend session
    await gitBridge.connectBackend("sess-1");
    const gitBackendSession = gitAdapter.getSession("sess-1")!;

    // Connect consumer
    const gitConsumerSocket = createMockSocket();
    gitBridge.handleConsumerOpen(gitConsumerSocket, authContext("sess-1"));

    // Trigger session_init so git info is initially resolved
    gitBackendSession.pushMessage(makeSessionInitMsg());
    await tick();
    gitConsumerSocket.sentMessages.length = 0;

    // Update the mock to return different git_ahead
    mockGitResolver.resolve.mockReturnValue({
      branch: "main",
      isWorktree: false,
      repoRoot: "/repo",
      ahead: 3,
      behind: 0,
    });

    // Send a result message — should trigger refreshGitInfo
    gitBackendSession.pushMessage(makeResultUnifiedMsg());
    await tick();

    // Should have broadcast a session_update with updated git_ahead
    const parsed = gitConsumerSocket.sentMessages.map((m: string) => JSON.parse(m));
    const updateMsg = parsed.find(
      (m: any) => m.type === "session_update" && m.session?.git_ahead !== undefined,
    );
    expect(updateMsg).toBeDefined();
    expect(updateMsg.session.git_ahead).toBe(3);
    expect(updateMsg.session.git_branch).toBe("main");

    // Session state should also be updated
    const state = gitBridge.getSession("sess-1")!.state;
    expect(state.git_ahead).toBe(3);
  });

  it("result message does not broadcast session_update when git info unchanged", async () => {
    const mockGitResolver = {
      resolve: vi.fn().mockReturnValue({
        branch: "main",
        isWorktree: false,
        repoRoot: "/repo",
        ahead: 0,
        behind: 0,
      }),
    };
    const gitAdapter = new MockBackendAdapter();
    const gitBridge = new SessionBridge({
      gitResolver: mockGitResolver,
      config: { port: 3456 },
      logger: noopLogger,
      adapter: gitAdapter,
    });

    await gitBridge.connectBackend("sess-1");
    const gitBackendSession = gitAdapter.getSession("sess-1")!;
    const gitConsumerSocket = createMockSocket();
    gitBridge.handleConsumerOpen(gitConsumerSocket, authContext("sess-1"));

    // Trigger session_init so git info is initially resolved
    gitBackendSession.pushMessage(makeSessionInitMsg());
    await tick();
    gitConsumerSocket.sentMessages.length = 0;

    // Git resolver returns same values — no change
    gitBackendSession.pushMessage(makeResultUnifiedMsg());
    await tick();

    // Should NOT have broadcast a session_update with git fields
    const parsed = gitConsumerSocket.sentMessages.map((m: string) => JSON.parse(m));
    const updateMsg = parsed.find(
      (m: any) => m.type === "session_update" && m.session?.git_ahead !== undefined,
    );
    expect(updateMsg).toBeUndefined();
  });

  it("stream_event is broadcast to consumers", async () => {
    backendSession.pushMessage(makeStreamEventUnifiedMsg());
    await tick();

    const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
    const streamMsg = parsed.find((m: any) => m.type === "stream_event");
    expect(streamMsg).toBeDefined();
    expect(streamMsg.parent_tool_use_id).toBeNull();
  });

  it("control_request (can_use_tool) stores permission and broadcasts", async () => {
    const permHandler = vi.fn();
    bridge.on("permission:requested", permHandler);

    backendSession.pushMessage(makePermissionRequestUnifiedMsg());
    await tick();

    const snapshot = bridge.getSession("sess-1")!;
    expect(snapshot.pendingPermissions).toHaveLength(1);
    expect(snapshot.pendingPermissions[0].tool_name).toBe("Bash");

    const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
    expect(parsed.some((m: any) => m.type === "permission_request")).toBe(true);

    expect(permHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        request: expect.objectContaining({ tool_name: "Bash" }),
      }),
    );
  });

  it("tool_progress is broadcast to consumers", async () => {
    backendSession.pushMessage(makeToolProgressUnifiedMsg());
    await tick();

    const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
    const progressMsg = parsed.find((m: any) => m.type === "tool_progress");
    expect(progressMsg).toBeDefined();
    expect(progressMsg.tool_use_id).toBe("tu-1");
    expect(progressMsg.tool_name).toBe("Bash");
    expect(progressMsg.elapsed_time_seconds).toBe(5);
  });

  it("tool_use_summary is broadcast to consumers", async () => {
    backendSession.pushMessage(makeToolUseSummaryUnifiedMsg());
    await tick();

    const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
    const summaryMsg = parsed.find((m: any) => m.type === "tool_use_summary");
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg.summary).toBe("Ran bash command");
    expect(summaryMsg.tool_use_ids).toEqual(["tu-1", "tu-2"]);
  });

  it("auth_status is broadcast to consumers and emitted as event", async () => {
    const handler = vi.fn();
    bridge.on("auth_status", handler);

    backendSession.pushMessage(makeAuthStatusUnifiedMsg());
    await tick();

    const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
    const authMsg = parsed.find((m: any) => m.type === "auth_status");
    expect(authMsg).toBeDefined();
    expect(authMsg.isAuthenticating).toBe(true);
    expect(authMsg.output).toEqual(["Authenticating..."]);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        isAuthenticating: true,
        output: ["Authenticating..."],
      }),
    );
  });

  it("status_change preserves step metadata for consumers", async () => {
    backendSession.pushMessage(
      createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: {
          status: "running",
          step: "start",
          step_id: "step-1",
          message_id: "msg-1",
        },
      }),
    );
    await tick();

    const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
    const statusMsg = parsed.find((m: any) => m.type === "status_change");
    expect(statusMsg).toBeDefined();
    expect(statusMsg.status).toBe("running");
    expect(statusMsg.metadata.step).toBe("start");
    expect(statusMsg.metadata.step_id).toBe("step-1");
  });

  it("handles fabricated message type via default case", async () => {
    const msg = createUnifiedMessage({
      type: "unknown",
      role: "system",
      metadata: { raw: "fabricated" },
    });
    // Override type to something not in the union to test default branch
    (msg as any).type = "fabricated_future_type";
    backendSession.pushMessage(msg);
    await tick();
    // Should not throw
    expect(consumerSocket.sentMessages).toHaveLength(0);
  });

  it("keep_alive is silently consumed (no broadcast)", async () => {
    // In the adapter path, keep_alive maps to "unknown" type which is not
    // handled by routeUnifiedMessage's switch, so nothing is broadcast.
    backendSession.pushMessage(
      createUnifiedMessage({
        type: "unknown",
        role: "system",
        metadata: { originalType: "keep_alive" },
      }),
    );
    await tick();

    // Only message:outbound events from the broadcastToConsumers function.
    // keep_alive should NOT produce any consumer messages.
    expect(consumerSocket.sentMessages).toHaveLength(0);
  });
});
