import { describe, expect, it } from "vitest";
import type {
  CodeContent,
  ImageContent,
  TextContent,
  ToolResultContent,
  ToolUseContent,
  UnifiedContent,
  UnifiedMessage,
  UnifiedMessageType,
} from "./unified-message.js";
import {
  CLI_TO_UNIFIED_TYPE_MAP,
  canonicalize,
  createUnifiedMessage,
  INBOUND_TO_UNIFIED_TYPE_MAP,
  isCodeContent,
  isImageContent,
  isTextContent,
  isToolResultContent,
  isToolUseContent,
  isUnifiedMessage,
} from "./unified-message.js";

// ---------------------------------------------------------------------------
// Factory: createUnifiedMessage
// ---------------------------------------------------------------------------

describe("createUnifiedMessage", () => {
  it("generates a UUID id", () => {
    const msg = createUnifiedMessage({ type: "assistant", role: "assistant" });
    expect(msg.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("sets timestamp to a recent value", () => {
    const before = Date.now();
    const msg = createUnifiedMessage({ type: "user_message", role: "user" });
    const after = Date.now();
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });

  it("defaults content to an empty array", () => {
    const msg = createUnifiedMessage({ type: "result", role: "system" });
    expect(msg.content).toEqual([]);
  });

  it("defaults metadata to an empty object", () => {
    const msg = createUnifiedMessage({ type: "result", role: "system" });
    expect(msg.metadata).toEqual({});
  });

  it("passes through provided content and metadata", () => {
    const content: UnifiedContent[] = [{ type: "text", text: "hello" }];
    const metadata = { session_id: "abc", model: "claude-4" };
    const msg = createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content,
      metadata,
    });
    expect(msg.content).toEqual(content);
    expect(msg.metadata).toEqual(metadata);
  });

  it("sets parentId when provided", () => {
    const msg = createUnifiedMessage({
      type: "tool_progress",
      role: "tool",
      parentId: "parent-123",
    });
    expect(msg.parentId).toBe("parent-123");
  });

  it("omits parentId when not provided", () => {
    const msg = createUnifiedMessage({ type: "interrupt", role: "user" });
    expect(msg.parentId).toBeUndefined();
  });

  it("generates unique ids across calls", () => {
    const a = createUnifiedMessage({ type: "assistant", role: "assistant" });
    const b = createUnifiedMessage({ type: "assistant", role: "assistant" });
    expect(a.id).not.toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// Content type guards
// ---------------------------------------------------------------------------

describe("content type guards", () => {
  const text: TextContent = { type: "text", text: "hello" };
  const toolUse: ToolUseContent = {
    type: "tool_use",
    id: "tu-1",
    name: "Read",
    input: { path: "/foo" },
  };
  const toolResult: ToolResultContent = {
    type: "tool_result",
    tool_use_id: "tu-1",
    content: "file contents",
  };
  const code: CodeContent = {
    type: "code",
    language: "typescript",
    code: "const x = 1;",
  };
  const image: ImageContent = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBOR..." },
  };

  const all: UnifiedContent[] = [text, toolUse, toolResult, code, image];

  it("isTextContent identifies text blocks", () => {
    expect(isTextContent(text)).toBe(true);
    for (const other of all.filter((b) => b !== text)) {
      expect(isTextContent(other)).toBe(false);
    }
  });

  it("isToolUseContent identifies tool_use blocks", () => {
    expect(isToolUseContent(toolUse)).toBe(true);
    for (const other of all.filter((b) => b !== toolUse)) {
      expect(isToolUseContent(other)).toBe(false);
    }
  });

  it("isToolResultContent identifies tool_result blocks", () => {
    expect(isToolResultContent(toolResult)).toBe(true);
    for (const other of all.filter((b) => b !== toolResult)) {
      expect(isToolResultContent(other)).toBe(false);
    }
  });

  it("isCodeContent identifies code blocks", () => {
    expect(isCodeContent(code)).toBe(true);
    for (const other of all.filter((b) => b !== code)) {
      expect(isCodeContent(other)).toBe(false);
    }
  });

  it("isImageContent identifies image blocks", () => {
    expect(isImageContent(image)).toBe(true);
    for (const other of all.filter((b) => b !== image)) {
      expect(isImageContent(other)).toBe(false);
    }
  });

  it("handles tool_result with is_error flag", () => {
    const errResult: ToolResultContent = {
      type: "tool_result",
      tool_use_id: "tu-2",
      content: "Error: not found",
      is_error: true,
    };
    expect(isToolResultContent(errResult)).toBe(true);
    expect(errResult.is_error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isUnifiedMessage type guard
// ---------------------------------------------------------------------------

describe("isUnifiedMessage", () => {
  function validMessage(overrides?: Partial<UnifiedMessage>): Record<string, unknown> {
    return {
      id: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: 1700000000000,
      type: "assistant",
      role: "assistant",
      content: [],
      metadata: {},
      ...overrides,
    };
  }

  it("accepts a valid message", () => {
    expect(isUnifiedMessage(validMessage())).toBe(true);
  });

  it("accepts a message with parentId", () => {
    expect(isUnifiedMessage(validMessage({ parentId: "parent-1" }))).toBe(true);
  });

  it("rejects null", () => {
    expect(isUnifiedMessage(null)).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isUnifiedMessage("string")).toBe(false);
    expect(isUnifiedMessage(42)).toBe(false);
    expect(isUnifiedMessage(undefined)).toBe(false);
  });

  it("rejects empty id", () => {
    expect(isUnifiedMessage(validMessage({ id: "" }))).toBe(false);
  });

  it("rejects missing id", () => {
    const msg = validMessage();
    delete msg.id;
    expect(isUnifiedMessage(msg)).toBe(false);
  });

  it("rejects non-finite timestamp", () => {
    expect(isUnifiedMessage(validMessage({ timestamp: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(isUnifiedMessage(validMessage({ timestamp: Number.NaN }))).toBe(false);
  });

  it("rejects invalid type", () => {
    expect(isUnifiedMessage(validMessage({ type: "bogus" as UnifiedMessageType }))).toBe(false);
  });

  it("rejects invalid role", () => {
    expect(isUnifiedMessage(validMessage({ role: "admin" as "user" }))).toBe(false);
  });

  it("rejects non-array content", () => {
    expect(
      isUnifiedMessage(
        validMessage({ content: "not-array" as unknown as UnifiedMessage["content"] }),
      ),
    ).toBe(false);
  });

  it("rejects null metadata", () => {
    expect(
      isUnifiedMessage(validMessage({ metadata: null as unknown as Record<string, unknown> })),
    ).toBe(false);
  });

  it("rejects non-string parentId", () => {
    expect(isUnifiedMessage(validMessage({ parentId: 123 as unknown as string }))).toBe(false);
  });

  it("accepts all valid message types", () => {
    const types: UnifiedMessageType[] = [
      "session_init",
      "status_change",
      "assistant",
      "result",
      "stream_event",
      "permission_request",
      "control_response",
      "tool_progress",
      "tool_use_summary",
      "auth_status",
      "user_message",
      "permission_response",
      "interrupt",
      "configuration_change",
      "unknown",
    ];
    for (const t of types) {
      expect(isUnifiedMessage(validMessage({ type: t }))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Roundtrip serialization
// ---------------------------------------------------------------------------

describe("roundtrip serialization", () => {
  it("JSON.stringify → JSON.parse preserves all fields", () => {
    const msg = createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "tool_use", id: "tu-1", name: "Read", input: { path: "/" } },
      ],
      metadata: { model: "claude-4", session_id: "s-1" },
      parentId: "parent-0",
    });

    const json = JSON.stringify(msg);
    const parsed = JSON.parse(json) as UnifiedMessage;

    expect(parsed).toEqual(msg);
    expect(isUnifiedMessage(parsed)).toBe(true);
  });

  it("preserves empty content and metadata", () => {
    const msg = createUnifiedMessage({
      type: "interrupt",
      role: "user",
    });

    const roundtripped = JSON.parse(JSON.stringify(msg)) as UnifiedMessage;
    expect(roundtripped.content).toEqual([]);
    expect(roundtripped.metadata).toEqual({});
  });

  it("preserves nested metadata structures", () => {
    const msg = createUnifiedMessage({
      type: "result",
      role: "system",
      metadata: {
        usage: { input_tokens: 100, output_tokens: 50 },
        tags: ["a", "b"],
        nested: { deep: { value: true } },
      },
    });

    const roundtripped = JSON.parse(JSON.stringify(msg)) as UnifiedMessage;
    expect(roundtripped.metadata).toEqual(msg.metadata);
  });
});

// ---------------------------------------------------------------------------
// Contract mapping: CLIMessage → UnifiedMessageType
// ---------------------------------------------------------------------------

describe("CLI_TO_UNIFIED_TYPE_MAP", () => {
  it("maps system:init to session_init", () => {
    expect(CLI_TO_UNIFIED_TYPE_MAP["system:init"]).toBe("session_init");
  });

  it("maps system:status to status_change", () => {
    expect(CLI_TO_UNIFIED_TYPE_MAP["system:status"]).toBe("status_change");
  });

  it("maps assistant to assistant", () => {
    expect(CLI_TO_UNIFIED_TYPE_MAP.assistant).toBe("assistant");
  });

  it("maps result to result", () => {
    expect(CLI_TO_UNIFIED_TYPE_MAP.result).toBe("result");
  });

  it("maps stream_event to stream_event", () => {
    expect(CLI_TO_UNIFIED_TYPE_MAP.stream_event).toBe("stream_event");
  });

  it("maps control_request to permission_request", () => {
    expect(CLI_TO_UNIFIED_TYPE_MAP.control_request).toBe("permission_request");
  });

  it("maps control_response to control_response", () => {
    expect(CLI_TO_UNIFIED_TYPE_MAP.control_response).toBe("control_response");
  });

  it("maps tool_progress to tool_progress", () => {
    expect(CLI_TO_UNIFIED_TYPE_MAP.tool_progress).toBe("tool_progress");
  });

  it("maps tool_use_summary to tool_use_summary", () => {
    expect(CLI_TO_UNIFIED_TYPE_MAP.tool_use_summary).toBe("tool_use_summary");
  });

  it("maps keep_alive to unknown", () => {
    expect(CLI_TO_UNIFIED_TYPE_MAP.keep_alive).toBe("unknown");
  });

  it("maps auth_status to auth_status", () => {
    expect(CLI_TO_UNIFIED_TYPE_MAP.auth_status).toBe("auth_status");
  });

  it("covers all 11 CLIMessage types", () => {
    expect(Object.keys(CLI_TO_UNIFIED_TYPE_MAP)).toHaveLength(11);
  });
});

describe("INBOUND_TO_UNIFIED_TYPE_MAP", () => {
  it("maps user_message to user_message", () => {
    expect(INBOUND_TO_UNIFIED_TYPE_MAP.user_message).toBe("user_message");
  });

  it("maps permission_response to permission_response", () => {
    expect(INBOUND_TO_UNIFIED_TYPE_MAP.permission_response).toBe("permission_response");
  });

  it("maps interrupt to interrupt", () => {
    expect(INBOUND_TO_UNIFIED_TYPE_MAP.interrupt).toBe("interrupt");
  });

  it("maps set_model to configuration_change", () => {
    expect(INBOUND_TO_UNIFIED_TYPE_MAP.set_model).toBe("configuration_change");
  });

  it("maps set_permission_mode to configuration_change", () => {
    expect(INBOUND_TO_UNIFIED_TYPE_MAP.set_permission_mode).toBe("configuration_change");
  });

  it("maps presence_query to unknown", () => {
    expect(INBOUND_TO_UNIFIED_TYPE_MAP.presence_query).toBe("unknown");
  });

  it("maps slash_command to unknown", () => {
    expect(INBOUND_TO_UNIFIED_TYPE_MAP.slash_command).toBe("unknown");
  });

  it("covers all 7 InboundMessage types", () => {
    expect(Object.keys(INBOUND_TO_UNIFIED_TYPE_MAP)).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("empty content array is valid", () => {
    const msg = createUnifiedMessage({ type: "interrupt", role: "user" });
    expect(msg.content).toEqual([]);
    expect(isUnifiedMessage(msg)).toBe(true);
  });

  it("large metadata object is valid", () => {
    const bigMeta: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) {
      bigMeta[`key_${i}`] = { value: i, nested: { data: `item-${i}` } };
    }
    const msg = createUnifiedMessage({
      type: "session_init",
      role: "system",
      metadata: bigMeta,
    });
    expect(isUnifiedMessage(msg)).toBe(true);
    expect(Object.keys(msg.metadata)).toHaveLength(1000);
  });

  it("unknown type passthrough works", () => {
    const msg = createUnifiedMessage({
      type: "unknown",
      role: "system",
      metadata: { originalType: "keep_alive", raw: { type: "keep_alive" } },
    });
    expect(msg.type).toBe("unknown");
    expect(msg.metadata.originalType).toBe("keep_alive");
    expect(isUnifiedMessage(msg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Canonical JSON serialization
// ---------------------------------------------------------------------------

describe("canonicalize", () => {
  it("sorts object keys alphabetically", () => {
    const result = canonicalize({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it("sorts nested object keys recursively", () => {
    const result = canonicalize({ b: { z: 1, a: 2 }, a: 1 });
    expect(result).toBe('{"a":1,"b":{"a":2,"z":1}}');
  });

  it("handles arrays (order preserved)", () => {
    const result = canonicalize([3, 1, 2]);
    expect(result).toBe("[3,1,2]");
  });

  it("handles null", () => {
    expect(canonicalize(null)).toBe("null");
  });

  it("handles undefined as null", () => {
    expect(canonicalize(undefined)).toBe("null");
  });

  it("handles booleans", () => {
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
  });

  it("handles strings with special characters", () => {
    expect(canonicalize('hello "world"')).toBe('"hello \\"world\\""');
  });

  it("handles numbers", () => {
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(3.14)).toBe("3.14");
    expect(canonicalize(-0)).toBe("0");
  });

  it("omits undefined object values", () => {
    const result = canonicalize({ a: 1, b: undefined, c: 3 });
    expect(result).toBe('{"a":1,"c":3}');
  });

  it("produces deterministic output for a UnifiedMessage", () => {
    const msg: UnifiedMessage = {
      id: "test-id",
      timestamp: 1700000000000,
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      metadata: { model: "claude-4" },
    };

    const result1 = canonicalize(msg);
    const result2 = canonicalize(msg);
    expect(result1).toBe(result2);

    // Verify key order is consistent
    const parsed = JSON.parse(result1) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it("handles empty objects and arrays", () => {
    expect(canonicalize({})).toBe("{}");
    expect(canonicalize([])).toBe("[]");
  });

  it("handles deeply nested structures", () => {
    const deep = { c: { b: { a: [{ z: 1, a: 2 }] } } };
    const result = canonicalize(deep);
    expect(result).toBe('{"c":{"b":{"a":[{"a":2,"z":1}]}}}');
  });
});
