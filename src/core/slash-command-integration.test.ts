import { describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { MemoryStorage } from "../adapters/memory-storage.js";
import type { AuthContext } from "../interfaces/auth.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockSocket(): WebSocketLike & {
  sentMessages: string[];
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const sentMessages: string[] = [];
  return {
    send: vi.fn((data: string) => sentMessages.push(data)),
    close: vi.fn(),
    sentMessages,
  };
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

function createBridge() {
  const storage = new MemoryStorage();
  return {
    bridge: new SessionBridge({
      storage,
      config: { port: 3456 },
      logger: noopLogger,
    }),
    storage,
  };
}

function authContext(sessionId: string): AuthContext {
  return { sessionId, transport: {} };
}

/** Flush microtask queue deterministically (no wall-clock dependency). */
const tick = () => new Promise<void>((r) => setTimeout(r, 10));

function makeInitMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cli-123",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/test",
    tools: ["Bash", "Read"],
    permissionMode: "default",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    output_style: "normal",
    uuid: "uuid-1",
    apiKeySource: "env",
    ...overrides,
  });
}

function makeControlResponse(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "test-uuid",
      response: {
        commands: [
          { name: "/compact", description: "Compact conversation history" },
          { name: "/model", description: "Show or switch model", argumentHint: "[model]" },
        ],
        models: [{ value: "claude-sonnet-4-5-20250929", displayName: "Sonnet" }],
        account: null,
        ...overrides,
      },
    },
  });
}

function parseSent(socket: { sentMessages: string[] }): any[] {
  return socket.sentMessages.map((m) => JSON.parse(m));
}

// ─── Integration Tests ────────────────────────────────────────────────────────

describe("Slash command integration", () => {
  describe("end-to-end: CLI reports skills → consumer invokes skill → forwarded to CLI", () => {
    it("full lifecycle: init with skills → capabilities_ready → invoke skill → CLI receives", async () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();

      // 1. CLI connects and sends init with skills
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      bridge.handleCLIMessage(
        "sess-1",
        makeInitMsg({
          slash_commands: ["/compact", "/files"],
          skills: ["commit", "review-pr"],
        }),
      );

      // 2. CLI sends capabilities response
      bridge.handleCLIMessage("sess-1", makeControlResponse());

      // 3. Verify capabilities_ready includes skills
      const capMsg = parseSent(consumerSocket).find((m) => m.type === "capabilities_ready");
      expect(capMsg).toBeDefined();
      expect(capMsg.skills).toEqual(["commit", "review-pr"]);
      expect(capMsg.commands).toHaveLength(2);

      // 4. Consumer invokes /commit skill
      cliSocket.sentMessages.length = 0;
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/commit" }),
      );

      // 5. CLI should receive a user message with "/commit"
      const cliMsgs = parseSent(cliSocket);
      expect(cliMsgs.some((m) => m.type === "user" && m.message.content === "/commit")).toBe(true);
    });

    it("skill commands appear in /help output", async () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg({ skills: ["commit", "tdd"] }));

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

    it("multiple skills can be invoked independently", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg({ skills: ["commit", "review-pr"] }));

      cliSocket.sentMessages.length = 0;

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

      const cliMsgs = parseSent(cliSocket);
      expect(cliMsgs.some((m) => m.type === "user" && m.message.content === "/commit")).toBe(true);
      expect(cliMsgs.some((m) => m.type === "user" && m.message.content === "/review-pr")).toBe(
        true,
      );
    });
  });

  describe("end-to-end: non-help commands are forwarded to CLI", () => {
    it("/status is forwarded to CLI (not emulated locally)", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      bridge.handleCLIMessage(
        "sess-1",
        makeInitMsg({
          model: "claude-opus-4-6",
          skills: ["commit"],
        }),
      );

      cliSocket.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/status", request_id: "r1" }),
      );

      // CLI should receive a user message with "/status"
      const cliMsgs = parseSent(cliSocket);
      expect(cliMsgs.some((m) => m.type === "user" && m.message.content === "/status")).toBe(true);

      // Consumer should NOT get a local emulated result
      const consumerMsgs = parseSent(consumerSocket);
      expect(consumerMsgs.some((m) => m.type === "slash_command_result")).toBe(false);
    });

    it("/model is forwarded to CLI (not emulated locally)", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      bridge.handleCLIMessage(
        "sess-1",
        makeInitMsg({
          model: "claude-sonnet-4-5-20250929",
          skills: ["commit"],
        }),
      );

      cliSocket.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/model" }),
      );

      // CLI should receive a user message with "/model"
      const cliMsgs = parseSent(cliSocket);
      expect(cliMsgs.some((m) => m.type === "user" && m.message.content === "/model")).toBe(true);

      // Consumer should NOT get a local emulated result
      const consumerMsgs = parseSent(consumerSocket);
      expect(consumerMsgs.some((m) => m.type === "slash_command_result")).toBe(false);
    });

    it.each([
      "/cost",
      "/context",
    ])("%s is forwarded to CLI as passthrough (not emulated)", (command) => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      bridge.handleCLIMessage(
        "sess-1",
        makeInitMsg({ slash_commands: ["/cost", "/context"], skills: ["commit"] }),
      );

      cliSocket.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command }),
      );

      const cliMsgs = parseSent(cliSocket);
      expect(cliMsgs.some((m) => m.type === "user" && m.message.content === command)).toBe(true);

      // Should NOT produce a local slash_command_result (forwarded, not emulated)
      const consumerMsgs = parseSent(consumerSocket);
      expect(consumerMsgs.some((m) => m.type === "slash_command_result")).toBe(false);
    });
  });

  describe("end-to-end: unknown commands are forwarded to CLI", () => {
    it("unknown commands are forwarded to CLI (not rejected locally)", () => {
      // SessionBridge created without commandRunner — doesn't matter, CLI handles routing
      const bridge = new SessionBridge({
        config: { port: 3456 },
        logger: noopLogger,
      });
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      cliSocket.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/custom-unknown", request_id: "r2" }),
      );

      // CLI should receive a user message with the unknown command
      const cliMsgs = parseSent(cliSocket);
      expect(
        cliMsgs.some((m) => m.type === "user" && m.message.content === "/custom-unknown"),
      ).toBe(true);

      // Consumer should NOT get a local slash_command_error
      const consumerMsgs = parseSent(consumerSocket);
      expect(consumerMsgs.some((m) => m.type === "slash_command_error")).toBe(false);
    });
  });

  describe("registry lifecycle across re-init", () => {
    it("skills from first init are cleared when CLI re-inits without them", async () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      // First init with skills
      bridge.handleCLIMessage("sess-1", makeInitMsg({ skills: ["commit", "review-pr"] }));

      // Verify /commit is forwarded as skill
      cliSocket.sentMessages.length = 0;
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/commit" }),
      );
      expect(
        parseSent(cliSocket).some((m) => m.type === "user" && m.message.content === "/commit"),
      ).toBe(true);

      // Re-init without skills (simulates CLI restart)
      bridge.handleCLIMessage("sess-1", makeInitMsg({ skills: [] }));

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
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      bridge.handleCLIMessage(
        "sess-1",
        makeInitMsg({
          slash_commands: ["/compact"],
          skills: ["commit"],
        }),
      );

      // Capabilities arrive with rich descriptions
      bridge.handleCLIMessage(
        "sess-1",
        makeControlResponse({
          commands: [
            {
              name: "/compact",
              description: "Compact conversation history",
              argumentHint: "[strategy]",
            },
          ],
        }),
      );

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
    it("all non-help commands are forwarded to CLI (no local emulation priority)", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      bridge.handleCLIMessage(
        "sess-1",
        makeInitMsg({
          // /model is in CLI's slash_commands — it gets forwarded
          slash_commands: ["/model", "/compact"],
        }),
      );

      consumerSocket.sentMessages.length = 0;
      cliSocket.sentMessages.length = 0;

      // /model should be forwarded to CLI, not emulated locally
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/model" }),
      );

      // CLI should receive a user message for /model
      const cliMsgs = parseSent(cliSocket);
      expect(cliMsgs.some((m) => m.type === "user" && m.message.content === "/model")).toBe(true);

      // Consumer should NOT get a local emulated result
      const consumerMsgs = parseSent(consumerSocket);
      expect(consumerMsgs.some((m) => m.type === "slash_command_result")).toBe(false);
    });

    it("native (CLI) commands are forwarded, not emulated", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg({ slash_commands: ["/compact", "/files"] }));

      cliSocket.sentMessages.length = 0;

      // /compact is a native command — should be forwarded to CLI
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/compact" }),
      );

      const cliMsgs = parseSent(cliSocket);
      expect(cliMsgs.some((m) => m.type === "user" && m.message.content === "/compact")).toBe(true);
    });

    it("skill commands are forwarded to CLI, not emulated", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg({ skills: ["commit"] }));

      cliSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/commit" }),
      );

      const cliMsgs = parseSent(cliSocket);
      expect(cliMsgs.some((m) => m.type === "user" && m.message.content === "/commit")).toBe(true);
    });
  });
});
