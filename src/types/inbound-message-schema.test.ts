import { describe, expect, it } from "vitest";
import { inboundMessageSchema } from "./inbound-message-schema.js";

describe("inboundMessageSchema", () => {
  it("accepts valid user_message", () => {
    const result = inboundMessageSchema.safeParse({
      type: "user_message",
      content: "Hello",
    });
    expect(result.success).toBe(true);
  });

  it("accepts user_message with images", () => {
    const result = inboundMessageSchema.safeParse({
      type: "user_message",
      content: "Check this",
      images: [{ media_type: "image/png", data: "base64data" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects user_message without content", () => {
    const result = inboundMessageSchema.safeParse({
      type: "user_message",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid permission_response (allow)", () => {
    const result = inboundMessageSchema.safeParse({
      type: "permission_response",
      request_id: "req-1",
      behavior: "allow",
    });
    expect(result.success).toBe(true);
  });

  it("accepts permission_response with updated_permissions", () => {
    const result = inboundMessageSchema.safeParse({
      type: "permission_response",
      request_id: "req-1",
      behavior: "allow",
      updated_permissions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash" }],
          behavior: "allow",
          destination: "projectSettings",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects permission_response with invalid behavior", () => {
    const result = inboundMessageSchema.safeParse({
      type: "permission_response",
      request_id: "req-1",
      behavior: "maybe",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid interrupt", () => {
    expect(inboundMessageSchema.safeParse({ type: "interrupt" }).success).toBe(true);
  });

  it("accepts valid set_model", () => {
    expect(
      inboundMessageSchema.safeParse({ type: "set_model", model: "claude-opus-4-6" }).success,
    ).toBe(true);
  });

  it("rejects set_model without model field", () => {
    expect(inboundMessageSchema.safeParse({ type: "set_model" }).success).toBe(false);
  });

  it("accepts valid slash_command", () => {
    expect(
      inboundMessageSchema.safeParse({ type: "slash_command", command: "/help" }).success,
    ).toBe(true);
  });

  it("accepts slash_command with request_id", () => {
    expect(
      inboundMessageSchema.safeParse({
        type: "slash_command",
        command: "/status",
        request_id: "r1",
      }).success,
    ).toBe(true);
  });

  it("accepts valid queue_message", () => {
    expect(
      inboundMessageSchema.safeParse({ type: "queue_message", content: "Queued" }).success,
    ).toBe(true);
  });

  it("accepts cancel_queued_message", () => {
    expect(inboundMessageSchema.safeParse({ type: "cancel_queued_message" }).success).toBe(true);
  });

  it("rejects unknown message type", () => {
    expect(inboundMessageSchema.safeParse({ type: "unknown_type" }).success).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(inboundMessageSchema.safeParse("not an object").success).toBe(false);
  });

  it("rejects null", () => {
    expect(inboundMessageSchema.safeParse(null).success).toBe(false);
  });

  it("rejects object without type field", () => {
    expect(inboundMessageSchema.safeParse({ content: "hello" }).success).toBe(false);
  });
});
