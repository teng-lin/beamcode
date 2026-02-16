import { describe, expect, it } from "vitest";
import { createUnifiedMessage, isUnifiedMessage } from "../../core/types/unified-message.js";
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from "./sdk-message-translator.js";
import { translateSdkMessage, translateToSdkInput } from "./sdk-message-translator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssistantMsg(overrides?: Partial<SDKAssistantMessage>): SDKAssistantMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    },
    session_id: "sess-1",
    ...overrides,
  };
}

function makeResultMsg(overrides?: Partial<SDKResultMessage>): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    result: "Done",
    duration_ms: 1200,
    duration_api_ms: 800,
    cost_usd: 0.03,
    is_error: false,
    total_cost_usd: 0.05,
    num_turns: 3,
    session_id: "sess-1",
    ...overrides,
  };
}

function makeSystemMsg(overrides?: Partial<SDKSystemMessage>): SDKSystemMessage {
  return {
    type: "system",
    subtype: "status",
    session_id: "sess-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Outbound: SDK → UnifiedMessage
// ---------------------------------------------------------------------------

describe("sdk-message-translator", () => {
  describe("assistant with text only → UnifiedMessage assistant", () => {
    it("translates text content blocks", () => {
      const result = translateSdkMessage(makeAssistantMsg());
      expect(result.type).toBe("assistant");
      expect(result.role).toBe("assistant");
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({ type: "text", text: "Hello world" });
    });

    it("passes isUnifiedMessage guard", () => {
      const result = translateSdkMessage(makeAssistantMsg());
      expect(isUnifiedMessage(result)).toBe(true);
    });
  });

  describe("assistant with tool_use → UnifiedMessage with ToolUseContent", () => {
    it("translates tool_use content blocks", () => {
      const msg = makeAssistantMsg({
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu-1",
              name: "Read",
              input: { file_path: "/a.ts" },
            },
          ],
        },
      });
      const result = translateSdkMessage(msg);
      expect(result.type).toBe("assistant");
      expect(result.content[0]).toEqual({
        type: "tool_use",
        id: "tu-1",
        name: "Read",
        input: { file_path: "/a.ts" },
      });
    });

    it("passes isUnifiedMessage guard", () => {
      const msg = makeAssistantMsg({
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } }],
        },
      });
      expect(isUnifiedMessage(translateSdkMessage(msg))).toBe(true);
    });
  });

  describe("assistant with tool_result → UnifiedMessage with ToolResultContent", () => {
    it("translates tool_result with string content", () => {
      const msg = makeAssistantMsg({
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu-1",
              content: "file contents here",
              is_error: false,
            },
          ],
        },
      });
      const result = translateSdkMessage(msg);
      expect(result.content[0]).toEqual({
        type: "tool_result",
        tool_use_id: "tu-1",
        content: "file contents here",
        is_error: false,
      });
    });

    it("stringifies array tool_result content", () => {
      const msg = makeAssistantMsg({
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu-2",
              content: [{ type: "text", text: "inner" }],
            },
          ],
        },
      });
      const result = translateSdkMessage(msg);
      expect(typeof (result.content[0] as { content: string }).content).toBe("string");
    });

    it("passes isUnifiedMessage guard", () => {
      const msg = makeAssistantMsg({
        message: {
          role: "assistant",
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
        },
      });
      expect(isUnifiedMessage(translateSdkMessage(msg))).toBe(true);
    });
  });

  describe("assistant with mixed content → single UnifiedMessage", () => {
    it("produces a single message with multiple content blocks", () => {
      const msg = makeAssistantMsg({
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me read that file." },
            {
              type: "tool_use",
              id: "tu-1",
              name: "Read",
              input: { file_path: "/b.ts" },
            },
          ],
        },
      });
      const result = translateSdkMessage(msg);
      expect(result.type).toBe("assistant");
      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({
        type: "text",
        text: "Let me read that file.",
      });
      expect(result.content[1]).toEqual({
        type: "tool_use",
        id: "tu-1",
        name: "Read",
        input: { file_path: "/b.ts" },
      });
    });

    it("passes isUnifiedMessage guard", () => {
      const msg = makeAssistantMsg({
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Thinking..." },
            { type: "tool_use", id: "tu-2", name: "Bash", input: { command: "pwd" } },
            { type: "tool_result", tool_use_id: "tu-2", content: "/home" },
          ],
        },
      });
      expect(isUnifiedMessage(translateSdkMessage(msg))).toBe(true);
    });
  });

  describe("result → UnifiedMessage result with metadata", () => {
    it("translates with all metadata fields", () => {
      const result = translateSdkMessage(makeResultMsg());
      expect(result.type).toBe("result");
      expect(result.role).toBe("system");
      expect(result.content).toEqual([]);
      expect(result.metadata.subtype).toBe("success");
      expect(result.metadata.result).toBe("Done");
      expect(result.metadata.duration_ms).toBe(1200);
      expect(result.metadata.duration_api_ms).toBe(800);
      expect(result.metadata.cost_usd).toBe(0.03);
      expect(result.metadata.is_error).toBe(false);
      expect(result.metadata.total_cost_usd).toBe(0.05);
      expect(result.metadata.num_turns).toBe(3);
      expect(result.metadata.session_id).toBe("sess-1");
    });

    it("passes isUnifiedMessage guard", () => {
      expect(isUnifiedMessage(translateSdkMessage(makeResultMsg()))).toBe(true);
    });
  });

  describe("result with is_error → metadata.is_error = true", () => {
    it("preserves is_error flag", () => {
      const result = translateSdkMessage(makeResultMsg({ is_error: true }));
      expect(result.metadata.is_error).toBe(true);
    });
  });

  describe("system → UnifiedMessage status_change", () => {
    it("translates with metadata passthrough", () => {
      const result = translateSdkMessage(makeSystemMsg());
      expect(result.type).toBe("status_change");
      expect(result.role).toBe("system");
      expect(result.content).toEqual([]);
      expect(result.metadata.subtype).toBe("status");
      expect(result.metadata.session_id).toBe("sess-1");
    });

    it("passes through extra fields in metadata", () => {
      const msg = makeSystemMsg({ customField: "custom-value" });
      const result = translateSdkMessage(msg);
      expect(result.metadata.customField).toBe("custom-value");
    });

    it("passes isUnifiedMessage guard", () => {
      expect(isUnifiedMessage(translateSdkMessage(makeSystemMsg()))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Inbound: UnifiedMessage → SDK user message
  // ---------------------------------------------------------------------------

  describe("inbound: user_message → SDKUserMessage", () => {
    it("translates a user_message to SDKUserMessage", () => {
      const unified = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "Hello from user" }],
        metadata: { session_id: "sess-2" },
      });
      const result = translateToSdkInput(unified);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("user");
      expect(result!.message.role).toBe("user");
      expect(result!.message.content).toBe("Hello from user");
      expect(result!.session_id).toBe("sess-2");
    });

    it("joins multiple text content blocks", () => {
      const unified = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [
          { type: "text", text: "Line one" },
          { type: "text", text: "Line two" },
        ],
        metadata: {},
      });
      const result = translateToSdkInput(unified)!;
      expect(result.message.content).toBe("Line one\nLine two");
    });

    it("falls back to metadata.text when no text content blocks", () => {
      const unified = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [],
        metadata: { text: "fallback text" },
      });
      const result = translateToSdkInput(unified)!;
      expect(result.message.content).toBe("fallback text");
    });

    it("includes parent_tool_use_id from metadata", () => {
      const unified = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "reply" }],
        metadata: { parent_tool_use_id: "ptu-1" },
      });
      const result = translateToSdkInput(unified)!;
      expect(result.parent_tool_use_id).toBe("ptu-1");
    });
  });

  describe("inbound: non-user_message → null", () => {
    it("returns null for assistant messages", () => {
      const unified = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "I am assistant" }],
      });
      expect(translateToSdkInput(unified)).toBeNull();
    });

    it("returns null for result messages", () => {
      const unified = createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: { subtype: "success" },
      });
      expect(translateToSdkInput(unified)).toBeNull();
    });

    it("returns null for status_change messages", () => {
      const unified = createUnifiedMessage({
        type: "status_change",
        role: "system",
      });
      expect(translateToSdkInput(unified)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Shape validation
  // ---------------------------------------------------------------------------

  describe("unified message shape", () => {
    it("all translated messages have id, timestamp, type, role, content, metadata", () => {
      const messages: SDKMessage[] = [makeAssistantMsg(), makeResultMsg(), makeSystemMsg()];
      for (const msg of messages) {
        const result = translateSdkMessage(msg);
        expect(result.id).toBeTruthy();
        expect(typeof result.timestamp).toBe("number");
        expect(result.type).toBeTruthy();
        expect(result.role).toBeTruthy();
        expect(Array.isArray(result.content)).toBe(true);
        expect(typeof result.metadata).toBe("object");
      }
    });

    it("generates unique ids for each translation", () => {
      const r1 = translateSdkMessage(makeAssistantMsg());
      const r2 = translateSdkMessage(makeAssistantMsg());
      expect(r1.id).not.toBe(r2.id);
    });
  });
});
