/**
 * Characterization tests for backend → consumer message routing.
 *
 * These tests capture the exact shape of consumer messages produced when
 * backend messages flow through `routeUnifiedMessage()`. They serve as the
 * golden assertions for consumer compatibility during the BackendAdapter
 * migration.
 *
 * DO NOT modify the expected outputs without understanding the implications
 * for consumer compatibility.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import type { WebSocketLike } from "../interfaces/transport.js";
import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  tick,
  translateAndPush,
} from "../testing/adapter-test-helpers.js";
import type { ConsumerMessage } from "../types/consumer-messages.js";
import type { SessionBridge } from "./session-bridge.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockSocket(): WebSocketLike & {
  sentMessages: string[];
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const sentMessages: string[] = [];
  return {
    send: vi.fn((data: string) => sentMessages.push(data)),
    close: vi.fn(),
    sentMessages,
  };
}

/** Connect backend via adapter and a consumer socket to a session, return both. */
async function setupSession(
  bridge: SessionBridge,
  adapter: MockBackendAdapter,
  sessionId = "char-session",
) {
  const consumer = createMockSocket();

  await bridge.connectBackend(sessionId);
  const backendSession = adapter.getSession(sessionId)!;
  bridge.handleConsumerOpen(consumer, { sessionId, transport: {} });

  // Clear initial messages (backend_connected, identity, presence_update)
  consumer.sentMessages.length = 0;

  return { backendSession, consumer };
}

/** Parse last N consumer messages from the socket. */
function lastMessages(socket: { sentMessages: string[] }, n = 1): ConsumerMessage[] {
  return socket.sentMessages.slice(-n).map((s) => JSON.parse(s));
}

/** Parse all consumer messages from the socket. */
function allMessages(socket: { sentMessages: string[] }): ConsumerMessage[] {
  return socket.sentMessages.map((s) => JSON.parse(s));
}

// ─── Characterization Tests ──────────────────────────────────────────────────

describe("SessionBridge Characterization - Backend → Consumer Message Shapes", () => {
  let bridge: SessionBridge;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  it("system.init → session_init + capabilities_ready broadcast shape", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "cli-abc",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/home/user",
        tools: ["Bash", "Read"],
        permissionMode: "default",
        claude_code_version: "1.2.3",
        mcp_servers: [{ name: "test-mcp", status: "connected" }],
        slash_commands: ["compact", "help"],
        skills: ["tdd"],
        output_style: "normal",
        uuid: "uuid-init",
        apiKeySource: "env",
      }),
    );
    await tick();

    const msgs = allMessages(consumer);

    // Should broadcast session_init with full state
    const initMsg = msgs.find((m) => m.type === "session_init");
    expect(initMsg).toBeDefined();
    expect(initMsg!.type).toBe("session_init");
    expect((initMsg as any).session.model).toBe("claude-sonnet-4-5-20250929");
    expect((initMsg as any).session.cwd).toBe("/home/user");
    expect((initMsg as any).session.tools).toEqual(["Bash", "Read"]);
    expect((initMsg as any).session.permissionMode).toBe("default");
    expect((initMsg as any).session.claude_code_version).toBe("1.2.3");
    expect((initMsg as any).session.mcp_servers).toEqual([
      { name: "test-mcp", status: "connected" },
    ]);
    expect((initMsg as any).session.slash_commands).toEqual(["compact", "help"]);
    expect((initMsg as any).session.skills).toEqual(["tdd"]);
  });

  it("system.status → status_change broadcast shape", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: "compacting",
        uuid: "uuid-status",
        session_id: "cli-abc",
      }),
    );
    await tick();

    const msgs = lastMessages(consumer);
    expect(msgs[0]).toEqual({
      type: "status_change",
      status: "compacting",
    });
  });

  it("system.status null → status_change null broadcast shape", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: null,
        uuid: "uuid-status",
        session_id: "cli-abc",
      }),
    );
    await tick();

    const msgs = lastMessages(consumer);
    expect(msgs[0]).toEqual({
      type: "status_change",
      status: null,
    });
  });

  it("assistant → assistant broadcast shape", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    const assistantPayload = {
      type: "assistant",
      message: {
        id: "msg-001",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [
          { type: "text", text: "Hello world" },
          { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
        ],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
        },
      },
      parent_tool_use_id: "parent-tu-1",
      uuid: "uuid-assist",
      session_id: "cli-abc",
    };

    translateAndPush(backendSession, JSON.stringify(assistantPayload));
    await tick();

    const msgs = lastMessages(consumer);
    expect(msgs[0].type).toBe("assistant");
    expect((msgs[0] as any).message).toEqual(assistantPayload.message);
    expect((msgs[0] as any).parent_tool_use_id).toBe("parent-tu-1");
  });

  it("result → result broadcast shape", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done!",
        errors: [],
        duration_ms: 1234,
        duration_api_ms: 1000,
        num_turns: 3,
        total_cost_usd: 0.05,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 200,
          output_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 10,
        },
        modelUsage: {
          "claude-sonnet-4-5-20250929": {
            inputTokens: 200,
            outputTokens: 100,
            cacheReadInputTokens: 10,
            cacheCreationInputTokens: 20,
            contextWindow: 200000,
            maxOutputTokens: 8192,
            costUSD: 0.05,
          },
        },
        total_lines_added: 10,
        total_lines_removed: 5,
        uuid: "uuid-result",
        session_id: "cli-abc",
      }),
    );
    await tick();

    const msgs = lastMessages(consumer);
    expect(msgs[0].type).toBe("result");
    const data = (msgs[0] as any).data;
    expect(data.subtype).toBe("success");
    expect(data.is_error).toBe(false);
    expect(data.result).toBe("Done!");
    expect(data.errors).toEqual([]);
    expect(data.duration_ms).toBe(1234);
    expect(data.duration_api_ms).toBe(1000);
    expect(data.num_turns).toBe(3);
    expect(data.total_cost_usd).toBe(0.05);
    expect(data.stop_reason).toBe("end_turn");
    expect(data.total_lines_added).toBe(10);
    expect(data.total_lines_removed).toBe(5);
    expect(data.modelUsage).toBeDefined();
  });

  it("stream_event → stream_event broadcast shape", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_start", index: 0 },
        parent_tool_use_id: "parent-tu-2",
        uuid: "uuid-stream",
        session_id: "cli-abc",
      }),
    );
    await tick();

    const msgs = lastMessages(consumer);
    expect(msgs[0]).toEqual({
      type: "stream_event",
      event: { type: "content_block_start", index: 0 },
      parent_tool_use_id: "parent-tu-2",
    });
  });

  it("control_request (can_use_tool) → permission_request broadcast shape", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "control_request",
        request_id: "perm-req-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "rm -rf /" },
          permission_suggestions: [{ type: "allow_once" }],
          description: "Execute dangerous command",
          tool_use_id: "tu-perm-1",
          agent_id: "agent-a",
        },
      }),
    );
    await tick();

    const msgs = lastMessages(consumer);
    expect(msgs[0].type).toBe("permission_request");
    const req = (msgs[0] as any).request;
    expect(req.request_id).toBe("perm-req-1");
    expect(req.tool_name).toBe("Bash");
    expect(req.input).toEqual({ command: "rm -rf /" });
    expect(req.permission_suggestions).toEqual([{ type: "allow_once" }]);
    expect(req.description).toBe("Execute dangerous command");
    expect(req.tool_use_id).toBe("tu-perm-1");
    expect(req.agent_id).toBe("agent-a");
    expect(req.timestamp).toBeTypeOf("number");
  });

  it("control_request (non-can_use_tool) → NOT broadcast", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "control_request",
        request_id: "other-req-1",
        request: {
          subtype: "other_subtype",
          tool_name: "Bash",
          input: {},
        },
      }),
    );
    await tick();

    const msgs = allMessages(consumer);
    expect(msgs.filter((m) => m.type === "permission_request")).toHaveLength(0);
  });

  it("tool_progress → tool_progress broadcast shape", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "tool_progress",
        tool_use_id: "tu-prog-1",
        tool_name: "Bash",
        elapsed_time_seconds: 5,
        uuid: "uuid-prog",
        session_id: "cli-abc",
      }),
    );
    await tick();

    const msgs = lastMessages(consumer);
    expect(msgs[0]).toEqual({
      type: "tool_progress",
      tool_use_id: "tu-prog-1",
      tool_name: "Bash",
      elapsed_time_seconds: 5,
    });
  });

  it("tool_use_summary → tool_use_summary broadcast shape", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "tool_use_summary",
        summary: "Executed 3 commands",
        preceding_tool_use_ids: ["tu-1", "tu-2", "tu-3"],
        uuid: "uuid-summary",
        session_id: "cli-abc",
      }),
    );
    await tick();

    const msgs = lastMessages(consumer);
    expect(msgs[0]).toEqual({
      type: "tool_use_summary",
      summary: "Executed 3 commands",
      tool_use_ids: ["tu-1", "tu-2", "tu-3"],
    });
  });

  it("auth_status → auth_status broadcast shape", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "auth_status",
        isAuthenticating: true,
        output: ["Authenticating...", "Please wait"],
        error: undefined,
        uuid: "uuid-auth",
        session_id: "cli-abc",
      }),
    );
    await tick();

    const msgs = lastMessages(consumer);
    expect(msgs[0]).toEqual({
      type: "auth_status",
      isAuthenticating: true,
      output: ["Authenticating...", "Please wait"],
      error: undefined,
    });
  });

  it("auth_status with error → auth_status broadcast shape", async () => {
    const { consumer, backendSession } = await setupSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "auth_status",
        isAuthenticating: false,
        output: ["Failed"],
        error: "Invalid API key",
        uuid: "uuid-auth-err",
        session_id: "cli-abc",
      }),
    );
    await tick();

    const msgs = lastMessages(consumer);
    expect(msgs[0]).toEqual({
      type: "auth_status",
      isAuthenticating: false,
      output: ["Failed"],
      error: "Invalid API key",
    });
  });

  it("keep_alive → silently consumed, no consumer broadcast", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    // keep_alive translates to null — not pushed to backend session
    const result = translateAndPush(backendSession, JSON.stringify({ type: "keep_alive" }));
    expect(result).toBeNull();
    await tick();

    const msgs = allMessages(consumer);
    expect(msgs).toHaveLength(0);
  });

  it("system.init triggers initialize request via backendSession", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "cli-abc",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/test",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        slash_commands: ["compact", "help"],
        skills: ["tdd"],
        output_style: "normal",
        uuid: "uuid-init",
        apiKeySource: "env",
      }),
    );
    await tick();

    // After init, the bridge should send an initialize request via backendSession.sendRaw
    const initReq = backendSession.sentRawMessages.find((raw) => {
      const parsed = JSON.parse(raw);
      return parsed.type === "control_request" && parsed.request?.subtype === "initialize";
    });
    expect(initReq).toBeDefined();
  });

  it("control_response (initialize success) → capabilities_ready broadcast shape", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    // Send session_init to trigger initialize request
    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "cli-abc",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/test",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        slash_commands: [],
        skills: ["tdd"],
        output_style: "normal",
        uuid: "uuid-init",
        apiKeySource: "env",
      }),
    );
    await tick();

    // Get the initialize request_id from backendSession.sentRawMessages
    const initRaw = backendSession.sentRawMessages.find((raw) => {
      const parsed = JSON.parse(raw);
      return parsed.type === "control_request" && parsed.request?.subtype === "initialize";
    });
    expect(initRaw).toBeDefined();
    const initReq = JSON.parse(initRaw!);

    consumer.sentMessages.length = 0; // Clear after init

    // Send control_response with capabilities
    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: initReq.request_id,
          response: {
            commands: [{ name: "/help", description: "Get help" }],
            models: [{ id: "claude-sonnet-4-5-20250929", name: "Sonnet" }],
            account: { email: "test@example.com" },
          },
        },
      }),
    );
    await tick();

    const msgs = lastMessages(consumer);
    expect(msgs[0].type).toBe("capabilities_ready");
    expect((msgs[0] as any).commands).toEqual([{ name: "/help", description: "Get help" }]);
    expect((msgs[0] as any).models).toEqual([{ id: "claude-sonnet-4-5-20250929", name: "Sonnet" }]);
    expect((msgs[0] as any).account).toEqual({ email: "test@example.com" });
    expect((msgs[0] as any).skills).toEqual(["tdd"]);
  });

  it("control_response (initialize error with slash_commands fallback) → capabilities_ready broadcast", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);

    // Send session_init with slash_commands to trigger fallback synthesis
    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "cli-abc",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/test",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        slash_commands: ["compact", "help"],
        skills: [],
        output_style: "normal",
        uuid: "uuid-init",
        apiKeySource: "env",
      }),
    );
    await tick();

    // Get the initialize request_id
    const initRaw = backendSession.sentRawMessages.find((raw) => {
      const parsed = JSON.parse(raw);
      return parsed.type === "control_request" && parsed.request?.subtype === "initialize";
    });
    const initReq = JSON.parse(initRaw!);

    consumer.sentMessages.length = 0;

    // Send error response (e.g., "Already initialized")
    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: initReq.request_id,
          error: "Already initialized",
        },
      }),
    );
    await tick();

    // Should still broadcast capabilities_ready with synthesized commands
    const msgs = allMessages(consumer);
    const capMsg = msgs.find((m) => m.type === "capabilities_ready");
    expect(capMsg).toBeDefined();
    expect((capMsg as any).commands).toEqual([
      { name: "compact", description: "" },
      { name: "help", description: "" },
    ]);
  });

  it("result with first turn → triggers session:first_turn_completed event", async () => {
    const { backendSession, consumer } = await setupSession(bridge, adapter);
    const events: any[] = [];
    bridge.on("session:first_turn_completed", (e) => events.push(e));

    // Send a user message first (to populate history)
    bridge.sendUserMessage("char-session", "Hello there");

    // Send result with num_turns=1
    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Hi!",
        duration_ms: 100,
        duration_api_ms: 80,
        num_turns: 1,
        total_cost_usd: 0.01,
        uuid: "uuid-result",
        session_id: "cli-abc",
      }),
    );
    await tick();

    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("char-session");
    expect(events[0].firstUserMessage).toBe("Hello there");
  });

  it("system.status with permissionMode → updates state", async () => {
    const { backendSession } = await setupSession(bridge, adapter);

    translateAndPush(
      backendSession,
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: null,
        permissionMode: "plan",
        uuid: "uuid-status",
        session_id: "cli-abc",
      }),
    );
    await tick();

    const snapshot = bridge.getSession("char-session");
    expect(snapshot?.state.permissionMode).toBe("plan");
  });
});
