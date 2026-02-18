import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import {
  authContext,
  createTestSocket as createMockSocket,
  makeAssistantMsg,
  makeAuthStatusMsg,
  makeControlRequestMsg,
  makeInitMsg,
  makeResultMsg,
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

describe("SessionBridge — Event emission", () => {
  let bridge: SessionBridge;

  beforeEach(() => {
    bridge = createBridge();
  });

  it("emits cli:session_id on system init", () => {
    bridge.getOrCreateSession("sess-1");
    const cliSocket = createMockSocket();
    bridge.handleCLIOpen(cliSocket, "sess-1");

    const handler = vi.fn();
    bridge.on("cli:session_id", handler);

    bridge.handleCLIMessage("sess-1", makeInitMsg({ session_id: "cli-xyz" }));

    expect(handler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      cliSessionId: "cli-xyz",
    });
  });

  it("emits cli:connected on handleCLIOpen", () => {
    bridge.getOrCreateSession("sess-1");
    const handler = vi.fn();
    bridge.on("cli:connected", handler);

    bridge.handleCLIOpen(createMockSocket(), "sess-1");
    expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("emits cli:disconnected on handleCLIClose", () => {
    bridge.getOrCreateSession("sess-1");
    bridge.handleCLIOpen(createMockSocket(), "sess-1");

    const handler = vi.fn();
    bridge.on("cli:disconnected", handler);

    bridge.handleCLIClose("sess-1");
    expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("emits cli:relaunch_needed when consumer opens and CLI is dead", () => {
    bridge.getOrCreateSession("sess-1");
    const handler = vi.fn();
    bridge.on("cli:relaunch_needed", handler);

    bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
    expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("does not emit cli:relaunch_needed when CLI is connected", () => {
    bridge.getOrCreateSession("sess-1");
    bridge.handleCLIOpen(createMockSocket(), "sess-1");

    const handler = vi.fn();
    bridge.on("cli:relaunch_needed", handler);

    bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("emits consumer:connected with correct count", () => {
    bridge.getOrCreateSession("sess-1");
    bridge.handleCLIOpen(createMockSocket(), "sess-1");

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

  it("emits message:outbound for every consumer broadcast", () => {
    bridge.getOrCreateSession("sess-1");
    const cliSocket = createMockSocket();
    bridge.handleCLIOpen(cliSocket, "sess-1");
    bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));

    const handler = vi.fn();
    bridge.on("message:outbound", handler);

    bridge.handleCLIMessage("sess-1", makeAssistantMsg());

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        message: expect.objectContaining({ type: "assistant" }),
      }),
    );
  });

  it("emits message:inbound for every consumer message", () => {
    bridge.getOrCreateSession("sess-1");
    bridge.handleCLIOpen(createMockSocket(), "sess-1");
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

  it("emits permission:requested on control_request", () => {
    bridge.getOrCreateSession("sess-1");
    bridge.handleCLIOpen(createMockSocket(), "sess-1");

    const handler = vi.fn();
    bridge.on("permission:requested", handler);

    bridge.handleCLIMessage("sess-1", makeControlRequestMsg());

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

  it("emits permission:resolved when permission response is sent", () => {
    bridge.getOrCreateSession("sess-1");
    bridge.handleCLIOpen(createMockSocket(), "sess-1");
    bridge.handleCLIMessage("sess-1", makeControlRequestMsg());

    const handler = vi.fn();
    bridge.on("permission:resolved", handler);

    bridge.sendPermissionResponse("sess-1", "perm-req-1", "deny");

    expect(handler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      requestId: "perm-req-1",
      behavior: "deny",
    });
  });

  it("emits session:first_turn_completed on successful first turn", () => {
    bridge.getOrCreateSession("sess-1");
    bridge.handleCLIOpen(createMockSocket(), "sess-1");
    bridge.sendUserMessage("sess-1", "Explain monads");

    const handler = vi.fn();
    bridge.on("session:first_turn_completed", handler);

    bridge.handleCLIMessage("sess-1", makeResultMsg({ num_turns: 1, is_error: false }));

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

  it("emits auth_status on auth_status CLI message", () => {
    bridge.getOrCreateSession("sess-1");
    bridge.handleCLIOpen(createMockSocket(), "sess-1");

    const handler = vi.fn();
    bridge.on("auth_status", handler);

    bridge.handleCLIMessage(
      "sess-1",
      makeAuthStatusMsg({ isAuthenticating: false, error: "Auth failed" }),
    );

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        isAuthenticating: false,
        error: "Auth failed",
      }),
    );
  });

  it("emits error when sendToCLI fails", () => {
    bridge.getOrCreateSession("sess-1");
    const failSocket = createMockSocket();
    failSocket.send = vi.fn(() => {
      throw new Error("Socket write failed");
    });
    bridge.handleCLIOpen(failSocket, "sess-1");

    const handler = vi.fn();
    bridge.on("error", handler);

    bridge.sendInterrupt("sess-1");

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "sendToCLI",
        error: expect.any(Error),
        sessionId: "sess-1",
      }),
    );
  });
});
