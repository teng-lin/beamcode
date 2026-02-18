import { describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import {
  createBridgeWithAdapter,
  type MockBackendSession,
  makeControlResponseUnifiedMsg,
  makeSessionInitMsg,
  tick,
} from "../testing/adapter-test-helpers.js";
import {
  authContext,
  createTestSocket as createMockSocket,
} from "../testing/cli-message-factories.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

function parseSent(socket: { sentMessages: string[] }): any[] {
  return socket.sentMessages.map((m) => JSON.parse(m));
}

/** Check whether the backend received a user_message with the given text content. */
function backendReceivedUserMessage(backendSession: MockBackendSession, text: string): boolean {
  return backendSession.sentMessages.some(
    (m) =>
      m.type === "user_message" &&
      m.content.some((c) => c.type === "text" && "text" in c && c.text === text),
  );
}

// ─── Integration Tests ────────────────────────────────────────────────────────

describe("Slash command integration", () => {
  describe("end-to-end: CLI reports skills → consumer invokes skill → forwarded to CLI", () => {
    it("full lifecycle: init with skills → capabilities_ready → invoke skill → CLI receives", async () => {
      const { bridge, adapter } = createBridgeWithAdapter();
      const consumerSocket = createMockSocket();

      // 1. Backend connects and sends init with skills
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      backendSession.pushMessage(
        makeSessionInitMsg({
          slash_commands: ["/compact", "/files"],
          skills: ["commit", "review-pr"],
        }),
      );
      await tick();

      // 2. Backend sends capabilities response
      backendSession.pushMessage(
        makeControlResponseUnifiedMsg({
          response: {
            commands: [
              { name: "/compact", description: "Compact conversation history" },
              { name: "/model", description: "Show or switch model", argumentHint: "[model]" },
            ],
            models: [{ value: "claude-sonnet-4-5-20250929", displayName: "Sonnet" }],
            account: null,
          },
        }),
      );
      await tick();

      // 3. Verify capabilities_ready includes skills
      const capMsg = parseSent(consumerSocket).find((m) => m.type === "capabilities_ready");
      expect(capMsg).toBeDefined();
      expect(capMsg.skills).toEqual(["commit", "review-pr"]);
      expect(capMsg.commands).toHaveLength(2);

      // 4. Consumer invokes /commit skill
      backendSession.sentMessages.length = 0;
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/commit" }),
      );

      // 5. Backend should receive a user_message with "/commit"
      expect(backendReceivedUserMessage(backendSession, "/commit")).toBe(true);
    });

    it("skill commands appear in /help output", async () => {
      const { bridge, adapter } = createBridgeWithAdapter();
      const consumerSocket = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg({ skills: ["commit", "tdd"] }));
      await tick();

      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/help" }),
      );

      await tick();

      const result = parseSent(consumerSocket).find((m) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.content).toContain("/commit");
      expect(result.content).toContain("/tdd");
      expect(result.source).toBe("emulated");
    });

    it("multiple skills can be invoked independently", async () => {
      const { bridge, adapter } = createBridgeWithAdapter();
      const consumerSocket = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg({ skills: ["commit", "review-pr"] }));
      await tick();

      backendSession.sentMessages.length = 0;

      // Invoke /commit
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/commit" }),
      );

      // Invoke /review-pr
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/review-pr" }),
      );

      expect(backendReceivedUserMessage(backendSession, "/commit")).toBe(true);
      expect(backendReceivedUserMessage(backendSession, "/review-pr")).toBe(true);
    });
  });

  describe("end-to-end: emulated commands still work with registry", () => {
    it("/status returns emulated result", async () => {
      const { bridge, adapter } = createBridgeWithAdapter();
      const consumerSocket = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      backendSession.pushMessage(
        makeSessionInitMsg({
          model: "claude-opus-4-6",
          skills: ["commit"],
        }),
      );
      await tick();

      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/status", request_id: "r1" }),
      );

      await tick();

      const result = parseSent(consumerSocket).find((m) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.source).toBe("emulated");
      expect(result.request_id).toBe("r1");
      expect(result.content).toContain("Model: claude-opus-4-6");
    });

    it("/model returns current model even when skills are registered", async () => {
      const { bridge, adapter } = createBridgeWithAdapter();
      const consumerSocket = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      backendSession.pushMessage(
        makeSessionInitMsg({
          model: "claude-sonnet-4-5-20250929",
          skills: ["commit"],
        }),
      );
      await tick();

      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/model" }),
      );

      await tick();

      const result = parseSent(consumerSocket).find((m) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.content).toBe("claude-sonnet-4-5-20250929");
      expect(result.source).toBe("emulated");
    });

    it.each([
      "/cost",
      "/context",
    ])("%s is forwarded to CLI as passthrough (not emulated)", async (command) => {
      const { bridge, adapter } = createBridgeWithAdapter();
      const consumerSocket = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      backendSession.pushMessage(
        makeSessionInitMsg({ slash_commands: ["/cost", "/context"], skills: ["commit"] }),
      );
      await tick();

      backendSession.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command }),
      );

      expect(backendReceivedUserMessage(backendSession, command)).toBe(true);

      // Should NOT produce a local slash_command_result (forwarded, not emulated)
      const consumerMsgs = parseSent(consumerSocket);
      expect(consumerMsgs.some((m) => m.type === "slash_command_result")).toBe(false);
    });
  });

  describe("end-to-end: unknown commands produce errors when PTY unavailable", () => {
    it("returns slash_command_error for unknown commands without PTY", async () => {
      // SessionBridge created with adapter but without commandRunner → no PTY fallback
      const { bridge, adapter } = createBridgeWithAdapter();
      const consumerSocket = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/custom-unknown", request_id: "r2" }),
      );

      await tick();

      const errorMsg = parseSent(consumerSocket).find((m) => m.type === "slash_command_error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.command).toBe("/custom-unknown");
      expect(errorMsg.request_id).toBe("r2");
      expect(errorMsg.error).toContain("Unknown slash command");
    });
  });

  describe("registry lifecycle across re-init", () => {
    it("skills from first init are cleared when CLI re-inits without them", async () => {
      const { bridge, adapter } = createBridgeWithAdapter();
      const consumerSocket = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      // First init with skills
      backendSession.pushMessage(makeSessionInitMsg({ skills: ["commit", "review-pr"] }));
      await tick();

      // Verify /commit is forwarded as skill
      backendSession.sentMessages.length = 0;
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/commit" }),
      );
      expect(backendReceivedUserMessage(backendSession, "/commit")).toBe(true);

      // Re-init without skills (simulates CLI restart)
      backendSession.pushMessage(makeSessionInitMsg({ skills: [] }));
      await tick();

      // Now /commit should no longer appear in /help
      consumerSocket.sentMessages.length = 0;
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/help" }),
      );

      await tick();

      const result = parseSent(consumerSocket).find((m) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.content).not.toContain("/commit");
      expect(result.content).not.toContain("/review-pr");
    });

    it("capabilities enrichment adds descriptions to registry commands", async () => {
      const { bridge, adapter } = createBridgeWithAdapter();
      const consumerSocket = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      backendSession.pushMessage(
        makeSessionInitMsg({
          slash_commands: ["/compact"],
          skills: ["commit"],
        }),
      );
      await tick();

      // Capabilities arrive with rich descriptions
      backendSession.pushMessage(
        makeControlResponseUnifiedMsg({
          response: {
            commands: [
              {
                name: "/compact",
                description: "Compact conversation history",
                argumentHint: "[strategy]",
              },
            ],
            models: [],
            account: null,
          },
        }),
      );
      await tick();

      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/help" }),
      );

      await tick();

      const result = parseSent(consumerSocket).find((m) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      // Capabilities descriptions should be in help
      expect(result.content).toContain("/compact");
      expect(result.content).toContain("Compact conversation history");
      // Skills should still appear
      expect(result.content).toContain("/commit");
    });
  });

  describe("dispatch priority", () => {
    it("emulated commands take priority over same-name CLI commands", async () => {
      const { bridge, adapter } = createBridgeWithAdapter();
      const consumerSocket = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      backendSession.pushMessage(
        makeSessionInitMsg({
          // /model is both emulatable AND in CLI's slash_commands
          slash_commands: ["/model", "/compact"],
        }),
      );
      await tick();

      consumerSocket.sentMessages.length = 0;
      backendSession.sentMessages.length = 0;

      // /model should be emulated, not forwarded to CLI
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/model" }),
      );

      await tick();

      // Consumer should get an emulated result
      const result = parseSent(consumerSocket).find((m) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.source).toBe("emulated");

      // Backend should NOT have received a user_message for /model
      expect(backendReceivedUserMessage(backendSession, "/model")).toBe(false);
    });

    it("native (CLI) commands are forwarded, not emulated", async () => {
      const { bridge, adapter } = createBridgeWithAdapter();
      const consumerSocket = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg({ slash_commands: ["/compact", "/files"] }));
      await tick();

      backendSession.sentMessages.length = 0;

      // /compact is a native command — should be forwarded to CLI
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/compact" }),
      );

      expect(backendReceivedUserMessage(backendSession, "/compact")).toBe(true);
    });

    it("skill commands are forwarded to CLI, not emulated", async () => {
      const { bridge, adapter } = createBridgeWithAdapter();
      const consumerSocket = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg({ skills: ["commit"] }));
      await tick();

      backendSession.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/commit" }),
      );

      expect(backendReceivedUserMessage(backendSession, "/commit")).toBe(true);
    });
  });
});
