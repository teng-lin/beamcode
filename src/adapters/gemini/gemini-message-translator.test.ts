import { describe, expect, it } from "vitest";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import {
  buildCancelBody,
  buildMessageStreamBody,
  translateA2AEvent,
  translateToGemini,
} from "./gemini-message-translator.js";
import type { A2AStreamEvent } from "./gemini-types.js";

// ---------------------------------------------------------------------------
// Helpers — A2A SSE event factories
// ---------------------------------------------------------------------------

function makeTaskSubmitted(): A2AStreamEvent {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "task",
      id: "task-123",
      contextId: "ctx-456",
      status: { state: "submitted", timestamp: "2026-01-01T00:00:00Z" },
    },
  };
}

function makeTextContent(text = "Hello world"): A2AStreamEvent {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId: "task-123",
      contextId: "ctx-456",
      status: {
        state: "working",
        message: {
          kind: "message",
          role: "agent",
          parts: [{ kind: "text", text }],
          messageId: "msg-1",
        },
      },
      metadata: { coderAgent: { kind: "text-content" } },
    },
  };
}

function makeToolCallUpdate(): A2AStreamEvent {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId: "task-123",
      contextId: "ctx-456",
      status: {
        state: "working",
        message: {
          kind: "message",
          role: "agent",
          parts: [
            {
              kind: "data",
              data: {
                tool_call_id: "tc-1",
                tool_name: "shell",
                status: "EXECUTING",
                description: "Running ls",
                input_parameters: { command: "ls" },
              },
            },
          ],
          messageId: "msg-2",
        },
      },
      metadata: { coderAgent: { kind: "tool-call-update" } },
    },
  };
}

function makeToolConfirmation(): A2AStreamEvent {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId: "task-123",
      contextId: "ctx-456",
      status: {
        state: "working",
        message: {
          kind: "message",
          role: "agent",
          parts: [
            {
              kind: "data",
              data: {
                tool_call_id: "tc-2",
                tool_name: "write_file",
                status: "PENDING",
                description: "Write to /etc/passwd",
                confirmation_request: {
                  options: [
                    { id: "proceed_once", name: "Proceed", description: "Allow once" },
                    { id: "reject", name: "Reject", description: "Deny" },
                  ],
                },
              },
            },
          ],
          messageId: "msg-3",
        },
      },
      metadata: { coderAgent: { kind: "tool-call-confirmation" } },
    },
  };
}

function makeThought(text = "Let me think..."): A2AStreamEvent {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId: "task-123",
      contextId: "ctx-456",
      status: {
        state: "working",
        message: {
          kind: "message",
          role: "agent",
          parts: [{ kind: "text", text }],
          messageId: "msg-4",
        },
      },
      metadata: { coderAgent: { kind: "thought" } },
    },
  };
}

function makeStateChangeWorking(): A2AStreamEvent {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId: "task-123",
      contextId: "ctx-456",
      status: { state: "working" },
      metadata: { coderAgent: { kind: "state-change" } },
    },
  };
}

function makeInputRequired(): A2AStreamEvent {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId: "task-123",
      contextId: "ctx-456",
      status: { state: "input-required" },
      final: true,
      metadata: { coderAgent: { kind: "state-change" } },
    },
  };
}

function makeCompleted(): A2AStreamEvent {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId: "task-123",
      contextId: "ctx-456",
      status: { state: "completed" },
      final: true,
      metadata: { coderAgent: { kind: "state-change" } },
    },
  };
}

function makeFailed(): A2AStreamEvent {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId: "task-123",
      contextId: "ctx-456",
      status: {
        state: "failed",
        message: {
          kind: "message",
          role: "agent",
          parts: [{ kind: "text", text: "Rate limit exceeded" }],
          messageId: "msg-err",
        },
      },
      final: true,
      metadata: { coderAgent: { kind: "state-change" } },
    },
  };
}

function makeJsonRpcError(): A2AStreamEvent {
  return {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32600, message: "Invalid request" },
  };
}

// ---------------------------------------------------------------------------
// Tests — Outbound: A2A → UnifiedMessage
// ---------------------------------------------------------------------------

describe("gemini-message-translator", () => {
  describe("translateA2AEvent", () => {
    describe("task submitted → session_init", () => {
      it("translates with correct type and role", () => {
        const result = translateA2AEvent(makeTaskSubmitted());
        expect(result).not.toBeNull();
        expect(result!.type).toBe("session_init");
        expect(result!.role).toBe("system");
      });

      it("places task_id and context_id in metadata", () => {
        const result = translateA2AEvent(makeTaskSubmitted())!;
        expect(result.metadata.task_id).toBe("task-123");
        expect(result.metadata.context_id).toBe("ctx-456");
        expect(result.metadata.state).toBe("submitted");
      });
    });

    describe("text-content → stream_event", () => {
      it("translates with correct type and role", () => {
        const result = translateA2AEvent(makeTextContent());
        expect(result).not.toBeNull();
        expect(result!.type).toBe("stream_event");
        expect(result!.role).toBe("assistant");
      });

      it("places text in delta metadata", () => {
        const result = translateA2AEvent(makeTextContent("world"))!;
        expect(result.metadata.delta).toBe("world");
        expect(result.metadata.task_id).toBe("task-123");
      });
    });

    describe("tool-call-update → tool_progress", () => {
      it("translates with correct type and role", () => {
        const result = translateA2AEvent(makeToolCallUpdate());
        expect(result).not.toBeNull();
        expect(result!.type).toBe("tool_progress");
        expect(result!.role).toBe("tool");
      });

      it("places tool call details in metadata", () => {
        const result = translateA2AEvent(makeToolCallUpdate())!;
        expect(result.metadata.tool_call_id).toBe("tc-1");
        expect(result.metadata.tool_name).toBe("shell");
        expect(result.metadata.status).toBe("EXECUTING");
        expect(result.metadata.description).toBe("Running ls");
      });
    });

    describe("tool-call-confirmation → permission_request", () => {
      it("translates with correct type and role", () => {
        const result = translateA2AEvent(makeToolConfirmation());
        expect(result).not.toBeNull();
        expect(result!.type).toBe("permission_request");
        expect(result!.role).toBe("system");
      });

      it("places confirmation details in metadata", () => {
        const result = translateA2AEvent(makeToolConfirmation())!;
        expect(result.metadata.tool_call_id).toBe("tc-2");
        expect(result.metadata.tool_name).toBe("write_file");
        const options = result.metadata.confirmation_options as Array<{ id: string }>;
        expect(options).toHaveLength(2);
        expect(options[0].id).toBe("proceed_once");
      });
    });

    describe("thought → stream_event (thought)", () => {
      it("translates with thought flag", () => {
        const result = translateA2AEvent(makeThought());
        expect(result).not.toBeNull();
        expect(result!.type).toBe("stream_event");
        expect(result!.metadata.thought).toBe(true);
        expect(result!.metadata.delta).toBe("Let me think...");
      });
    });

    describe("state-change (non-final) → null", () => {
      it("returns null for working state-change", () => {
        expect(translateA2AEvent(makeStateChangeWorking())).toBeNull();
      });
    });

    describe("input-required (final) → result", () => {
      it("translates to result with input-required status", () => {
        const result = translateA2AEvent(makeInputRequired());
        expect(result).not.toBeNull();
        expect(result!.type).toBe("result");
        expect(result!.metadata.status).toBe("input-required");
      });
    });

    describe("completed (final) → result", () => {
      it("translates to result with completed status", () => {
        const result = translateA2AEvent(makeCompleted());
        expect(result).not.toBeNull();
        expect(result!.type).toBe("result");
        expect(result!.metadata.status).toBe("completed");
      });
    });

    describe("failed (final) → result (error)", () => {
      it("translates to result with is_error", () => {
        const result = translateA2AEvent(makeFailed());
        expect(result).not.toBeNull();
        expect(result!.type).toBe("result");
        expect(result!.metadata.is_error).toBe(true);
        expect(result!.metadata.status).toBe("failed");
        expect(result!.metadata.error).toBe("Rate limit exceeded");
      });
    });

    describe("JSON-RPC error → result (error)", () => {
      it("translates to error result", () => {
        const result = translateA2AEvent(makeJsonRpcError());
        expect(result).not.toBeNull();
        expect(result!.type).toBe("result");
        expect(result!.metadata.is_error).toBe(true);
        expect(result!.metadata.error).toBe("Invalid request");
        expect(result!.metadata.error_code).toBe(-32600);
      });
    });

    describe("null returns", () => {
      it("returns null when result is absent", () => {
        const event: A2AStreamEvent = { jsonrpc: "2.0", id: 1 };
        expect(translateA2AEvent(event)).toBeNull();
      });

      it("returns null for unknown result kind", () => {
        const event: A2AStreamEvent = {
          jsonrpc: "2.0",
          id: 1,
          result: { kind: "unknown" } as any,
        };
        expect(translateA2AEvent(event)).toBeNull();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — Inbound: UnifiedMessage → Gemini action
  // ---------------------------------------------------------------------------

  describe("translateToGemini", () => {
    it("translates user_message → message_stream", () => {
      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "Write a function" }],
      });
      const action = translateToGemini(msg);
      expect(action.type).toBe("message_stream");
      expect(action.message?.role).toBe("user");
      expect(action.message?.parts[0]).toEqual({ kind: "text", text: "Write a function" });
    });

    it("translates permission_response (allow) → message_stream_resume", () => {
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: {
          behavior: "allow",
          tool_call_id: "tc-1",
          task_id: "task-123",
        },
      });
      const action = translateToGemini(msg);
      expect(action.type).toBe("message_stream_resume");
      expect(action.taskId).toBe("task-123");
      const dataPart = action.message?.parts[0];
      expect(dataPart?.kind).toBe("data");
      if (dataPart?.kind === "data") {
        expect(dataPart.data.tool_call_id).toBe("tc-1");
        expect(dataPart.data.selected_option_id).toBe("proceed_once");
      }
    });

    it("translates permission_response (deny) → message_stream_resume with reject", () => {
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: {
          behavior: "deny",
          tool_call_id: "tc-1",
          task_id: "task-123",
        },
      });
      const action = translateToGemini(msg);
      expect(action.type).toBe("message_stream_resume");
      const dataPart = action.message?.parts[0];
      if (dataPart?.kind === "data") {
        expect(dataPart.data.selected_option_id).toBe("reject");
      }
    });

    it("translates interrupt → cancel", () => {
      const msg = createUnifiedMessage({
        type: "interrupt",
        role: "user",
        metadata: { task_id: "task-123" },
      });
      const action = translateToGemini(msg);
      expect(action.type).toBe("cancel");
      expect(action.taskId).toBe("task-123");
    });

    it("translates session_init → noop", () => {
      const msg = createUnifiedMessage({
        type: "session_init",
        role: "system",
      });
      const action = translateToGemini(msg);
      expect(action.type).toBe("noop");
    });

    it("falls back to noop for unknown types", () => {
      const msg = createUnifiedMessage({
        type: "configuration_change",
        role: "user",
      });
      const action = translateToGemini(msg);
      expect(action.type).toBe("noop");
    });

    it("concatenates multiple text content blocks", () => {
      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [
          { type: "text", text: "Line 1" },
          { type: "text", text: "Line 2" },
        ],
      });
      const action = translateToGemini(msg);
      expect(action.message?.parts[0]).toEqual({ kind: "text", text: "Line 1\nLine 2" });
    });

    it("falls back to metadata.text when no content", () => {
      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        metadata: { text: "from metadata" },
      });
      const action = translateToGemini(msg);
      expect(action.message?.parts[0]).toEqual({ kind: "text", text: "from metadata" });
    });
  });

  // ---------------------------------------------------------------------------
  // JSON-RPC body builders
  // ---------------------------------------------------------------------------

  describe("buildMessageStreamBody", () => {
    it("builds a valid JSON-RPC message/stream body", () => {
      const body = buildMessageStreamBody(1, {
        kind: "message",
        role: "user",
        parts: [{ kind: "text", text: "hello" }],
        messageId: "msg-1",
      });
      const parsed = JSON.parse(body);
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.id).toBe(1);
      expect(parsed.method).toBe("message/stream");
      expect(parsed.params.message.kind).toBe("message");
      expect(parsed.params.message.parts[0].text).toBe("hello");
    });

    it("includes taskId when provided", () => {
      const body = buildMessageStreamBody(
        2,
        {
          kind: "message",
          role: "user",
          parts: [
            { kind: "data", data: { tool_call_id: "tc-1", selected_option_id: "proceed_once" } },
          ],
          messageId: "msg-2",
        },
        "task-123",
      );
      const parsed = JSON.parse(body);
      expect(parsed.params.id).toBe("task-123");
    });
  });

  describe("buildCancelBody", () => {
    it("builds a valid JSON-RPC tasks/cancel body", () => {
      const body = buildCancelBody(3, "task-123");
      const parsed = JSON.parse(body);
      expect(parsed.method).toBe("tasks/cancel");
      expect(parsed.params.id).toBe("task-123");
    });
  });

  // ---------------------------------------------------------------------------
  // Shape validation
  // ---------------------------------------------------------------------------

  describe("unified message shape", () => {
    it("all translated messages have required fields", () => {
      const events: A2AStreamEvent[] = [
        makeTaskSubmitted(),
        makeTextContent(),
        makeToolCallUpdate(),
        makeToolConfirmation(),
        makeThought(),
        makeInputRequired(),
        makeCompleted(),
        makeFailed(),
        makeJsonRpcError(),
      ];

      for (const event of events) {
        const result = translateA2AEvent(event)!;
        expect(result.id).toBeTruthy();
        expect(typeof result.timestamp).toBe("number");
        expect(result.type).toBeTruthy();
        expect(result.role).toBeTruthy();
        expect(Array.isArray(result.content)).toBe(true);
        expect(typeof result.metadata).toBe("object");
      }
    });

    it("generates unique IDs", () => {
      const r1 = translateA2AEvent(makeTextContent("a"))!;
      const r2 = translateA2AEvent(makeTextContent("b"))!;
      expect(r1.id).not.toBe(r2.id);
    });
  });
});
