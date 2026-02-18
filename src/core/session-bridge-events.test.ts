import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  type MockBackendSession,
  makeAssistantUnifiedMsg,
  makeAuthStatusUnifiedMsg,
  makePermissionRequestUnifiedMsg,
  makeResultUnifiedMsg,
  makeSessionInitMsg,
  makeStreamEventUnifiedMsg,
  tick,
} from "../testing/adapter-test-helpers.js";
import {
  authContext,
  createTestSocket as createMockSocket,
} from "../testing/cli-message-factories.js";
import type { SessionBridge } from "./session-bridge.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — Event emission", () => {
  let bridge: SessionBridge;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  it("emits cli:session_id on system init", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    const handler = vi.fn();
    bridge.on("cli:session_id", handler);

    backendSession.pushMessage(makeSessionInitMsg({ session_id: "cli-xyz" }));
    await tick();

    expect(handler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      cliSessionId: "cli-xyz",
    });
  });

  it("emits cli:connected on connectBackend", async () => {
    const handler = vi.fn();
    bridge.on("cli:connected", handler);

    await bridge.connectBackend("sess-1");
    expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("emits cli:disconnected on disconnectBackend", async () => {
    await bridge.connectBackend("sess-1");

    const handler = vi.fn();
    bridge.on("cli:disconnected", handler);

    await bridge.disconnectBackend("sess-1");
    expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("emits cli:relaunch_needed when consumer opens and CLI is dead", () => {
    bridge.getOrCreateSession("sess-1");
    const handler = vi.fn();
    bridge.on("cli:relaunch_needed", handler);

    bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
    expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("does not emit cli:relaunch_needed when CLI is connected", async () => {
    await bridge.connectBackend("sess-1");

    const handler = vi.fn();
    bridge.on("cli:relaunch_needed", handler);

    bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("emits consumer:connected with correct count", async () => {
    await bridge.connectBackend("sess-1");

    const handler = vi.fn();
    bridge.on("consumer:connected", handler);

    bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", consumerCount: 1 }),
    );

    bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", consumerCount: 2 }),
    );
  });

  it("emits consumer:disconnected with correct count", () => {
    bridge.getOrCreateSession("sess-1");
    const ws1 = createMockSocket();
    const ws2 = createMockSocket();
    bridge.handleConsumerOpen(ws1, authContext("sess-1"));
    bridge.handleConsumerOpen(ws2, authContext("sess-1"));

    const handler = vi.fn();
    bridge.on("consumer:disconnected", handler);

    bridge.handleConsumerClose(ws1, "sess-1");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", consumerCount: 1 }),
    );

    bridge.handleConsumerClose(ws2, "sess-1");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", consumerCount: 0 }),
    );
  });

  it("emits message:outbound for every consumer broadcast", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;
    bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));

    const handler = vi.fn();
    bridge.on("message:outbound", handler);

    backendSession.pushMessage(makeAssistantUnifiedMsg());
    await tick();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        message: expect.objectContaining({ type: "assistant" }),
      }),
    );
  });

  it("emits message:inbound for every consumer message", async () => {
    await bridge.connectBackend("sess-1");
    const ws = createMockSocket();
    bridge.handleConsumerOpen(ws, authContext("sess-1"));

    const handler = vi.fn();
    bridge.on("message:inbound", handler);

    bridge.handleConsumerMessage(ws, "sess-1", JSON.stringify({ type: "interrupt" }));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        message: { type: "interrupt" },
      }),
    );
  });

  it("emits permission:requested on permission_request", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    const handler = vi.fn();
    bridge.on("permission:requested", handler);

    backendSession.pushMessage(makePermissionRequestUnifiedMsg());
    await tick();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        request: expect.objectContaining({
          request_id: "perm-req-1",
          tool_name: "Bash",
        }),
      }),
    );
  });

  it("emits permission:resolved when permission response is sent", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    backendSession.pushMessage(makePermissionRequestUnifiedMsg());
    await tick();

    const handler = vi.fn();
    bridge.on("permission:resolved", handler);

    bridge.sendPermissionResponse("sess-1", "perm-req-1", "deny");

    expect(handler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      requestId: "perm-req-1",
      behavior: "deny",
    });
  });

  it("emits session:first_turn_completed on successful first turn", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;
    bridge.sendUserMessage("sess-1", "Explain monads");

    const handler = vi.fn();
    bridge.on("session:first_turn_completed", handler);

    backendSession.pushMessage(makeResultUnifiedMsg({ num_turns: 1, is_error: false }));
    await tick();

    expect(handler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      firstUserMessage: "Explain monads",
    });
  });

  it("emits session:closed on closeSession", () => {
    bridge.getOrCreateSession("sess-1");
    const handler = vi.fn();
    bridge.on("session:closed", handler);

    bridge.closeSession("sess-1");
    expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("emits auth_status on auth_status message", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    const handler = vi.fn();
    bridge.on("auth_status", handler);

    backendSession.pushMessage(
      makeAuthStatusUnifiedMsg({ isAuthenticating: false, error: "Auth failed" }),
    );
    await tick();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        isAuthenticating: false,
        error: "Auth failed",
      }),
    );
  });

  it("emits error when sendToBackend fails", async () => {
    await bridge.connectBackend("sess-1");
    const backendSession = adapter.getSession("sess-1")!;

    // Make the backend session's send throw
    backendSession.send = () => {
      throw new Error("Backend write failed");
    };

    const handler = vi.fn();
    bridge.on("error", handler);

    // Use sendToBackend which routes through BackendLifecycleManager (try/catch + error emit)
    bridge.sendToBackend("sess-1", makeAssistantUnifiedMsg());

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "sendToBackend",
        error: expect.any(Error),
        sessionId: "sess-1",
      }),
    );
  });
});
