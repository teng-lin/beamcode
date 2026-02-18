import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { MemoryStorage } from "../adapters/memory-storage.js";
import type { Authenticator, ConsumerIdentity } from "../interfaces/auth.js";
import {
  authContext,
  createTestSocket as createMockSocket,
  makeInitMsg,
  makeResultMsg,
  noopLogger,
  flushPromises as tick,
} from "../testing/cli-message-factories.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createBridge(options?: { storage?: MemoryStorage; authenticator?: Authenticator }) {
  const storage = options?.storage ?? new MemoryStorage();
  return {
    bridge: new SessionBridge({
      storage,
      authenticator: options?.authenticator,
      config: { port: 3456 },
      logger: noopLogger,
    }),
    storage,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — slash commands", () => {
  let bridge: SessionBridge;

  beforeEach(() => {
    const created = createBridge();
    bridge = created.bridge;
  });

  // ── slash_command routing ────────────────────────────────────────────

  describe("slash_command routing", () => {
    it("observers cannot send slash_command messages", () => {
      const authenticator: Authenticator = {
        async authenticate(): Promise<ConsumerIdentity> {
          return { userId: "obs-1", displayName: "Observer", role: "observer" };
        },
      };
      const { bridge } = createBridge({ authenticator });
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));

      // Wait for auth to complete
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          ws.sentMessages.length = 0;
          bridge.handleConsumerMessage(
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

    it("forwards native commands as user messages to CLI", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage(
        "sess-1",
        makeInitMsg({ slash_commands: ["/compact", "/files", "/release-notes"] }),
      );

      ws.sentMessages.length = 0;
      cliSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/compact" }),
      );

      // CLI should receive a user message with the command text
      const cliMsgs = cliSocket.sentMessages.map((m) => JSON.parse(m));
      expect(cliMsgs.some((m: any) => m.type === "user" && m.message.content === "/compact")).toBe(
        true,
      );
    });

    it("forwards /model command to CLI with pendingPassthrough", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg({ model: "claude-opus-4-6" }));

      cliSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/model", request_id: "req-1" }),
      );

      // CLI should receive a user message with the command text
      const cliMsgs = cliSocket.sentMessages.map((m) => JSON.parse(m));
      expect(cliMsgs.some((m: any) => m.type === "user" && m.message.content === "/model")).toBe(
        true,
      );
    });

    it("forwards unknown commands to CLI (no local error)", () => {
      const bridge = new SessionBridge({
        config: { port: 3456 },
        logger: noopLogger,
      });
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      cliSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/nonexistent", request_id: "req-2" }),
      );

      // CLI should receive a user message — the CLI will report unknown commands
      const cliMsgs = cliSocket.sentMessages.map((m) => JSON.parse(m));
      expect(
        cliMsgs.some((m: any) => m.type === "user" && m.message.content === "/nonexistent"),
      ).toBe(true);
    });

    it("echoes request_id in results for local commands", async () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      ws.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/help", request_id: "my-req" }),
      );

      await tick();

      const msgs = ws.sentMessages.map((m) => JSON.parse(m));
      const result = msgs.find((m: any) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.request_id).toBe("my-req");
    });

    it("emits slash_command:executed event for local commands", async () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      const events: any[] = [];
      bridge.on("slash_command:executed", (e) => events.push(e));

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/help" }),
      );

      await tick();

      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe("sess-1");
      expect(events[0].command).toBe("/help");
      expect(events[0].source).toBe("emulated");
    });

    it("stores cliSessionId from init message", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg({ session_id: "cli-abc" }));

      // Verify via programmatic API — executeSlashCommand uses the stored cliSessionId
      const snapshot = bridge.getSession("sess-1");
      expect(snapshot).toBeDefined();
    });

    it("stores modelUsage from result messages", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());
      bridge.handleCLIMessage(
        "sess-1",
        makeResultMsg({
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

      const snapshot = bridge.getSession("sess-1");
      expect(snapshot?.state.last_model_usage).toBeDefined();
      expect(snapshot?.state.last_duration_ms).toBe(3000);
      expect(snapshot?.state.last_duration_api_ms).toBe(2500);
    });

    it("programmatic executeSlashCommand returns emulated result for /help", async () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      const result = await bridge.executeSlashCommand("sess-1", "/help");
      expect(result).toBeDefined();
      expect(result!.content).toContain("Available commands:");
      expect(result!.source).toBe("emulated");
    });

    it("programmatic executeSlashCommand returns null for unknown sessions", async () => {
      const { bridge } = createBridge();
      const result = await bridge.executeSlashCommand("nonexistent", "/model");
      expect(result).toBeNull();
    });

    it("programmatic executeSlashCommand forwards native commands", async () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage(
        "sess-1",
        makeInitMsg({ slash_commands: ["/compact", "/files", "/release-notes"] }),
      );

      cliSocket.sentMessages.length = 0;

      const result = await bridge.executeSlashCommand("sess-1", "/compact");
      expect(result).toBeNull(); // native commands return null
      // But the command was forwarded
      const cliMsgs = cliSocket.sentMessages.map((m) => JSON.parse(m));
      expect(cliMsgs.some((m: any) => m.type === "user")).toBe(true);
    });
  });

  // ── SlashCommandRegistry integration ────────────────────────────────

  describe("SlashCommandRegistry integration", () => {
    it("populates registry when CLI reports slash_commands and skills in init", async () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage(
        "sess-1",
        makeInitMsg({
          slash_commands: ["/compact", "/vim"],
          skills: ["commit", "review-pr"],
        }),
      );

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

    it("forwards skill commands to CLI as user messages", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg({ skills: ["commit"] }));

      cliSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/commit" }),
      );

      // CLI should receive a user message with "/commit"
      const cliMsgs = cliSocket.sentMessages.map((m) => JSON.parse(m));
      expect(cliMsgs.some((m: any) => m.type === "user" && m.message.content === "/commit")).toBe(
        true,
      );
    });

    it("clearDynamic resets non-built-in commands on re-init", async () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));

      // First init with skills
      bridge.handleCLIMessage("sess-1", makeInitMsg({ skills: ["commit"] }));

      // Re-init without skills (simulates CLI reconnect)
      bridge.handleCLIMessage("sess-1", makeInitMsg({ skills: [] }));

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
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg({ skills: ["commit"] }));

      // Simulate capabilities response with rich metadata
      bridge.handleCLIMessage(
        "sess-1",
        JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "test-uuid",
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
          },
        }),
      );

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

  // ── passthrough command rendering ────────────────────────────────────

  describe("passthrough command rendering", () => {
    it("converts CLI user-echo into slash_command_result for passthrough commands", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      ws.sentMessages.length = 0;

      // Send passthrough command
      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/context", request_id: "req-ctx" }),
      );

      // Simulate CLI echoing back the user message with rendered output
      bridge.handleCLIMessage(
        "sess-1",
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content:
              "<local-command-stdout>## Context Usage\n\nModel: claude-opus-4-6\nTokens: 35k / 200k\n</local-command-stdout>",
          },
          parent_tool_use_id: null,
          session_id: "sess-1",
        }),
      );

      const msgs = ws.sentMessages.map((m) => JSON.parse(m));
      const result = msgs.find((m: any) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.command).toBe("/context");
      expect(result.request_id).toBe("req-ctx");
      expect(result.content).toContain("## Context Usage");
      expect(result.content).toContain("Tokens: 35k / 200k");
      expect(result.source).toBe("pty");
      // Should NOT contain the wrapper tags
      expect(result.content).not.toContain("<local-command-stdout>");
    });

    it("does not intercept user-echo when no passthrough is pending", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      ws.sentMessages.length = 0;

      // Send a user-echo without any pending passthrough
      bridge.handleCLIMessage(
        "sess-1",
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "hello" },
          parent_tool_use_id: null,
          session_id: "sess-1",
        }),
      );

      const msgs = ws.sentMessages.map((m) => JSON.parse(m));
      expect(msgs.find((m: any) => m.type === "slash_command_result")).toBeUndefined();
    });

    it("handles content as array of text blocks", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      // Send passthrough command
      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/cost" }),
      );

      ws.sentMessages.length = 0;

      // Simulate CLI echoing with content block array
      bridge.handleCLIMessage(
        "sess-1",
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "text", text: "<local-command-stdout>Cost: $0.50</local-command-stdout>" },
            ],
          },
          parent_tool_use_id: null,
          session_id: "sess-1",
        }),
      );

      const msgs = ws.sentMessages.map((m) => JSON.parse(m));
      const result = msgs.find((m: any) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.command).toBe("/cost");
      expect(result.content).toBe("Cost: $0.50");
    });

    it("clears pending passthrough after interception (one-shot)", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      // Send passthrough command
      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/context" }),
      );

      // First user echo — should be intercepted
      bridge.handleCLIMessage(
        "sess-1",
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "context output" },
          parent_tool_use_id: null,
        }),
      );

      ws.sentMessages.length = 0;

      // Second user echo — should NOT be intercepted (pending already cleared)
      bridge.handleCLIMessage(
        "sess-1",
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "regular message" },
          parent_tool_use_id: null,
        }),
      );

      const msgs = ws.sentMessages.map((m) => JSON.parse(m));
      expect(msgs.find((m: any) => m.type === "slash_command_result")).toBeUndefined();
    });

    it("sets pending passthrough for all forwarded commands (including /vim)", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg({ slash_commands: ["/compact", "/vim"] }));

      // Send /vim — now ALL forwarded commands get echo interception
      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/vim" }),
      );

      ws.sentMessages.length = 0;

      // User echo SHOULD be intercepted (all forwarded commands get pendingPassthrough)
      bridge.handleCLIMessage(
        "sess-1",
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "vim mode enabled" },
          parent_tool_use_id: null,
        }),
      );

      const msgs = ws.sentMessages.map((m) => JSON.parse(m));
      const result = msgs.find((m: any) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.command).toBe("/vim");
    });
  });
});
