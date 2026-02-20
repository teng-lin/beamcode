import { describe, expect, it } from "vitest";
import {
  extractSessionId,
  type OpencodeAction,
  translateEvent,
  translateToOpencode,
} from "./opencode-message-translator.js";
import type { OpencodeEvent } from "./opencode-types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = "sess-abc123";
const PART_ID = "part-xyz";
const MESSAGE_ID = "msg-001";

function makeTextPartEvent(overrides?: { text?: string; delta?: string }): OpencodeEvent {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "text",
        id: PART_ID,
        messageID: MESSAGE_ID,
        sessionID: SESSION_ID,
        text: overrides?.text ?? "Hello",
        time: { created: 1000, updated: 1001 },
      },
      delta: overrides?.delta,
    },
  };
}

function makeReasoningPartEvent(overrides?: { text?: string; delta?: string }): OpencodeEvent {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "reasoning",
        id: PART_ID,
        messageID: MESSAGE_ID,
        sessionID: SESSION_ID,
        text: overrides?.text ?? "Thinking...",
        time: { created: 1000, updated: 1001 },
      },
      delta: overrides?.delta,
    },
  };
}

function makeToolPartEvent(status: "pending" | "running" | "completed" | "error"): OpencodeEvent {
  const baseProps = {
    type: "tool" as const,
    id: PART_ID,
    messageID: MESSAGE_ID,
    sessionID: SESSION_ID,
    callID: "call-1",
    tool: "bash",
    time: { created: 1000, updated: 1001 },
  };

  if (status === "pending") {
    return {
      type: "message.part.updated",
      properties: {
        part: { ...baseProps, state: { status: "pending", input: { cmd: "ls" } } },
      },
    };
  }
  if (status === "running") {
    return {
      type: "message.part.updated",
      properties: {
        part: {
          ...baseProps,
          state: {
            status: "running",
            input: { cmd: "ls" },
            title: "Running bash",
            time: { start: 2000 },
          },
        },
      },
    };
  }
  if (status === "completed") {
    return {
      type: "message.part.updated",
      properties: {
        part: {
          ...baseProps,
          state: {
            status: "completed",
            input: { cmd: "ls" },
            output: "file.txt",
            title: "bash",
            time: { start: 2000, end: 3000 },
          },
        },
      },
    };
  }
  // error
  return {
    type: "message.part.updated",
    properties: {
      part: {
        ...baseProps,
        state: {
          status: "error",
          input: { cmd: "ls" },
          error: "command not found",
          time: { start: 2000, end: 3000 },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// translateEvent — message.part.updated: text
// ---------------------------------------------------------------------------

describe("translateEvent: message.part.updated with text part", () => {
  it("produces stream_event with delta in metadata", () => {
    const event = makeTextPartEvent({ text: "Hello world", delta: " world" });
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("stream_event");
    expect(msg!.role).toBe("assistant");
    expect(msg!.metadata.delta).toBe(" world");
    expect(msg!.metadata.reasoning).toBeUndefined();
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
    expect(msg!.metadata.message_id).toBe(MESSAGE_ID);
    expect(msg!.metadata.event).toEqual({
      type: "content_block_delta",
      delta: { type: "text_delta", text: " world" },
    });
  });

  it("uses empty string for delta when delta is missing", () => {
    const event = makeTextPartEvent({ text: "Hi" });
    const msg = translateEvent(event);
    expect(msg!.metadata.delta).toBe("");
    expect(msg!.metadata.event).toBeUndefined();
  });

  it("sets id, timestamp on returned message", () => {
    const event = makeTextPartEvent({});
    const msg = translateEvent(event);
    expect(typeof msg!.id).toBe("string");
    expect(msg!.id.length).toBeGreaterThan(0);
    expect(typeof msg!.timestamp).toBe("number");
  });

  it("carries the full text in metadata", () => {
    const event = makeTextPartEvent({ text: "Full text", delta: "t" });
    const msg = translateEvent(event);
    expect(msg!.metadata.text).toBe("Full text");
  });
});

// ---------------------------------------------------------------------------
// translateEvent — message.part.updated: reasoning
// ---------------------------------------------------------------------------

describe("translateEvent: message.part.updated with reasoning part", () => {
  it("produces stream_event with reasoning=true", () => {
    const event = makeReasoningPartEvent({ text: "Let me think", delta: " think" });
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("stream_event");
    expect(msg!.role).toBe("assistant");
    expect(msg!.metadata.reasoning).toBe(true);
    expect(msg!.metadata.delta).toBe(" think");
    expect(msg!.metadata.event).toEqual({
      type: "content_block_delta",
      delta: { type: "text_delta", text: " think" },
    });
  });

  it("handles empty reasoning delta", () => {
    const event = makeReasoningPartEvent({ text: "Start" });
    const msg = translateEvent(event);
    expect(msg!.metadata.delta).toBe("");
  });
});

// ---------------------------------------------------------------------------
// translateEvent — message.part.delta
// ---------------------------------------------------------------------------

describe("translateEvent: message.part.delta", () => {
  it("maps text delta to stream_event content_block_delta", () => {
    const event: OpencodeEvent = {
      type: "message.part.delta",
      properties: {
        sessionID: SESSION_ID,
        messageID: MESSAGE_ID,
        partID: PART_ID,
        field: "text",
        delta: "hello",
      },
    };

    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("stream_event");
    expect(msg!.metadata.delta).toBe("hello");
    expect(msg!.metadata.event).toEqual({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hello" },
    });
  });

  it("returns null for non-text field deltas", () => {
    const event: OpencodeEvent = {
      type: "message.part.delta",
      properties: {
        sessionID: SESSION_ID,
        messageID: MESSAGE_ID,
        partID: PART_ID,
        field: "metadata",
        delta: "ignored",
      },
    };

    expect(translateEvent(event)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// translateEvent — message.part.updated: tool parts
// ---------------------------------------------------------------------------

describe("translateEvent: message.part.updated with tool part running", () => {
  it("produces tool_progress with status=running", () => {
    const event = makeToolPartEvent("running");
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("tool_progress");
    expect(msg!.role).toBe("tool");
    expect(msg!.metadata.status).toBe("running");
    expect(msg!.metadata.tool).toBe("bash");
    expect(msg!.metadata.tool_use_id).toBe("call-1");
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
  });

  it("carries input and title in metadata", () => {
    const event = makeToolPartEvent("running");
    const msg = translateEvent(event);
    expect(msg!.metadata.input).toEqual({ cmd: "ls" });
    expect(msg!.metadata.title).toBe("Running bash");
  });
});

describe("translateEvent: message.part.updated with tool part completed", () => {
  it("produces tool_use_summary with status=completed", () => {
    const event = makeToolPartEvent("completed");
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("tool_use_summary");
    expect(msg!.role).toBe("tool");
    expect(msg!.metadata.status).toBe("completed");
    expect(msg!.metadata.output).toBe("file.txt");
    expect(msg!.metadata.title).toBe("bash");
  });

  it("does not set is_error on completed tool", () => {
    const event = makeToolPartEvent("completed");
    const msg = translateEvent(event);
    expect(msg!.metadata.is_error).toBeUndefined();
  });
});

describe("translateEvent: message.part.updated with tool part error", () => {
  it("produces tool_use_summary with is_error=true", () => {
    const event = makeToolPartEvent("error");
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("tool_use_summary");
    expect(msg!.metadata.is_error).toBe(true);
    expect(msg!.metadata.error).toBe("command not found");
    expect(msg!.metadata.status).toBe("error");
  });
});

describe("translateEvent: message.part.updated with tool part pending", () => {
  it("produces tool_progress with pending status", () => {
    const event = makeToolPartEvent("pending");
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("tool_progress");
    expect(msg!.metadata.status).toBe("pending");
    expect(msg!.metadata.tool).toBe("bash");
    expect(msg!.metadata.tool_use_id).toBe("call-1");
    expect(msg!.metadata.input).toEqual({ cmd: "ls" });
  });
});

// ---------------------------------------------------------------------------
// translateEvent — message.updated: assistant
// ---------------------------------------------------------------------------

describe("translateEvent: message.updated with assistant role", () => {
  it("produces assistant message with model and cost metadata", () => {
    const event: OpencodeEvent = {
      type: "message.updated",
      properties: {
        info: {
          id: MESSAGE_ID,
          sessionID: SESSION_ID,
          role: "assistant",
          time: { created: 5000, completed: 6000 },
          parentID: "msg-000",
          modelID: "claude-3-5-sonnet",
          providerID: "anthropic",
          agent: "default",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0.002,
          tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "end_turn",
        },
      },
    };

    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("assistant");
    expect(msg!.role).toBe("assistant");
    expect(msg!.metadata.model_id).toBe("claude-3-5-sonnet");
    expect(msg!.metadata.provider_id).toBe("anthropic");
    expect(msg!.metadata.cost).toBe(0.002);
    expect(msg!.metadata.tokens).toEqual({
      input: 100,
      output: 200,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
    expect(msg!.metadata.finish).toBe("end_turn");
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
  });

  it("preserves error field when assistant message has error", () => {
    const event: OpencodeEvent = {
      type: "message.updated",
      properties: {
        info: {
          id: MESSAGE_ID,
          sessionID: SESSION_ID,
          role: "assistant",
          time: { created: 5000 },
          parentID: "msg-000",
          modelID: "claude-3-5-sonnet",
          providerID: "anthropic",
          agent: "default",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          error: { name: "aborted", data: { message: "Request aborted" } },
        },
      },
    };
    const msg = translateEvent(event);
    expect(msg!.metadata.error).toEqual({ name: "aborted", data: { message: "Request aborted" } });
  });
});

// ---------------------------------------------------------------------------
// translateEvent — message.updated: user
// ---------------------------------------------------------------------------

describe("translateEvent: message.updated with user role", () => {
  it("produces user_message echo", () => {
    const event: OpencodeEvent = {
      type: "message.updated",
      properties: {
        info: {
          id: MESSAGE_ID,
          sessionID: SESSION_ID,
          role: "user",
          time: { created: 4000 },
          agent: "default",
          model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
        },
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("user_message");
    expect(msg!.role).toBe("user");
    expect(msg!.metadata.message_id).toBe(MESSAGE_ID);
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
  });
});

// ---------------------------------------------------------------------------
// translateEvent — session.status
// ---------------------------------------------------------------------------

describe("translateEvent: session.status idle", () => {
  it("produces result with status=completed", () => {
    const event: OpencodeEvent = {
      type: "session.status",
      properties: { sessionID: SESSION_ID, status: { type: "idle" } },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("result");
    expect(msg!.role).toBe("system");
    expect(msg!.metadata.status).toBe("completed");
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
  });
});

describe("translateEvent: session.status busy", () => {
  it("produces status_change with busy=true", () => {
    const event: OpencodeEvent = {
      type: "session.status",
      properties: { sessionID: SESSION_ID, status: { type: "busy" } },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("status_change");
    expect(msg!.metadata.busy).toBe(true);
  });
});

describe("translateEvent: session.status retry", () => {
  it("produces status_change with retry info", () => {
    const event: OpencodeEvent = {
      type: "session.status",
      properties: {
        sessionID: SESSION_ID,
        status: { type: "retry", attempt: 2, message: "Rate limited", next: 5000 },
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("status_change");
    expect(msg!.metadata.retry).toBe(true);
    expect(msg!.metadata.attempt).toBe(2);
    expect(msg!.metadata.message).toBe("Rate limited");
    expect(msg!.metadata.next).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// translateEvent — session.error
// ---------------------------------------------------------------------------

describe("translateEvent: session.error", () => {
  it("produces result with is_error=true", () => {
    const event: OpencodeEvent = {
      type: "session.error",
      properties: {
        sessionID: SESSION_ID,
        error: { name: "unknown", data: { message: "Something went wrong" } },
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("result");
    expect(msg!.metadata.is_error).toBe(true);
    expect(msg!.metadata.error_name).toBe("unknown");
    expect(msg!.metadata.error_message).toBe("Something went wrong");
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
  });

  it("captures provider_auth error name", () => {
    const event: OpencodeEvent = {
      type: "session.error",
      properties: {
        sessionID: SESSION_ID,
        error: { name: "provider_auth", data: { message: "Invalid API key" } },
      },
    };
    const msg = translateEvent(event);
    expect(msg!.metadata.error_name).toBe("provider_auth");
    expect(msg!.metadata.error_message).toBe("Invalid API key");
  });
});

// ---------------------------------------------------------------------------
// translateEvent — permission.updated
// ---------------------------------------------------------------------------

describe("translateEvent: permission.updated", () => {
  it("produces permission_request with request_id, permission, session_id", () => {
    const event: OpencodeEvent = {
      type: "permission.updated",
      properties: {
        id: "perm-001",
        sessionID: SESSION_ID,
        permission: "bash",
        title: "Run bash command",
        metadata: { cmd: "rm -rf /tmp/test" },
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("permission_request");
    expect(msg!.role).toBe("system");
    expect(msg!.metadata.request_id).toBe("perm-001");
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
    expect(msg!.metadata.permission).toBe("bash");
    expect(msg!.metadata.title).toBe("Run bash command");
    expect(msg!.metadata.extra).toEqual({ cmd: "rm -rf /tmp/test" });
  });

  it("handles missing title and metadata gracefully", () => {
    const event: OpencodeEvent = {
      type: "permission.updated",
      properties: {
        id: "perm-002",
        sessionID: SESSION_ID,
        permission: "network",
      },
    };
    const msg = translateEvent(event);
    expect(msg!.metadata.title).toBeUndefined();
    expect(msg!.metadata.extra).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// translateEvent — server.connected
// ---------------------------------------------------------------------------

describe("translateEvent: server.connected", () => {
  it("produces session_init", () => {
    const event: OpencodeEvent = {
      type: "server.connected",
      properties: {},
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("session_init");
    expect(msg!.role).toBe("system");
  });
});

// ---------------------------------------------------------------------------
// translateEvent — null-return events (non-user-facing)
// ---------------------------------------------------------------------------

describe("translateEvent: non-user-facing events return null", () => {
  it("server.heartbeat → null", () => {
    const event: OpencodeEvent = { type: "server.heartbeat", properties: {} };
    expect(translateEvent(event)).toBeNull();
  });

  it("permission.replied → null", () => {
    const event: OpencodeEvent = {
      type: "permission.replied",
      properties: { id: "perm-001", sessionID: SESSION_ID, reply: "once" },
    };
    expect(translateEvent(event)).toBeNull();
  });

  it("session.compacted → session_lifecycle", () => {
    const event: OpencodeEvent = {
      type: "session.compacted",
      properties: { sessionID: SESSION_ID },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("session_lifecycle");
    expect(msg!.metadata.subtype).toBe("session_compacted");
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
  });

  it("session.created → null", () => {
    const event: OpencodeEvent = {
      type: "session.created",
      properties: {
        session: {
          id: SESSION_ID,
          slug: "test",
          projectID: "proj-1",
          directory: "/tmp",
          title: "Test",
          version: "1.0.0",
          time: { created: 1000, updated: 1001 },
        },
      },
    };
    expect(translateEvent(event)).toBeNull();
  });

  it("session.updated → null", () => {
    const event: OpencodeEvent = {
      type: "session.updated",
      properties: {
        session: {
          id: SESSION_ID,
          slug: "test",
          projectID: "proj-1",
          directory: "/tmp",
          title: "Test",
          version: "1.0.0",
          time: { created: 1000, updated: 2000 },
        },
      },
    };
    expect(translateEvent(event)).toBeNull();
  });

  it("session.deleted → null", () => {
    const event: OpencodeEvent = {
      type: "session.deleted",
      properties: { sessionID: SESSION_ID },
    };
    expect(translateEvent(event)).toBeNull();
  });

  it("message.removed → session_lifecycle", () => {
    const event: OpencodeEvent = {
      type: "message.removed",
      properties: { messageID: MESSAGE_ID, sessionID: SESSION_ID },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("session_lifecycle");
    expect(msg!.metadata.subtype).toBe("message_removed");
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
    expect(msg!.metadata.message_id).toBe(MESSAGE_ID);
  });

  it("message.part.removed → null", () => {
    const event: OpencodeEvent = {
      type: "message.part.removed",
      properties: { partID: PART_ID, messageID: MESSAGE_ID, sessionID: SESSION_ID },
    };
    expect(translateEvent(event)).toBeNull();
  });

  it("session.diff → null", () => {
    const event: OpencodeEvent = {
      type: "session.diff",
      properties: { sessionID: SESSION_ID, diffs: [] },
    };
    expect(translateEvent(event)).toBeNull();
  });

  it("step-start part → status_change", () => {
    const event: OpencodeEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-start",
          id: PART_ID,
          messageID: MESSAGE_ID,
          sessionID: SESSION_ID,
        },
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("status_change");
    expect(msg!.metadata.step).toBe("start");
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
  });

  it("step-finish part → status_change", () => {
    const event: OpencodeEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          id: PART_ID,
          messageID: MESSAGE_ID,
          sessionID: SESSION_ID,
        },
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("status_change");
    expect(msg!.metadata.step).toBe("finish");
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
  });
});

// ---------------------------------------------------------------------------
// translateToOpencode — outbound translation
// ---------------------------------------------------------------------------

describe("translateToOpencode: user_message", () => {
  it("produces prompt action with text parts from content", () => {
    const message = {
      id: "um-1",
      timestamp: Date.now(),
      type: "user_message" as const,
      role: "user" as const,
      content: [{ type: "text" as const, text: "Hello opencode" }],
      metadata: {},
    };
    const action: OpencodeAction = translateToOpencode(message);
    expect(action.type).toBe("prompt");
    if (action.type === "prompt") {
      expect(action.parts).toHaveLength(1);
      expect(action.parts[0].type).toBe("text");
      expect(action.parts[0].text).toBe("Hello opencode");
      expect(action.model).toBeUndefined();
    }
  });

  it("falls back to metadata.text when content is empty", () => {
    const message = {
      id: "um-2",
      timestamp: Date.now(),
      type: "user_message" as const,
      role: "user" as const,
      content: [],
      metadata: { text: "Fallback text" },
    };
    const action = translateToOpencode(message);
    expect(action.type).toBe("prompt");
    if (action.type === "prompt") {
      expect(action.parts).toHaveLength(1);
      expect(action.parts[0].text).toBe("Fallback text");
    }
  });

  it("produces empty parts array when both content and metadata.text are missing", () => {
    const message = {
      id: "um-3",
      timestamp: Date.now(),
      type: "user_message" as const,
      role: "user" as const,
      content: [],
      metadata: {},
    };
    const action = translateToOpencode(message);
    expect(action.type).toBe("prompt");
    if (action.type === "prompt") {
      expect(action.parts).toHaveLength(0);
    }
  });

  it("includes model when present in metadata", () => {
    const message = {
      id: "um-4",
      timestamp: Date.now(),
      type: "user_message" as const,
      role: "user" as const,
      content: [{ type: "text" as const, text: "With model" }],
      metadata: { model: { providerID: "anthropic", modelID: "claude-3-opus" } },
    };
    const action = translateToOpencode(message);
    expect(action.type).toBe("prompt");
    if (action.type === "prompt") {
      expect(action.model).toEqual({ providerID: "anthropic", modelID: "claude-3-opus" });
    }
  });

  it("filters non-text content blocks", () => {
    const message = {
      id: "um-5",
      timestamp: Date.now(),
      type: "user_message" as const,
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Text only" },
        {
          type: "tool_use" as const,
          id: "tu-1",
          name: "bash",
          input: {} as Record<string, unknown>,
        },
      ],
      metadata: {},
    };
    const action = translateToOpencode(message);
    expect(action.type).toBe("prompt");
    if (action.type === "prompt") {
      expect(action.parts).toHaveLength(1);
      expect(action.parts[0].text).toBe("Text only");
    }
  });
});

describe("translateToOpencode: permission_response", () => {
  it("maps behavior=allow to reply=once", () => {
    const message = {
      id: "pr-1",
      timestamp: Date.now(),
      type: "permission_response" as const,
      role: "user" as const,
      content: [],
      metadata: { request_id: "perm-001", behavior: "allow" },
    };
    const action = translateToOpencode(message);
    expect(action.type).toBe("permission_reply");
    if (action.type === "permission_reply") {
      expect(action.requestId).toBe("perm-001");
      expect(action.reply).toBe("once");
    }
  });

  it("maps behavior=deny to reply=reject", () => {
    const message = {
      id: "pr-2",
      timestamp: Date.now(),
      type: "permission_response" as const,
      role: "user" as const,
      content: [],
      metadata: { request_id: "perm-002", behavior: "deny" },
    };
    const action = translateToOpencode(message);
    expect(action.type).toBe("permission_reply");
    if (action.type === "permission_reply") {
      expect(action.reply).toBe("reject");
    }
  });

  it("maps missing behavior to reply=reject (safe default)", () => {
    const message = {
      id: "pr-3",
      timestamp: Date.now(),
      type: "permission_response" as const,
      role: "user" as const,
      content: [],
      metadata: { request_id: "perm-003" },
    };
    const action = translateToOpencode(message);
    expect(action.type).toBe("permission_reply");
    if (action.type === "permission_reply") {
      expect(action.reply).toBe("reject");
    }
  });
});

describe("translateToOpencode: interrupt", () => {
  it("produces abort action", () => {
    const message = {
      id: "int-1",
      timestamp: Date.now(),
      type: "interrupt" as const,
      role: "user" as const,
      content: [],
      metadata: {},
    };
    const action = translateToOpencode(message);
    expect(action).toEqual({ type: "abort" });
  });
});

describe("translateToOpencode: session_init", () => {
  it("produces noop action", () => {
    const message = {
      id: "init-1",
      timestamp: Date.now(),
      type: "session_init" as const,
      role: "system" as const,
      content: [],
      metadata: {},
    };
    const action = translateToOpencode(message);
    expect(action).toEqual({ type: "noop" });
  });
});

describe("translateToOpencode: unsupported type", () => {
  it("throws for unknown message types", () => {
    const message = {
      id: "unknown-1",
      timestamp: Date.now(),
      type: "some_unknown_type" as const,
      role: "user" as const,
      content: [],
      metadata: {},
    };
    expect(() => translateToOpencode(message)).toThrow(
      "Unsupported message type for opencode: some_unknown_type",
    );
  });
});

describe("translateToOpencode: permission_response with always", () => {
  it("maps behavior=always to reply=always", () => {
    const message = {
      id: "perm-always-1",
      timestamp: Date.now(),
      type: "permission_response" as const,
      role: "user" as const,
      content: [],
      metadata: { request_id: "perm-004", behavior: "always" },
    };
    const action = translateToOpencode(message);
    expect(action.type).toBe("permission_reply");
    if (action.type === "permission_reply") {
      expect(action.reply).toBe("always");
    }
  });
});

// ---------------------------------------------------------------------------
// extractSessionId
// ---------------------------------------------------------------------------

describe("extractSessionId", () => {
  it("returns undefined for server.connected", () => {
    const event: OpencodeEvent = { type: "server.connected", properties: {} };
    expect(extractSessionId(event)).toBeUndefined();
  });

  it("returns undefined for server.heartbeat", () => {
    const event: OpencodeEvent = { type: "server.heartbeat", properties: {} };
    expect(extractSessionId(event)).toBeUndefined();
  });

  it("extracts sessionID from session.status", () => {
    const event: OpencodeEvent = {
      type: "session.status",
      properties: { sessionID: SESSION_ID, status: { type: "idle" } },
    };
    expect(extractSessionId(event)).toBe(SESSION_ID);
  });

  it("extracts sessionID from session.error", () => {
    const event: OpencodeEvent = {
      type: "session.error",
      properties: {
        sessionID: SESSION_ID,
        error: { name: "unknown", data: { message: "err" } },
      },
    };
    expect(extractSessionId(event)).toBe(SESSION_ID);
  });

  it("extracts sessionID from message.part.updated (via part.sessionID)", () => {
    const event = makeTextPartEvent({ text: "hi", delta: "h" });
    expect(extractSessionId(event)).toBe(SESSION_ID);
  });

  it("extracts sessionID from message.part.delta", () => {
    const event: OpencodeEvent = {
      type: "message.part.delta",
      properties: {
        sessionID: SESSION_ID,
        messageID: MESSAGE_ID,
        partID: PART_ID,
        field: "text",
        delta: "a",
      },
    };
    expect(extractSessionId(event)).toBe(SESSION_ID);
  });

  it("extracts sessionID from message.updated (via info.sessionID)", () => {
    const event: OpencodeEvent = {
      type: "message.updated",
      properties: {
        info: {
          id: MESSAGE_ID,
          sessionID: SESSION_ID,
          role: "user",
          time: { created: 1000 },
          agent: "default",
          model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
        },
      },
    };
    expect(extractSessionId(event)).toBe(SESSION_ID);
  });

  it("extracts sessionID from permission.updated (via properties.sessionID)", () => {
    const event: OpencodeEvent = {
      type: "permission.updated",
      properties: { id: "perm-1", sessionID: SESSION_ID, permission: "bash" },
    };
    expect(extractSessionId(event)).toBe(SESSION_ID);
  });

  it("extracts sessionID from permission.replied", () => {
    const event: OpencodeEvent = {
      type: "permission.replied",
      properties: { id: "perm-1", sessionID: SESSION_ID, reply: "once" },
    };
    expect(extractSessionId(event)).toBe(SESSION_ID);
  });

  it("extracts session id from session.created via session.id", () => {
    const event: OpencodeEvent = {
      type: "session.created",
      properties: {
        session: {
          id: SESSION_ID,
          slug: "test",
          projectID: "proj-1",
          directory: "/tmp",
          title: "Test",
          version: "1.0.0",
          time: { created: 1000, updated: 1001 },
        },
      },
    };
    expect(extractSessionId(event)).toBe(SESSION_ID);
  });

  it("extracts session id from session.created via info.id", () => {
    const event: OpencodeEvent = {
      type: "session.created",
      properties: {
        info: {
          id: SESSION_ID,
          slug: "test",
          projectID: "proj-1",
          directory: "/tmp",
          title: "Test",
          version: "1.0.0",
          time: { created: 1000, updated: 1001 },
        },
      },
    };
    expect(extractSessionId(event)).toBe(SESSION_ID);
  });

  it("extracts session id from session.updated via info.id", () => {
    const event: OpencodeEvent = {
      type: "session.updated",
      properties: {
        info: {
          id: SESSION_ID,
          slug: "test",
          projectID: "proj-1",
          directory: "/tmp",
          title: "Test",
          version: "1.0.0",
          time: { created: 1000, updated: 1002 },
        },
      },
    };
    expect(extractSessionId(event)).toBe(SESSION_ID);
  });

  it("extracts sessionID from session.deleted", () => {
    const event: OpencodeEvent = {
      type: "session.deleted",
      properties: { sessionID: SESSION_ID },
    };
    expect(extractSessionId(event)).toBe(SESSION_ID);
  });

  it("extracts sessionID from session.compacted", () => {
    const event: OpencodeEvent = {
      type: "session.compacted",
      properties: { sessionID: SESSION_ID },
    };
    expect(extractSessionId(event)).toBe(SESSION_ID);
  });

  it("extracts sessionID from message.removed", () => {
    const event: OpencodeEvent = {
      type: "message.removed",
      properties: { messageID: MESSAGE_ID, sessionID: SESSION_ID },
    };
    expect(extractSessionId(event)).toBe(SESSION_ID);
  });

  it("extracts sessionID from message.part.removed", () => {
    const event: OpencodeEvent = {
      type: "message.part.removed",
      properties: { partID: PART_ID, messageID: MESSAGE_ID, sessionID: SESSION_ID },
    };
    expect(extractSessionId(event)).toBe(SESSION_ID);
  });

  it("extracts sessionID from session.diff", () => {
    const event: OpencodeEvent = {
      type: "session.diff",
      properties: { sessionID: SESSION_ID, diffs: [] },
    };
    expect(extractSessionId(event)).toBe(SESSION_ID);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("tool part event carries all expected metadata fields", () => {
    const event = makeToolPartEvent("completed");
    const msg = translateEvent(event);
    expect(msg!.metadata.part_id).toBe(PART_ID);
    expect(msg!.metadata.message_id).toBe(MESSAGE_ID);
    expect(msg!.metadata.session_id).toBe(SESSION_ID);
    expect(msg!.metadata.tool_use_id).toBe("call-1");
  });

  it("each translated message gets a unique id", () => {
    const e1 = makeTextPartEvent({ text: "a", delta: "a" });
    const e2 = makeTextPartEvent({ text: "b", delta: "b" });
    const m1 = translateEvent(e1);
    const m2 = translateEvent(e2);
    expect(m1!.id).not.toBe(m2!.id);
  });

  it("each translated message timestamp is a positive number", () => {
    const event = makeTextPartEvent({});
    const msg = translateEvent(event);
    expect(msg!.timestamp).toBeGreaterThan(0);
  });

  it("content array is always present (not undefined)", () => {
    const event: OpencodeEvent = {
      type: "session.status",
      properties: { sessionID: SESSION_ID, status: { type: "idle" } },
    };
    const msg = translateEvent(event);
    expect(Array.isArray(msg!.content)).toBe(true);
  });

  it("metadata is always an object (not undefined)", () => {
    const event: OpencodeEvent = {
      type: "server.connected",
      properties: {},
    };
    const msg = translateEvent(event);
    expect(typeof msg!.metadata).toBe("object");
    expect(msg!.metadata).not.toBeNull();
  });
});
