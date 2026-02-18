import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  type MockBackendSession,
  makePermissionRequestUnifiedMsg,
  tick,
} from "../testing/adapter-test-helpers.js";
import type { SessionBridge } from "./session-bridge.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — Programmatic API", () => {
  let bridge: SessionBridge;
  let adapter: MockBackendAdapter;
  let backendSession: MockBackendSession;

  beforeEach(async () => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;

    // Connect backend (adapter path)
    await bridge.connectBackend("sess-1");
    backendSession = adapter.getSession("sess-1")!;
  });

  it("sendUserMessage sends unified user_message to backend", async () => {
    bridge.sendUserMessage("sess-1", "Hello world");

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("user_message");
    expect(msg.role).toBe("user");
    const textBlock = msg.content.find((b) => b.type === "text");
    expect(textBlock).toBeDefined();
    expect(textBlock!.type === "text" && textBlock!.text).toBe("Hello world");
  });

  it("sendUserMessage with images sends content block array", async () => {
    bridge.sendUserMessage("sess-1", "Describe this", {
      images: [{ media_type: "image/png", data: "base64data" }],
    });

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("user_message");
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0].type).toBe("image");
    expect(msg.content[1].type).toBe("text");
    expect(msg.content[1].type === "text" && msg.content[1].text).toBe("Describe this");
  });

  it("sendUserMessage adds message to history", async () => {
    bridge.sendUserMessage("sess-1", "Hello");

    const snapshot = bridge.getSession("sess-1")!;
    expect(snapshot.messageHistoryLength).toBe(1);
  });

  it("sendUserMessage with sessionIdOverride uses that session_id in the message", async () => {
    bridge.sendUserMessage("sess-1", "Hello", { sessionIdOverride: "override-id" });

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.metadata.session_id).toBe("override-id");
  });

  it("sendUserMessage is a no-op for nonexistent sessions", () => {
    expect(() => bridge.sendUserMessage("nonexistent", "hello")).not.toThrow();
  });

  it("sendPermissionResponse allows a pending permission", async () => {
    // Push a permission_request via the adapter path
    backendSession.pushMessage(makePermissionRequestUnifiedMsg());
    await tick();
    backendSession.sentMessages.length = 0;

    const resolvedHandler = vi.fn();
    bridge.on("permission:resolved", resolvedHandler);

    bridge.sendPermissionResponse("sess-1", "perm-req-1", "allow");

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("permission_response");
    expect(msg.metadata.behavior).toBe("allow");
    expect(resolvedHandler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      requestId: "perm-req-1",
      behavior: "allow",
    });
  });

  it("sendPermissionResponse denies a pending permission", async () => {
    backendSession.pushMessage(makePermissionRequestUnifiedMsg());
    await tick();
    backendSession.sentMessages.length = 0;

    bridge.sendPermissionResponse("sess-1", "perm-req-1", "deny", { message: "No thanks" });

    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("permission_response");
    expect(msg.metadata.behavior).toBe("deny");
    expect(msg.metadata.message).toBe("No thanks");
  });

  it("sendPermissionResponse with unknown request_id is a no-op (S4)", async () => {
    bridge.sendPermissionResponse("sess-1", "unknown-req", "allow");

    expect(backendSession.sentMessages).toHaveLength(0);
  });

  it("sendPermissionResponse is a no-op for nonexistent sessions", () => {
    expect(() => bridge.sendPermissionResponse("nonexistent", "req-1", "allow")).not.toThrow();
  });

  it("sendInterrupt sends interrupt unified message to backend", async () => {
    bridge.sendInterrupt("sess-1");

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("interrupt");
    expect(msg.role).toBe("user");
  });

  it("sendInterrupt is a no-op for nonexistent sessions", () => {
    expect(() => bridge.sendInterrupt("nonexistent")).not.toThrow();
  });

  it("sendSetModel sends configuration_change unified message to backend", async () => {
    bridge.sendSetModel("sess-1", "claude-opus-4-20250514");

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("configuration_change");
    expect(msg.metadata.subtype).toBe("set_model");
    expect(msg.metadata.model).toBe("claude-opus-4-20250514");
  });

  it("sendSetModel is a no-op for nonexistent sessions", () => {
    expect(() => bridge.sendSetModel("nonexistent", "model")).not.toThrow();
  });

  it("sendSetPermissionMode sends configuration_change unified message to backend", async () => {
    bridge.sendSetPermissionMode("sess-1", "plan");

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("configuration_change");
    expect(msg.metadata.subtype).toBe("set_permission_mode");
    expect(msg.metadata.mode).toBe("plan");
  });

  it("sendSetPermissionMode is a no-op for nonexistent sessions", () => {
    expect(() => bridge.sendSetPermissionMode("nonexistent", "plan")).not.toThrow();
  });
});
