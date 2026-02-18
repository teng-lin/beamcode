import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { MemoryStorage } from "../adapters/memory-storage.js";
import type { Authenticator, ConsumerIdentity } from "../interfaces/auth.js";
import {
  createBridgeWithAdapter,
  MockBackendAdapter,
  type MockBackendSession,
  makeControlResponseUnifiedMsg,
  makeResultUnifiedMsg,
  makeSessionInitMsg,
  noopLogger,
  tick,
} from "../testing/adapter-test-helpers.js";
import {
  authContext,
  createTestSocket as createMockSocket,
} from "../testing/cli-message-factories.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Check whether the backend received a user_message with the given text content. */
function backendReceivedUserMessage(backendSession: MockBackendSession, text: string): boolean {
  return backendSession.sentMessages.some(
    (m) =>
      m.type === "user_message" &&
      m.content.some((c) => c.type === "text" && "text" in c && c.text === text),
  );
}

/**
 * Create a bridge with adapter AND a custom authenticator.
 * Needed for the observer access-control test.
 */
function createBridgeWithAuth(authenticator: Authenticator) {
  const storage = new MemoryStorage();
  const adapter = new MockBackendAdapter();
  const bridge = new SessionBridge({
    storage,
    authenticator,
    config: { port: 3456 },
    logger: noopLogger,
    adapter,
  });
  return { bridge, storage, adapter };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — slash commands", () => {
  let bridge: SessionBridge;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  // ── slash_command routing ────────────────────────────────────────────

  describe("slash_command routing", () => {
    it("observers cannot send slash_command messages", async () => {
      const authenticator: Authenticator = {
        async authenticate(): Promise<ConsumerIdentity> {
          return { userId: "obs-1", displayName: "Observer", role: "observer" };
        },
      };
      const { bridge: authBridge } = createBridgeWithAuth(authenticator);
      const ws = createMockSocket();

      await authBridge.connectBackend("sess-1");
      authBridge.handleConsumerOpen(ws, authContext("sess-1"));

      // Wait for auth to complete
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          ws.sentMessages.length = 0;
          authBridge.handleConsumerMessage(
            ws,
            "sess-1",
            JSON.stringify({ type: "slash_command", command: "/model" }),
          );
          const msgs = ws.sentMessages.map((m) => JSON.parse(m));
          expect(msgs.some((m: any) => m.type === "error")).toBe(true);
          resolve();
        }, 50);
      });
    });

    it("forwards native commands as user messages to CLI", async () => {
      const consumerSocket = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      backendSession.pushMessage(
        makeSessionInitMsg({ slash_commands: ["/compact", "/files", "/release-notes"] }),
      );
      await tick();

      consumerSocket.sentMessages.length = 0;
      backendSession.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/compact" }),
      );

      // Backend should receive a user_message with the command text
      expect(backendReceivedUserMessage(backendSession, "/compact")).toBe(true);
    });

    it("emulates /model command and broadcasts result", async () => {
      const ws = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg({ model: "claude-opus-4-6" }));
      await tick();

      ws.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/model", request_id: "req-1" }),
      );

      // Wait for async execution
      await tick();

      const msgs = ws.sentMessages.map((m) => JSON.parse(m));
      const result = msgs.find((m: any) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.command).toBe("/model");
      expect(result.request_id).toBe("req-1");
      expect(result.content).toBe("claude-opus-4-6");
      expect(result.source).toBe("emulated");
    });

    it("broadcasts error for unknown commands", async () => {
      // Bridge with adapter but without commandRunner → no PTY fallback
      const { bridge: noPtyBridge, adapter: noPtyAdapter } = createBridgeWithAdapter();
      const ws = createMockSocket();

      await noPtyBridge.connectBackend("sess-1");
      const backendSession = noPtyAdapter.getSession("sess-1")!;
      noPtyBridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      ws.sentMessages.length = 0;

      noPtyBridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/nonexistent", request_id: "req-2" }),
      );

      // Wait for async execution
      await tick();

      const msgs = ws.sentMessages.map((m) => JSON.parse(m));
      const errorMsg = msgs.find((m: any) => m.type === "slash_command_error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.command).toBe("/nonexistent");
      expect(errorMsg.request_id).toBe("req-2");
      expect(errorMsg.error).toContain("Unknown slash command");
    });

    it("echoes request_id in results", async () => {
      const ws = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      ws.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/status", request_id: "my-req" }),
      );

      await tick();

      const msgs = ws.sentMessages.map((m) => JSON.parse(m));
      const result = msgs.find((m: any) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.request_id).toBe("my-req");
    });

    it("emits slash_command:executed event", async () => {
      const ws = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const events: any[] = [];
      bridge.on("slash_command:executed", (e) => events.push(e));

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/model" }),
      );

      await tick();

      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe("sess-1");
      expect(events[0].command).toBe("/model");
      expect(events[0].source).toBe("emulated");
    });

    it("stores cliSessionId from init message", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg({ session_id: "cli-abc" }));
      await tick();

      // Verify via programmatic API — executeSlashCommand uses the stored cliSessionId
      const snapshot = bridge.getSession("sess-1");
      expect(snapshot).toBeDefined();
    });

    it("stores modelUsage from result messages", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();
      backendSession.pushMessage(
        makeResultUnifiedMsg({
          modelUsage: {
            "claude-sonnet-4-5-20250929": {
              inputTokens: 1000,
              outputTokens: 500,
              cacheReadInputTokens: 200,
              cacheCreationInputTokens: 100,
              contextWindow: 200000,
              costUSD: 0.05,
            },
          },
          duration_ms: 3000,
          duration_api_ms: 2500,
        }),
      );
      await tick();

      const snapshot = bridge.getSession("sess-1");
      expect(snapshot?.state.last_model_usage).toBeDefined();
      expect(snapshot?.state.last_duration_ms).toBe(3000);
      expect(snapshot?.state.last_duration_api_ms).toBe(2500);
    });

    it("programmatic executeSlashCommand returns emulated result", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg({ model: "claude-opus-4-6" }));
      await tick();

      const result = await bridge.executeSlashCommand("sess-1", "/model");
      expect(result).toBeDefined();
      expect(result!.content).toBe("claude-opus-4-6");
      expect(result!.source).toBe("emulated");
    });

    it("programmatic executeSlashCommand returns null for unknown sessions", async () => {
      const result = await bridge.executeSlashCommand("nonexistent", "/model");
      expect(result).toBeNull();
    });

    it("programmatic executeSlashCommand forwards native commands", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(
        makeSessionInitMsg({ slash_commands: ["/compact", "/files", "/release-notes"] }),
      );
      await tick();

      backendSession.sentMessages.length = 0;

      const result = await bridge.executeSlashCommand("sess-1", "/compact");
      expect(result).toBeNull(); // native commands return null
      // But the command was forwarded
      expect(backendReceivedUserMessage(backendSession, "/compact")).toBe(true);
    });
  });

  // ── SlashCommandRegistry integration ────────────────────────────────

  describe("SlashCommandRegistry integration", () => {
    it("populates registry when CLI reports slash_commands and skills in init", async () => {
      const ws = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.pushMessage(
        makeSessionInitMsg({
          slash_commands: ["/compact", "/vim"],
          skills: ["commit", "review-pr"],
        }),
      );
      await tick();

      ws.sentMessages.length = 0;

      // Execute /help — should include CLI commands and skills from registry
      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/help" }),
      );

      await tick();

      const msgs = ws.sentMessages.map((m) => JSON.parse(m));
      const result = msgs.find((m: any) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.content).toContain("/commit");
      expect(result.content).toContain("/review-pr");
    });

    it("forwards skill commands to CLI as user messages", async () => {
      const ws = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg({ skills: ["commit"] }));
      await tick();

      backendSession.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/commit" }),
      );

      // Backend should receive a user_message with "/commit"
      expect(backendReceivedUserMessage(backendSession, "/commit")).toBe(true);
    });

    it("clearDynamic resets non-built-in commands on re-init", async () => {
      const ws = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(ws, authContext("sess-1"));

      // First init with skills
      backendSession.pushMessage(makeSessionInitMsg({ skills: ["commit"] }));
      await tick();

      // Re-init without skills (simulates CLI reconnect)
      backendSession.pushMessage(makeSessionInitMsg({ skills: [] }));
      await tick();

      ws.sentMessages.length = 0;

      // /commit should no longer appear in /help
      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/help" }),
      );

      await tick();

      const msgs = ws.sentMessages.map((m) => JSON.parse(m));
      const result = msgs.find((m: any) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.content).not.toContain("/commit");
    });

    it("enriches registry from capabilities commands", async () => {
      const ws = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg({ skills: ["commit"] }));
      await tick();

      // Simulate capabilities response with rich metadata
      backendSession.pushMessage(
        makeControlResponseUnifiedMsg({
          response: {
            commands: [
              {
                name: "/compact",
                description: "Compact conversation",
                argumentHint: "[strategy]",
              },
              { name: "/vim", description: "Toggle vim mode" },
            ],
            models: [],
            account: null,
          },
        }),
      );
      await tick();

      ws.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/help" }),
      );

      await tick();

      const msgs = ws.sentMessages.map((m) => JSON.parse(m));
      const result = msgs.find((m: any) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      // Should have capabilities descriptions AND skill commands
      expect(result.content).toContain("/compact");
      expect(result.content).toContain("/commit");
    });
  });

  // ── passthrough command forwarding ──────────────────────────────────
  //
  // Passthrough commands (/cost, /context) are forwarded to the backend
  // as user messages. The bridge sets pendingPassthrough state so that
  // the CLI user-echo can be intercepted and converted to a
  // slash_command_result. In the adapter path, we verify the forwarding
  // behavior; the echo-interception is tested via the CLI message path
  // in session-bridge-passthrough.test.ts.

  describe("passthrough command forwarding", () => {
    it("forwards /context to backend as a user_message", async () => {
      const ws = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      backendSession.sentMessages.length = 0;
      ws.sentMessages.length = 0;

      // Send passthrough command
      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/context", request_id: "req-ctx" }),
      );

      // Backend should receive the command as a user_message
      expect(backendReceivedUserMessage(backendSession, "/context")).toBe(true);

      // Consumer should NOT receive a local slash_command_result (forwarded, not emulated)
      const consumerMsgs = ws.sentMessages.map((m) => JSON.parse(m));
      expect(consumerMsgs.some((m: any) => m.type === "slash_command_result")).toBe(false);
    });

    it("forwards /cost to backend as a user_message", async () => {
      const ws = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      backendSession.sentMessages.length = 0;

      // Send passthrough command
      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/cost" }),
      );

      expect(backendReceivedUserMessage(backendSession, "/cost")).toBe(true);
    });

    it("native commands are forwarded without passthrough interception", async () => {
      const ws = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg({ slash_commands: ["/compact", "/vim"] }));
      await tick();

      backendSession.sentMessages.length = 0;
      ws.sentMessages.length = 0;

      // Send native command /vim (not passthrough — it's a regular CLI command)
      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/vim" }),
      );

      // Command should be forwarded
      expect(backendReceivedUserMessage(backendSession, "/vim")).toBe(true);

      // Consumer should NOT receive a slash_command_result (forwarded to backend)
      const consumerMsgs = ws.sentMessages.map((m) => JSON.parse(m));
      expect(consumerMsgs.some((m: any) => m.type === "slash_command_result")).toBe(false);
    });
  });
});
