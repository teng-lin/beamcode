import { describe, expect, it } from "vitest";
import {
  mapAssistantMessage,
  mapAuthStatus,
  mapPermissionRequest,
  mapResultMessage,
  mapStreamEvent,
  mapToolProgress,
  mapToolUseSummary,
} from "./consumer-message-mapper.js";
import { createUnifiedMessage } from "./types/unified-message.js";

// ─── mapAssistantMessage ────────────────────────────────────────────────────

describe("mapAssistantMessage", () => {
  it("maps text content blocks", () => {
    const msg = createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
      metadata: {
        message_id: "msg-001",
        model: "claude-sonnet-4-5-20250929",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
        },
        parent_tool_use_id: null,
      },
    });

    const result = mapAssistantMessage(msg);

    expect(result).toEqual({
      type: "assistant",
      message: {
        id: "msg-001",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Hello world" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
        },
      },
      parent_tool_use_id: null,
    });
  });

  it("maps tool_use content blocks", () => {
    const msg = createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } }],
      metadata: {
        message_id: "msg-002",
        model: "claude-sonnet-4-5-20250929",
        stop_reason: "tool_use",
        usage: {
          input_tokens: 50,
          output_tokens: 30,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        parent_tool_use_id: "parent-tu-1",
      },
    });

    const result = mapAssistantMessage(msg);

    expect(result.type).toBe("assistant");
    const assistant = result as Extract<typeof result, { type: "assistant" }>;
    expect(assistant.message.content).toEqual([
      { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
    ]);
    expect(assistant.parent_tool_use_id).toBe("parent-tu-1");
  });

  it("maps tool_result content blocks", () => {
    const msg = createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: "file.txt", is_error: false }],
      metadata: {
        message_id: "msg-003",
        model: "claude-sonnet-4-5-20250929",
        stop_reason: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        parent_tool_use_id: null,
      },
    });

    const result = mapAssistantMessage(msg);
    const assistant = result as Extract<typeof result, { type: "assistant" }>;
    expect(assistant.message.content).toEqual([
      { type: "tool_result", tool_use_id: "tu-1", content: "file.txt", is_error: false },
    ]);
  });

  it("maps mixed content blocks", () => {
    const msg = createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content: [
        { type: "text", text: "Let me run that" },
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
      ],
      metadata: {
        message_id: "msg-004",
        model: "claude-sonnet-4-5-20250929",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
        },
        parent_tool_use_id: null,
      },
    });

    const result = mapAssistantMessage(msg);
    const assistant = result as Extract<typeof result, { type: "assistant" }>;
    expect(assistant.message.content).toHaveLength(2);
    expect(assistant.message.content[0]).toEqual({ type: "text", text: "Let me run that" });
    expect(assistant.message.content[1]).toEqual({
      type: "tool_use",
      id: "tu-1",
      name: "Bash",
      input: { command: "ls" },
    });
  });

  it("falls back to msg.id when message_id is missing", () => {
    const msg = createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
      metadata: {
        model: "claude-sonnet-4-5-20250929",
        stop_reason: null,
        parent_tool_use_id: null,
      },
    });

    const result = mapAssistantMessage(msg);
    const assistant = result as Extract<typeof result, { type: "assistant" }>;
    expect(assistant.message.id).toBe(msg.id);
  });

  it("defaults usage to zeros when not provided", () => {
    const msg = createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content: [],
      metadata: {
        message_id: "msg-005",
        model: "claude-sonnet-4-5-20250929",
        stop_reason: null,
        parent_tool_use_id: null,
      },
    });

    const result = mapAssistantMessage(msg);
    const assistant = result as Extract<typeof result, { type: "assistant" }>;
    expect(assistant.message.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("maps unknown content block types to empty text", () => {
    const msg = createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content: [{ type: "foobar" } as any],
      metadata: {
        message_id: "msg-006",
        model: "claude-sonnet-4-5-20250929",
        stop_reason: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        parent_tool_use_id: null,
      },
    });

    const result = mapAssistantMessage(msg);
    const assistant = result as Extract<typeof result, { type: "assistant" }>;
    expect(assistant.message.content).toEqual([{ type: "text", text: "" }]);
  });
});

// ─── mapResultMessage ───────────────────────────────────────────────────────

describe("mapResultMessage", () => {
  it("maps a successful result with all fields", () => {
    const msg = createUnifiedMessage({
      type: "result",
      role: "assistant",
      metadata: {
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
      },
    });

    const result = mapResultMessage(msg);

    expect(result).toEqual({
      type: "result",
      data: {
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
      },
    });
  });

  it("maps an error result", () => {
    const msg = createUnifiedMessage({
      type: "result",
      role: "assistant",
      metadata: {
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Something went wrong"],
        duration_ms: 500,
        duration_api_ms: 400,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: null,
      },
    });

    const result = mapResultMessage(msg);
    const data = (result as Extract<typeof result, { type: "result" }>).data;
    expect(data.subtype).toBe("error_during_execution");
    expect(data.is_error).toBe(true);
    expect(data.errors).toEqual(["Something went wrong"]);
    expect(data.stop_reason).toBeNull();
  });

  it("defaults numeric fields to 0 and usage to zeros", () => {
    const msg = createUnifiedMessage({
      type: "result",
      role: "assistant",
      metadata: {
        subtype: "success",
      },
    });

    const result = mapResultMessage(msg);
    const data = (result as Extract<typeof result, { type: "result" }>).data;
    expect(data.is_error).toBe(false);
    expect(data.duration_ms).toBe(0);
    expect(data.duration_api_ms).toBe(0);
    expect(data.num_turns).toBe(0);
    expect(data.total_cost_usd).toBe(0);
    expect(data.stop_reason).toBeNull();
    expect(data.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(data.modelUsage).toBeUndefined();
    expect(data.total_lines_added).toBeUndefined();
    expect(data.total_lines_removed).toBeUndefined();
  });

  it("maps fallback error string when errors[] is absent", () => {
    const msg = createUnifiedMessage({
      type: "result",
      role: "assistant",
      metadata: {
        is_error: true,
        error: "turn.create failed",
      },
    });

    const result = mapResultMessage(msg);
    const data = (result as Extract<typeof result, { type: "result" }>).data;
    expect(data.is_error).toBe(true);
    expect(data.subtype).toBe("error_during_execution");
    expect(data.errors).toEqual(["turn.create failed"]);
  });
});

// ─── mapStreamEvent ─────────────────────────────────────────────────────────

describe("mapStreamEvent", () => {
  it("maps a stream event with parent_tool_use_id", () => {
    const msg = createUnifiedMessage({
      type: "stream_event",
      role: "assistant",
      metadata: {
        event: { type: "content_block_start", index: 0 },
        parent_tool_use_id: "parent-tu-2",
      },
    });

    const result = mapStreamEvent(msg);

    expect(result).toEqual({
      type: "stream_event",
      event: { type: "content_block_start", index: 0 },
      parent_tool_use_id: "parent-tu-2",
    });
  });

  it("defaults parent_tool_use_id to null", () => {
    const msg = createUnifiedMessage({
      type: "stream_event",
      role: "assistant",
      metadata: {
        event: { type: "message_start" },
      },
    });

    const result = mapStreamEvent(msg);
    const stream = result as Extract<typeof result, { type: "stream_event" }>;
    expect(stream.parent_tool_use_id).toBeNull();
  });
});

// ─── mapPermissionRequest ───────────────────────────────────────────────────

describe("mapPermissionRequest", () => {
  it("maps a can_use_tool permission request", () => {
    const msg = createUnifiedMessage({
      type: "permission_request",
      role: "system",
      metadata: {
        subtype: "can_use_tool",
        request_id: "perm-req-1",
        tool_name: "Bash",
        input: { command: "rm -rf /" },
        permission_suggestions: [{ type: "allow_once" }],
        description: "Execute dangerous command",
        tool_use_id: "tu-perm-1",
        agent_id: "agent-a",
      },
    });

    const result = mapPermissionRequest(msg);

    expect(result).not.toBeNull();
    expect(result!.consumerPerm.request_id).toBe("perm-req-1");
    expect(result!.consumerPerm.tool_name).toBe("Bash");
    expect(result!.consumerPerm.input).toEqual({ command: "rm -rf /" });
    expect(result!.consumerPerm.permission_suggestions).toEqual([{ type: "allow_once" }]);
    expect(result!.consumerPerm.description).toBe("Execute dangerous command");
    expect(result!.consumerPerm.tool_use_id).toBe("tu-perm-1");
    expect(result!.consumerPerm.agent_id).toBe("agent-a");
    expect(result!.consumerPerm.timestamp).toBeTypeOf("number");

    // CLI perm has same fields
    expect(result!.cliPerm.request_id).toBe("perm-req-1");
    expect(result!.cliPerm.tool_name).toBe("Bash");
  });

  it("maps a permission request with no subtype (implicit can_use_tool)", () => {
    const msg = createUnifiedMessage({
      type: "permission_request",
      role: "system",
      metadata: {
        request_id: "perm-req-2",
        tool_name: "Read",
        input: { path: "/etc/passwd" },
        tool_use_id: "tu-perm-2",
      },
    });

    const result = mapPermissionRequest(msg);
    expect(result).not.toBeNull();
    expect(result!.consumerPerm.request_id).toBe("perm-req-2");
    expect(result!.consumerPerm.tool_name).toBe("Read");
  });

  it("returns null for non-can_use_tool subtypes", () => {
    const msg = createUnifiedMessage({
      type: "permission_request",
      role: "system",
      metadata: {
        subtype: "other_subtype",
        request_id: "perm-req-3",
        tool_name: "Bash",
        input: {},
      },
    });

    const result = mapPermissionRequest(msg);
    expect(result).toBeNull();
  });

  it("defaults input to empty object when not provided", () => {
    const msg = createUnifiedMessage({
      type: "permission_request",
      role: "system",
      metadata: {
        subtype: "can_use_tool",
        request_id: "perm-req-4",
        tool_name: "Read",
        tool_use_id: "tu-perm-4",
      },
    });

    const result = mapPermissionRequest(msg);
    expect(result).not.toBeNull();
    expect(result!.consumerPerm.input).toEqual({});
  });
});

// ─── mapToolProgress ────────────────────────────────────────────────────────

describe("mapToolProgress", () => {
  it("maps tool progress fields", () => {
    const msg = createUnifiedMessage({
      type: "tool_progress",
      role: "assistant",
      metadata: {
        tool_use_id: "tu-prog-1",
        tool_name: "Bash",
        elapsed_time_seconds: 5,
      },
    });

    const result = mapToolProgress(msg);

    expect(result).toEqual({
      type: "tool_progress",
      tool_use_id: "tu-prog-1",
      tool_name: "Bash",
      elapsed_time_seconds: 5,
    });
  });
});

// ─── mapToolUseSummary ──────────────────────────────────────────────────────

describe("mapToolUseSummary", () => {
  it("maps tool use summary fields", () => {
    const msg = createUnifiedMessage({
      type: "tool_use_summary",
      role: "assistant",
      metadata: {
        summary: "Executed 3 commands",
        tool_use_ids: ["tu-1", "tu-2", "tu-3"],
      },
    });

    const result = mapToolUseSummary(msg);

    expect(result).toEqual({
      type: "tool_use_summary",
      summary: "Executed 3 commands",
      tool_use_ids: ["tu-1", "tu-2", "tu-3"],
    });
  });
});

// ─── mapAuthStatus ──────────────────────────────────────────────────────────

describe("mapAuthStatus", () => {
  it("maps authenticating status", () => {
    const msg = createUnifiedMessage({
      type: "auth_status",
      role: "system",
      metadata: {
        isAuthenticating: true,
        output: ["Authenticating...", "Please wait"],
      },
    });

    const result = mapAuthStatus(msg);

    expect(result).toEqual({
      type: "auth_status",
      isAuthenticating: true,
      output: ["Authenticating...", "Please wait"],
      error: undefined,
    });
  });

  it("maps auth status with error", () => {
    const msg = createUnifiedMessage({
      type: "auth_status",
      role: "system",
      metadata: {
        isAuthenticating: false,
        output: ["Failed"],
        error: "Invalid API key",
      },
    });

    const result = mapAuthStatus(msg);

    expect(result).toEqual({
      type: "auth_status",
      isAuthenticating: false,
      output: ["Failed"],
      error: "Invalid API key",
    });
  });
});
