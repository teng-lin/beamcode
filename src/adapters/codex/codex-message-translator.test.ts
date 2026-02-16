import { describe, expect, it } from "vitest";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type {
  CodexApprovalRequest,
  CodexInitResponse,
  CodexTurnEvent,
} from "./codex-message-translator.js";
import {
  translateApprovalRequest,
  translateCodexEvent,
  translateInitResponse,
  translateToCodex,
} from "./codex-message-translator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextDelta(delta = "Hello", outputIndex = 0): CodexTurnEvent {
  return {
    type: "response.output_text.delta",
    delta,
    output_index: outputIndex,
  };
}

function makeItemAddedMessage(): CodexTurnEvent {
  return {
    type: "response.output_item.added",
    item: {
      type: "message",
      id: "item-1",
      role: "assistant",
      content: [{ type: "output_text", text: "Hi there" }],
      status: "in_progress",
    },
    output_index: 0,
  };
}

function makeItemAddedFunctionCall(): CodexTurnEvent {
  return {
    type: "response.output_item.added",
    item: {
      type: "function_call",
      id: "fc-1",
      name: "shell",
      arguments: '{"command":"ls"}',
      call_id: "call-1",
      status: "in_progress",
    },
    output_index: 1,
  };
}

function makeItemDoneFunctionOutput(): CodexTurnEvent {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call_output",
      id: "fco-1",
      call_id: "call-1",
      output: "file1.ts\nfile2.ts",
      status: "completed",
    },
    output_index: 2,
  };
}

function makeResponseCompleted(): CodexTurnEvent {
  return {
    type: "response.completed",
    response: {
      id: "resp-1",
      status: "completed",
      output: [
        {
          type: "message",
          id: "item-1",
          content: [{ type: "output_text", text: "Done" }],
        },
      ],
    },
  };
}

function makeResponseFailed(): CodexTurnEvent {
  return {
    type: "response.failed",
    response: {
      id: "resp-2",
      status: "failed",
      output: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — Outbound: Codex → UnifiedMessage
// ---------------------------------------------------------------------------

describe("codex-message-translator", () => {
  describe("translateCodexEvent", () => {
    describe("response.output_text.delta → stream_event", () => {
      it("translates text delta with correct type and role", () => {
        const result = translateCodexEvent(makeTextDelta());
        expect(result).not.toBeNull();
        expect(result!.type).toBe("stream_event");
        expect(result!.role).toBe("assistant");
      });

      it("places delta text in metadata", () => {
        const result = translateCodexEvent(makeTextDelta("world"))!;
        expect(result.metadata.delta).toBe("world");
        expect(result.metadata.output_index).toBe(0);
      });

      it("defaults to empty string when delta is undefined", () => {
        const event: CodexTurnEvent = {
          type: "response.output_text.delta",
          output_index: 0,
        };
        const result = translateCodexEvent(event)!;
        expect(result.metadata.delta).toBe("");
      });
    });

    describe("response.output_item.added (message) → assistant", () => {
      it("translates message item to assistant type", () => {
        const result = translateCodexEvent(makeItemAddedMessage());
        expect(result).not.toBeNull();
        expect(result!.type).toBe("assistant");
        expect(result!.role).toBe("assistant");
      });

      it("converts item content to UnifiedContent text blocks", () => {
        const result = translateCodexEvent(makeItemAddedMessage())!;
        expect(result.content).toHaveLength(1);
        expect(result.content[0]).toEqual({ type: "text", text: "Hi there" });
      });

      it("places item_id and status in metadata", () => {
        const result = translateCodexEvent(makeItemAddedMessage())!;
        expect(result.metadata.item_id).toBe("item-1");
        expect(result.metadata.status).toBe("in_progress");
      });
    });

    describe("response.output_item.added (function_call) → tool_progress", () => {
      it("translates function_call to tool_progress", () => {
        const result = translateCodexEvent(makeItemAddedFunctionCall());
        expect(result).not.toBeNull();
        expect(result!.type).toBe("tool_progress");
        expect(result!.role).toBe("tool");
      });

      it("places function call details in metadata", () => {
        const result = translateCodexEvent(makeItemAddedFunctionCall())!;
        expect(result.metadata.name).toBe("shell");
        expect(result.metadata.arguments).toBe('{"command":"ls"}');
        expect(result.metadata.call_id).toBe("call-1");
        expect(result.metadata.item_id).toBe("fc-1");
      });
    });

    describe("response.output_item.done (function_call_output) → tool_use_summary", () => {
      it("translates function output to tool_use_summary", () => {
        const result = translateCodexEvent(makeItemDoneFunctionOutput());
        expect(result).not.toBeNull();
        expect(result!.type).toBe("tool_use_summary");
        expect(result!.role).toBe("tool");
      });

      it("places output and status in metadata", () => {
        const result = translateCodexEvent(makeItemDoneFunctionOutput())!;
        expect(result.metadata.output).toBe("file1.ts\nfile2.ts");
        expect(result.metadata.call_id).toBe("call-1");
        expect(result.metadata.status).toBe("completed");
      });
    });

    describe("response.output_item.done (function_call) → tool_progress (done)", () => {
      it("translates completed function_call with done flag", () => {
        const event: CodexTurnEvent = {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc-2",
            name: "read_file",
            arguments: '{"path":"/a.ts"}',
            call_id: "call-2",
            status: "completed",
          },
          output_index: 0,
        };
        const result = translateCodexEvent(event)!;
        expect(result.type).toBe("tool_progress");
        expect(result.metadata.done).toBe(true);
        expect(result.metadata.name).toBe("read_file");
      });
    });

    describe("response.output_item.done (message) → assistant (done)", () => {
      it("translates completed message item with done flag", () => {
        const event: CodexTurnEvent = {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "msg-done",
            content: [{ type: "output_text", text: "Final text" }],
            status: "completed",
          },
          output_index: 0,
        };
        const result = translateCodexEvent(event)!;
        expect(result.type).toBe("assistant");
        expect(result.metadata.done).toBe(true);
        expect(result.content[0]).toEqual({ type: "text", text: "Final text" });
      });
    });

    describe("response.completed → result", () => {
      it("translates to result type", () => {
        const result = translateCodexEvent(makeResponseCompleted());
        expect(result).not.toBeNull();
        expect(result!.type).toBe("result");
        expect(result!.role).toBe("system");
      });

      it("includes response status and id", () => {
        const result = translateCodexEvent(makeResponseCompleted())!;
        expect(result.metadata.status).toBe("completed");
        expect(result.metadata.response_id).toBe("resp-1");
        expect(result.metadata.output_items).toBe(1);
      });
    });

    describe("response.failed → result (error)", () => {
      it("translates to result with is_error", () => {
        const result = translateCodexEvent(makeResponseFailed());
        expect(result).not.toBeNull();
        expect(result!.type).toBe("result");
        expect(result!.metadata.is_error).toBe(true);
        expect(result!.metadata.status).toBe("failed");
      });

      it("includes response id", () => {
        const result = translateCodexEvent(makeResponseFailed())!;
        expect(result.metadata.response_id).toBe("resp-2");
      });
    });

    describe("null returns for events without items", () => {
      it("returns null when item.added has no item", () => {
        const event: CodexTurnEvent = {
          type: "response.output_item.added",
          output_index: 0,
        };
        expect(translateCodexEvent(event)).toBeNull();
      });

      it("returns null when item.done has no item", () => {
        const event: CodexTurnEvent = {
          type: "response.output_item.done",
          output_index: 0,
        };
        expect(translateCodexEvent(event)).toBeNull();
      });
    });

    describe("refusal content", () => {
      it("converts refusal parts to text with prefix", () => {
        const event: CodexTurnEvent = {
          type: "response.output_item.added",
          item: {
            type: "message",
            id: "ref-1",
            content: [{ type: "refusal", refusal: "I cannot do that" }],
          },
          output_index: 0,
        };
        const result = translateCodexEvent(event)!;
        expect(result.content[0]).toEqual({
          type: "text",
          text: "[Refusal] I cannot do that",
        });
      });
    });
  });

  describe("translateApprovalRequest", () => {
    it("translates to permission_request", () => {
      const request: CodexApprovalRequest = {
        type: "approval_requested",
        item: {
          type: "function_call",
          id: "fc-3",
          name: "shell",
          arguments: '{"command":"rm -rf /"}',
          call_id: "call-3",
        },
      };
      const result = translateApprovalRequest(request);
      expect(result.type).toBe("permission_request");
      expect(result.role).toBe("system");
      expect(result.metadata.tool_name).toBe("shell");
      expect(result.metadata.call_id).toBe("call-3");
    });

    it("includes full item details in metadata", () => {
      const request: CodexApprovalRequest = {
        type: "approval_requested",
        item: {
          type: "function_call",
          id: "fc-4",
          name: "write_file",
          arguments: '{"path":"/etc/passwd","content":"hack"}',
          call_id: "call-4",
        },
      };
      const result = translateApprovalRequest(request);
      const item = result.metadata.item as Record<string, unknown>;
      expect(item.type).toBe("function_call");
      expect(item.name).toBe("write_file");
      expect(item.arguments).toBe('{"path":"/etc/passwd","content":"hack"}');
    });
  });

  describe("translateInitResponse", () => {
    it("translates to session_init", () => {
      const response: CodexInitResponse = {
        capabilities: { streaming: true, tools: ["shell"] },
        version: "1.2.3",
      };
      const result = translateInitResponse(response);
      expect(result.type).toBe("session_init");
      expect(result.role).toBe("system");
      expect(result.metadata.capabilities).toEqual({
        streaming: true,
        tools: ["shell"],
      });
      expect(result.metadata.version).toBe("1.2.3");
    });

    it("works without version", () => {
      const response: CodexInitResponse = { capabilities: {} };
      const result = translateInitResponse(response);
      expect(result.metadata.version).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Tests — Inbound: UnifiedMessage → Codex action
  // ---------------------------------------------------------------------------

  describe("translateToCodex", () => {
    it("translates user_message → turn action", () => {
      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "Write a function" }],
      });
      const action = translateToCodex(msg);
      expect(action.type).toBe("turn");
      expect(action.input).toBe("Write a function");
    });

    it("translates permission_response (allow) → approval_response", () => {
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "allow", request_id: "req-1" },
      });
      const action = translateToCodex(msg);
      expect(action.type).toBe("approval_response");
      expect(action.approve).toBe(true);
      expect(action.itemId).toBe("req-1");
    });

    it("translates permission_response (deny) → approval_response", () => {
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "deny", request_id: "req-2" },
      });
      const action = translateToCodex(msg);
      expect(action.type).toBe("approval_response");
      expect(action.approve).toBe(false);
    });

    it("translates interrupt → cancel action", () => {
      const msg = createUnifiedMessage({
        type: "interrupt",
        role: "user",
      });
      const action = translateToCodex(msg);
      expect(action.type).toBe("cancel");
    });

    it("falls back to turn for unknown message types", () => {
      const msg = createUnifiedMessage({
        type: "configuration_change",
        role: "user",
        metadata: { text: "some config" },
      });
      const action = translateToCodex(msg);
      expect(action.type).toBe("turn");
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
      const action = translateToCodex(msg);
      expect(action.input).toBe("Line 1\nLine 2");
    });

    it("falls back to metadata.text when no content", () => {
      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        metadata: { text: "from metadata" },
      });
      const action = translateToCodex(msg);
      expect(action.input).toBe("from metadata");
    });
  });

  // ---------------------------------------------------------------------------
  // Shape validation
  // ---------------------------------------------------------------------------

  describe("unified message shape", () => {
    it("all translated messages have required fields", () => {
      const events: CodexTurnEvent[] = [
        makeTextDelta(),
        makeItemAddedMessage(),
        makeItemAddedFunctionCall(),
        makeItemDoneFunctionOutput(),
        makeResponseCompleted(),
        makeResponseFailed(),
      ];

      for (const event of events) {
        const result = translateCodexEvent(event)!;
        expect(result.id).toBeTruthy();
        expect(typeof result.timestamp).toBe("number");
        expect(result.type).toBeTruthy();
        expect(result.role).toBeTruthy();
        expect(Array.isArray(result.content)).toBe(true);
        expect(typeof result.metadata).toBe("object");
      }
    });

    it("generates unique IDs", () => {
      const r1 = translateCodexEvent(makeTextDelta("a"))!;
      const r2 = translateCodexEvent(makeTextDelta("b"))!;
      expect(r1.id).not.toBe(r2.id);
    });
  });
});
