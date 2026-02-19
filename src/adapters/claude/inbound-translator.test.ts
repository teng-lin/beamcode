import { describe, expect, it } from "vitest";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { InboundMessage } from "../../types/inbound-messages.js";
import { normalizeInbound, toNDJSON } from "./inbound-translator.js";

// ---------------------------------------------------------------------------
// normalizeInbound
// ---------------------------------------------------------------------------

describe("normalizeInbound", () => {
  describe("user_message → user_message", () => {
    it("normalizes plain text message", () => {
      const msg: InboundMessage = { type: "user_message", content: "Hello" };
      const result = normalizeInbound(msg)!;

      expect(result.type).toBe("user_message");
      expect(result.role).toBe("user");
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({ type: "text", text: "Hello" });
    });

    it("normalizes message with images", () => {
      const msg: InboundMessage = {
        type: "user_message",
        content: "Check this",
        images: [{ media_type: "image/png", data: "base64data" }],
      };
      const result = normalizeInbound(msg)!;

      expect(result.content).toHaveLength(2);
      expect(result.content[0].type).toBe("image");
      expect(result.content[1]).toEqual({ type: "text", text: "Check this" });
    });

    it("includes session_id in metadata when provided", () => {
      const msg: InboundMessage = {
        type: "user_message",
        content: "Hello",
        session_id: "sess-override",
      };
      const result = normalizeInbound(msg)!;
      expect(result.metadata.session_id).toBe("sess-override");
    });

    it("handles empty content", () => {
      const msg: InboundMessage = { type: "user_message", content: "" };
      const result = normalizeInbound(msg)!;
      expect(result.content[0]).toEqual({ type: "text", text: "" });
    });

    it("handles special characters in content", () => {
      const msg: InboundMessage = {
        type: "user_message",
        content: 'Line1\nLine2\t"quoted"\\escaped',
      };
      const result = normalizeInbound(msg)!;
      expect(result.content[0]).toEqual({
        type: "text",
        text: 'Line1\nLine2\t"quoted"\\escaped',
      });
    });
  });

  describe("permission_response → permission_response", () => {
    it("normalizes allow response", () => {
      const msg: InboundMessage = {
        type: "permission_response",
        request_id: "req-1",
        behavior: "allow",
        updated_input: { file_path: "/new/path" },
      };
      const result = normalizeInbound(msg)!;

      expect(result.type).toBe("permission_response");
      expect(result.role).toBe("user");
      expect(result.metadata.request_id).toBe("req-1");
      expect(result.metadata.behavior).toBe("allow");
      expect(result.metadata.updated_input).toEqual({ file_path: "/new/path" });
    });

    it("normalizes deny response with message", () => {
      const msg: InboundMessage = {
        type: "permission_response",
        request_id: "req-2",
        behavior: "deny",
        message: "Not safe",
      };
      const result = normalizeInbound(msg)!;

      expect(result.metadata.behavior).toBe("deny");
      expect(result.metadata.message).toBe("Not safe");
    });

    it("includes updated_permissions when present", () => {
      const msg: InboundMessage = {
        type: "permission_response",
        request_id: "req-3",
        behavior: "allow",
        updated_permissions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash" }],
            behavior: "allow",
            destination: "session",
          },
        ],
      };
      const result = normalizeInbound(msg)!;
      expect(result.metadata.updated_permissions).toHaveLength(1);
    });
  });

  describe("interrupt → interrupt", () => {
    it("normalizes interrupt", () => {
      const msg: InboundMessage = { type: "interrupt" };
      const result = normalizeInbound(msg)!;

      expect(result.type).toBe("interrupt");
      expect(result.role).toBe("user");
      expect(result.content).toEqual([]);
    });
  });

  describe("set_model → configuration_change", () => {
    it("normalizes set_model", () => {
      const msg: InboundMessage = { type: "set_model", model: "claude-opus-4-6" };
      const result = normalizeInbound(msg)!;

      expect(result.type).toBe("configuration_change");
      expect(result.role).toBe("user");
      expect(result.metadata.subtype).toBe("set_model");
      expect(result.metadata.model).toBe("claude-opus-4-6");
    });
  });

  describe("set_permission_mode → configuration_change", () => {
    it("normalizes set_permission_mode", () => {
      const msg: InboundMessage = { type: "set_permission_mode", mode: "plan" };
      const result = normalizeInbound(msg)!;

      expect(result.type).toBe("configuration_change");
      expect(result.role).toBe("user");
      expect(result.metadata.subtype).toBe("set_permission_mode");
      expect(result.metadata.mode).toBe("plan");
    });
  });

  describe("bridge-only messages → null", () => {
    it("returns null for presence_query", () => {
      const msg: InboundMessage = { type: "presence_query" };
      expect(normalizeInbound(msg)).toBeNull();
    });

    it("returns null for slash_command", () => {
      const msg: InboundMessage = { type: "slash_command", command: "/help" };
      expect(normalizeInbound(msg)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// toNDJSON
// ---------------------------------------------------------------------------

describe("toNDJSON", () => {
  describe("user_message → CLI user NDJSON", () => {
    it("produces correct NDJSON for plain text", () => {
      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
        metadata: { session_id: "sess-1" },
      });

      const ndjson = toNDJSON(msg)!;
      const parsed = JSON.parse(ndjson);

      expect(parsed.type).toBe("user");
      expect(parsed.message.role).toBe("user");
      expect(parsed.message.content).toBe("Hello");
      expect(parsed.parent_tool_use_id).toBeNull();
      expect(parsed.session_id).toBe("sess-1");
    });

    it("produces content blocks array when images present", () => {
      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
          { type: "text", text: "Look at this" },
        ],
        metadata: {},
      });

      const ndjson = toNDJSON(msg)!;
      const parsed = JSON.parse(ndjson);

      expect(Array.isArray(parsed.message.content)).toBe(true);
      expect(parsed.message.content).toHaveLength(2);
      expect(parsed.message.content[0].type).toBe("image");
      expect(parsed.message.content[0].source.data).toBe("abc123");
      expect(parsed.message.content[1].type).toBe("text");
      expect(parsed.message.content[1].text).toBe("Look at this");
    });

    it("defaults session_id to empty string when not provided", () => {
      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "Hi" }],
        metadata: {},
      });

      const ndjson = toNDJSON(msg)!;
      const parsed = JSON.parse(ndjson);
      expect(parsed.session_id).toBe("");
    });
  });

  describe("permission_response → CLI control_response NDJSON", () => {
    it("produces allow response with updatedInput", () => {
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: {
          request_id: "req-1",
          behavior: "allow",
          updated_input: { file_path: "/a.ts" },
        },
      });

      const ndjson = toNDJSON(msg)!;
      const parsed = JSON.parse(ndjson);

      expect(parsed.type).toBe("control_response");
      expect(parsed.response.subtype).toBe("success");
      expect(parsed.response.request_id).toBe("req-1");
      expect(parsed.response.response.behavior).toBe("allow");
      expect(parsed.response.response.updatedInput).toEqual({ file_path: "/a.ts" });
    });

    it("produces allow response with empty updatedInput when not provided", () => {
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: {
          request_id: "req-2",
          behavior: "allow",
        },
      });

      const ndjson = toNDJSON(msg)!;
      const parsed = JSON.parse(ndjson);
      expect(parsed.response.response.updatedInput).toEqual({});
    });

    it("produces allow response with updatedPermissions", () => {
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: {
          request_id: "req-3",
          behavior: "allow",
          updated_permissions: [{ type: "addRules", rules: [] }],
        },
      });

      const ndjson = toNDJSON(msg)!;
      const parsed = JSON.parse(ndjson);
      expect(parsed.response.response.updatedPermissions).toHaveLength(1);
    });

    it("produces deny response with message", () => {
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: {
          request_id: "req-4",
          behavior: "deny",
          message: "Not safe",
        },
      });

      const ndjson = toNDJSON(msg)!;
      const parsed = JSON.parse(ndjson);
      expect(parsed.response.response.behavior).toBe("deny");
      expect(parsed.response.response.message).toBe("Not safe");
    });

    it("defaults deny message to 'Denied by user'", () => {
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: {
          request_id: "req-5",
          behavior: "deny",
        },
      });

      const ndjson = toNDJSON(msg)!;
      const parsed = JSON.parse(ndjson);
      expect(parsed.response.response.message).toBe("Denied by user");
    });
  });

  describe("interrupt → CLI control_request NDJSON", () => {
    it("produces interrupt control_request", () => {
      const msg = createUnifiedMessage({
        type: "interrupt",
        role: "user",
      });

      const ndjson = toNDJSON(msg)!;
      const parsed = JSON.parse(ndjson);

      expect(parsed.type).toBe("control_request");
      expect(parsed.request.subtype).toBe("interrupt");
      expect(parsed.request_id).toBeTruthy();
    });
  });

  describe("configuration_change → CLI control_request NDJSON", () => {
    it("produces set_model control_request", () => {
      const msg = createUnifiedMessage({
        type: "configuration_change",
        role: "user",
        metadata: { subtype: "set_model", model: "claude-opus-4-6" },
      });

      const ndjson = toNDJSON(msg)!;
      const parsed = JSON.parse(ndjson);

      expect(parsed.type).toBe("control_request");
      expect(parsed.request.subtype).toBe("set_model");
      expect(parsed.request.model).toBe("claude-opus-4-6");
      expect(parsed.request_id).toBeTruthy();
    });

    it("produces set_permission_mode control_request", () => {
      const msg = createUnifiedMessage({
        type: "configuration_change",
        role: "user",
        metadata: { subtype: "set_permission_mode", mode: "plan" },
      });

      const ndjson = toNDJSON(msg)!;
      const parsed = JSON.parse(ndjson);

      expect(parsed.type).toBe("control_request");
      expect(parsed.request.subtype).toBe("set_permission_mode");
      expect(parsed.request.mode).toBe("plan");
    });
  });

  describe("unhandled types → null", () => {
    it("returns null for assistant messages", () => {
      const msg = createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      });
      expect(toNDJSON(msg)).toBeNull();
    });

    it("returns null for result messages", () => {
      const msg = createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: { total_cost_usd: 0 },
      });
      expect(toNDJSON(msg)).toBeNull();
    });
  });

  describe("roundtrip: InboundMessage → UnifiedMessage → NDJSON", () => {
    it("user_message roundtrip produces correct CLI format", () => {
      const inbound: InboundMessage = { type: "user_message", content: "Hello world" };
      const unified = normalizeInbound(inbound)!;
      const ndjson = toNDJSON(unified)!;
      const parsed = JSON.parse(ndjson);

      expect(parsed.type).toBe("user");
      expect(parsed.message.content).toBe("Hello world");
    });

    it("user_message with images roundtrip preserves image data", () => {
      const inbound: InboundMessage = {
        type: "user_message",
        content: "See image",
        images: [{ media_type: "image/jpeg", data: "jpeg-data-here" }],
      };
      const unified = normalizeInbound(inbound)!;
      const ndjson = toNDJSON(unified)!;
      const parsed = JSON.parse(ndjson);

      expect(Array.isArray(parsed.message.content)).toBe(true);
      expect(parsed.message.content[0].source.data).toBe("jpeg-data-here");
    });

    it("permission allow roundtrip", () => {
      const inbound: InboundMessage = {
        type: "permission_response",
        request_id: "req-rt",
        behavior: "allow",
        updated_input: { command: "ls" },
      };
      const unified = normalizeInbound(inbound)!;
      const ndjson = toNDJSON(unified)!;
      const parsed = JSON.parse(ndjson);

      expect(parsed.response.response.behavior).toBe("allow");
      expect(parsed.response.response.updatedInput).toEqual({ command: "ls" });
    });

    it("permission deny roundtrip", () => {
      const inbound: InboundMessage = {
        type: "permission_response",
        request_id: "req-rt2",
        behavior: "deny",
        message: "Too dangerous",
      };
      const unified = normalizeInbound(inbound)!;
      const ndjson = toNDJSON(unified)!;
      const parsed = JSON.parse(ndjson);

      expect(parsed.response.response.behavior).toBe("deny");
      expect(parsed.response.response.message).toBe("Too dangerous");
    });

    it("set_model roundtrip", () => {
      const inbound: InboundMessage = { type: "set_model", model: "claude-haiku-4-5-20251001" };
      const unified = normalizeInbound(inbound)!;
      const ndjson = toNDJSON(unified)!;
      const parsed = JSON.parse(ndjson);

      expect(parsed.request.subtype).toBe("set_model");
      expect(parsed.request.model).toBe("claude-haiku-4-5-20251001");
    });
  });
});
