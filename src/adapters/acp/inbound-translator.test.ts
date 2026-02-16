import { describe, expect, it } from "vitest";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import { translateToAcp } from "./inbound-translator.js";

// ---------------------------------------------------------------------------
// user_message → session/prompt
// ---------------------------------------------------------------------------

describe("translateToAcp", () => {
  describe("user_message → session/prompt", () => {
    it("translates plain text to session/prompt request", () => {
      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "Hello agent" }],
        metadata: { sessionId: "sess-1" },
      });
      const action = translateToAcp(msg)!;

      expect(action.type).toBe("request");
      expect(action.method).toBe("session/prompt");
      const params = action.params as { sessionId: string; prompt: unknown[] };
      expect(params.sessionId).toBe("sess-1");
      expect(params.prompt).toEqual([{ type: "text", text: "Hello agent" }]);
    });

    it("translates message with image content", () => {
      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
          { type: "text", text: "What is this?" },
        ],
        metadata: { sessionId: "sess-1" },
      });
      const action = translateToAcp(msg)!;

      const params = action.params as { prompt: unknown[] };
      expect(params.prompt).toHaveLength(2);
      expect(params.prompt[0]).toEqual({
        type: "image",
        mimeType: "image/png",
        data: "abc123",
      });
      expect(params.prompt[1]).toEqual({ type: "text", text: "What is this?" });
    });

    it("falls back to session_id in metadata", () => {
      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "Hi" }],
        metadata: { session_id: "sess-fallback" },
      });
      const action = translateToAcp(msg)!;
      const params = action.params as { sessionId: string };
      expect(params.sessionId).toBe("sess-fallback");
    });
  });

  // ---------------------------------------------------------------------------
  // permission_response → response to pending request
  // ---------------------------------------------------------------------------

  describe("permission_response → response", () => {
    it("translates allow response with context requestId", () => {
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "allow", optionId: "allow-once" },
      });
      const action = translateToAcp(msg, { pendingRequestId: 42 })!;

      expect(action.type).toBe("response");
      expect(action.requestId).toBe(42);
      const result = action.result as { outcome: { outcome: string; optionId: string } };
      expect(result.outcome.outcome).toBe("selected");
      expect(result.outcome.optionId).toBe("allow-once");
    });

    it("defaults allow optionId to allow-once", () => {
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "allow" },
      });
      const action = translateToAcp(msg)!;

      const result = action.result as { outcome: { optionId: string } };
      expect(result.outcome.optionId).toBe("allow-once");
    });

    it("translates deny response", () => {
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "deny" },
      });
      const action = translateToAcp(msg, { pendingRequestId: 43 })!;

      expect(action.type).toBe("response");
      expect(action.requestId).toBe(43);
      const result = action.result as { outcome: { outcome: string; optionId: string } };
      expect(result.outcome.outcome).toBe("selected");
      expect(result.outcome.optionId).toBe("reject-once");
    });

    it("uses custom deny optionId when provided", () => {
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "deny", optionId: "reject-always" },
      });
      const action = translateToAcp(msg)!;

      const result = action.result as { outcome: { optionId: string } };
      expect(result.outcome.optionId).toBe("reject-always");
    });
  });

  // ---------------------------------------------------------------------------
  // interrupt → session/cancel
  // ---------------------------------------------------------------------------

  describe("interrupt → session/cancel", () => {
    it("translates to cancel notification", () => {
      const msg = createUnifiedMessage({
        type: "interrupt",
        role: "user",
      });
      const action = translateToAcp(msg)!;

      expect(action.type).toBe("notification");
      expect(action.method).toBe("session/cancel");
    });
  });

  // ---------------------------------------------------------------------------
  // configuration_change → session/set_model or session/set_mode
  // ---------------------------------------------------------------------------

  describe("configuration_change → ACP request", () => {
    it("translates set_model", () => {
      const msg = createUnifiedMessage({
        type: "configuration_change",
        role: "user",
        metadata: { subtype: "set_model", model: "claude-opus-4-6" },
      });
      const action = translateToAcp(msg)!;

      expect(action.type).toBe("request");
      expect(action.method).toBe("session/set_model");
      expect((action.params as { model: string }).model).toBe("claude-opus-4-6");
    });

    it("translates set_mode", () => {
      const msg = createUnifiedMessage({
        type: "configuration_change",
        role: "user",
        metadata: { subtype: "set_mode", modeId: "architect" },
      });
      const action = translateToAcp(msg)!;

      expect(action.type).toBe("request");
      expect(action.method).toBe("session/set_mode");
      expect((action.params as { modeId: string }).modeId).toBe("architect");
    });

    it("translates set_permission_mode as set_mode", () => {
      const msg = createUnifiedMessage({
        type: "configuration_change",
        role: "user",
        metadata: { subtype: "set_permission_mode", mode: "plan" },
      });
      const action = translateToAcp(msg)!;

      expect(action.type).toBe("request");
      expect(action.method).toBe("session/set_mode");
      expect((action.params as { modeId: string }).modeId).toBe("plan");
    });
  });

  // ---------------------------------------------------------------------------
  // Unhandled types → null
  // ---------------------------------------------------------------------------

  describe("unhandled types → null", () => {
    it("returns null for assistant messages", () => {
      const msg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      });
      expect(translateToAcp(msg)).toBeNull();
    });

    it("returns null for result messages", () => {
      const msg = createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: { stopReason: "end_turn" },
      });
      expect(translateToAcp(msg)).toBeNull();
    });

    it("returns null for stream_event messages", () => {
      const msg = createUnifiedMessage({
        type: "stream_event",
        role: "assistant",
      });
      expect(translateToAcp(msg)).toBeNull();
    });
  });
});
