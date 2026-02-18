import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import {
  authContext,
  createTestSocket as createMockSocket,
  makeControlRequestMsg,
  noopLogger,
} from "../testing/cli-message-factories.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createBridge() {
  return new SessionBridge({
    config: { port: 3456 },
    logger: noopLogger,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — Programmatic API", () => {
  let bridge: SessionBridge;

  beforeEach(() => {
    bridge = createBridge();
  });

  it("sendUserMessage sends NDJSON user message to CLI", () => {
    bridge.getOrCreateSession("sess-1");
    const cliSocket = createMockSocket();
    bridge.handleCLIOpen(cliSocket, "sess-1");
    cliSocket.sentMessages.length = 0;

    bridge.sendUserMessage("sess-1", "Hello world");

    expect(cliSocket.sentMessages).toHaveLength(1);
    const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    expect(parsed.message.content).toBe("Hello world");
  });

  it("sendUserMessage with images sends content block array", () => {
    bridge.getOrCreateSession("sess-1");
    const cliSocket = createMockSocket();
    bridge.handleCLIOpen(cliSocket, "sess-1");
    cliSocket.sentMessages.length = 0;

    bridge.sendUserMessage("sess-1", "Describe this", {
      images: [{ media_type: "image/png", data: "base64data" }],
    });

    const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
    expect(Array.isArray(parsed.message.content)).toBe(true);
    expect(parsed.message.content).toHaveLength(2);
    expect(parsed.message.content[0].type).toBe("image");
    expect(parsed.message.content[1].type).toBe("text");
    expect(parsed.message.content[1].text).toBe("Describe this");
  });

  it("sendUserMessage adds message to history", () => {
    bridge.getOrCreateSession("sess-1");
    const cliSocket = createMockSocket();
    bridge.handleCLIOpen(cliSocket, "sess-1");

    bridge.sendUserMessage("sess-1", "Hello");

    const snapshot = bridge.getSession("sess-1")!;
    expect(snapshot.messageHistoryLength).toBe(1);
  });

  it("sendUserMessage with sessionIdOverride uses that session_id in the message", () => {
    bridge.getOrCreateSession("sess-1");
    const cliSocket = createMockSocket();
    bridge.handleCLIOpen(cliSocket, "sess-1");
    cliSocket.sentMessages.length = 0;

    bridge.sendUserMessage("sess-1", "Hello", { sessionIdOverride: "override-id" });

    const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
    expect(parsed.session_id).toBe("override-id");
  });

  it("sendUserMessage is a no-op for nonexistent sessions", () => {
    expect(() => bridge.sendUserMessage("nonexistent", "hello")).not.toThrow();
  });

  it("sendPermissionResponse allows a pending permission", () => {
    bridge.getOrCreateSession("sess-1");
    const cliSocket = createMockSocket();
    bridge.handleCLIOpen(cliSocket, "sess-1");

    bridge.handleCLIMessage("sess-1", makeControlRequestMsg());
    cliSocket.sentMessages.length = 0;

    const resolvedHandler = vi.fn();
    bridge.on("permission:resolved", resolvedHandler);

    bridge.sendPermissionResponse("sess-1", "perm-req-1", "allow");

    expect(cliSocket.sentMessages).toHaveLength(1);
    const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
    expect(parsed.type).toBe("control_response");
    expect(parsed.response.response.behavior).toBe("allow");
    expect(resolvedHandler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      requestId: "perm-req-1",
      behavior: "allow",
    });
  });

  it("sendPermissionResponse denies a pending permission", () => {
    bridge.getOrCreateSession("sess-1");
    const cliSocket = createMockSocket();
    bridge.handleCLIOpen(cliSocket, "sess-1");

    bridge.handleCLIMessage("sess-1", makeControlRequestMsg());
    cliSocket.sentMessages.length = 0;

    bridge.sendPermissionResponse("sess-1", "perm-req-1", "deny", { message: "No thanks" });

    const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
    expect(parsed.response.response.behavior).toBe("deny");
    expect(parsed.response.response.message).toBe("No thanks");
  });

  it("sendPermissionResponse with unknown request_id is a no-op (S4)", () => {
    bridge.getOrCreateSession("sess-1");
    const cliSocket = createMockSocket();
    bridge.handleCLIOpen(cliSocket, "sess-1");
    cliSocket.sentMessages.length = 0;

    bridge.sendPermissionResponse("sess-1", "unknown-req", "allow");

    expect(cliSocket.sentMessages).toHaveLength(0);
  });

  it("sendPermissionResponse is a no-op for nonexistent sessions", () => {
    expect(() => bridge.sendPermissionResponse("nonexistent", "req-1", "allow")).not.toThrow();
  });

  it("sendInterrupt sends interrupt control request to CLI", () => {
    bridge.getOrCreateSession("sess-1");
    const cliSocket = createMockSocket();
    bridge.handleCLIOpen(cliSocket, "sess-1");
    cliSocket.sentMessages.length = 0;

    bridge.sendInterrupt("sess-1");

    const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
    expect(parsed.type).toBe("control_request");
    expect(parsed.request.subtype).toBe("interrupt");
    expect(parsed.request_id).toBe("test-uuid");
  });

  it("sendInterrupt is a no-op for nonexistent sessions", () => {
    expect(() => bridge.sendInterrupt("nonexistent")).not.toThrow();
  });

  it("sendSetModel sends set_model control request to CLI", () => {
    bridge.getOrCreateSession("sess-1");
    const cliSocket = createMockSocket();
    bridge.handleCLIOpen(cliSocket, "sess-1");
    cliSocket.sentMessages.length = 0;

    bridge.sendSetModel("sess-1", "claude-opus-4-20250514");

    const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
    expect(parsed.type).toBe("control_request");
    expect(parsed.request.subtype).toBe("set_model");
    expect(parsed.request.model).toBe("claude-opus-4-20250514");
  });

  it("sendSetModel is a no-op for nonexistent sessions", () => {
    expect(() => bridge.sendSetModel("nonexistent", "model")).not.toThrow();
  });

  it("sendSetPermissionMode sends set_permission_mode to CLI", () => {
    bridge.getOrCreateSession("sess-1");
    const cliSocket = createMockSocket();
    bridge.handleCLIOpen(cliSocket, "sess-1");
    cliSocket.sentMessages.length = 0;

    bridge.sendSetPermissionMode("sess-1", "plan");

    const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
    expect(parsed.type).toBe("control_request");
    expect(parsed.request.subtype).toBe("set_permission_mode");
    expect(parsed.request.mode).toBe("plan");
  });

  it("sendSetPermissionMode is a no-op for nonexistent sessions", () => {
    expect(() => bridge.sendSetPermissionMode("nonexistent", "plan")).not.toThrow();
  });
});
