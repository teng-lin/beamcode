import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { MemoryStorage } from "../adapters/memory-storage.js";
import {
  authContext,
  createTestSocket as createMockSocket,
  makeInitMsg,
  noopLogger,
} from "../testing/cli-message-factories.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function makeControlResponse(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "test-uuid",
      response: {
        commands: [
          { name: "/help", description: "Show help", argumentHint: "[topic]" },
          { name: "/compact", description: "Compact context" },
        ],
        models: [
          {
            value: "claude-sonnet-4-5-20250929",
            displayName: "Claude Sonnet 4.5",
            description: "Fast",
          },
          { value: "claude-opus-4-5-20250514", displayName: "Claude Opus 4.5" },
        ],
        account: {
          email: "user@example.com",
          organization: "Acme Corp",
          subscriptionType: "pro",
        },
      },
      ...overrides,
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — capabilities", () => {
  let bridge: SessionBridge;

  beforeEach(() => {
    const created = createBridge();
    bridge = created.bridge;
  });

  describe("Initialize capabilities", () => {
    it("sends initialize request after system.init", () => {
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      // Should have sent session_init message + initialize control_request
      const sent = cliSocket.sentMessages.map((m) => JSON.parse(m));
      const initReq = sent.find(
        (m: any) => m.type === "control_request" && m.request?.subtype === "initialize",
      );
      expect(initReq).toBeDefined();
      expect(initReq.request_id).toBe("test-uuid");
    });

    it("handles successful control_response", () => {
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      consumerSocket.sentMessages.length = 0;

      const readyHandler = vi.fn();
      bridge.on("capabilities:ready", readyHandler);

      bridge.handleCLIMessage("sess-1", makeControlResponse());

      // State should be populated
      const snapshot = bridge.getSession("sess-1");
      expect(snapshot!.state.capabilities).toBeDefined();
      expect(snapshot!.state.capabilities!.commands).toHaveLength(2);
      expect(snapshot!.state.capabilities!.models).toHaveLength(2);
      expect(snapshot!.state.capabilities!.account).toEqual({
        email: "user@example.com",
        organization: "Acme Corp",
        subscriptionType: "pro",
      });

      // Consumer should receive capabilities_ready
      const consumerMsgs = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      const capMsg = consumerMsgs.find((m: any) => m.type === "capabilities_ready");
      expect(capMsg).toBeDefined();
      expect(capMsg.commands).toHaveLength(2);
      expect(capMsg.models).toHaveLength(2);

      // Event should be emitted
      expect(readyHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-1",
          commands: expect.arrayContaining([expect.objectContaining({ name: "/help" })]),
          models: expect.arrayContaining([
            expect.objectContaining({ value: "claude-sonnet-4-5-20250929" }),
          ]),
          account: expect.objectContaining({ email: "user@example.com" }),
        }),
      );
    });

    it("handles error control_response without crashing", () => {
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      const errorResponse = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: "test-uuid",
          error: "Not supported",
        },
      });

      // Should not throw
      expect(() => bridge.handleCLIMessage("sess-1", errorResponse)).not.toThrow();

      // Capabilities should remain undefined
      const snapshot = bridge.getSession("sess-1");
      expect(snapshot!.state.capabilities).toBeUndefined();
    });

    it("handles timeout gracefully", async () => {
      vi.useFakeTimers();
      const { bridge: timedBridge } = createBridge();

      const cliSocket = createMockSocket();
      timedBridge.handleCLIOpen(cliSocket, "sess-1");

      const timeoutHandler = vi.fn();
      timedBridge.on("capabilities:timeout", timeoutHandler);

      timedBridge.handleCLIMessage("sess-1", makeInitMsg());

      // Advance past the 5s timeout
      vi.advanceTimersByTime(5001);

      expect(timeoutHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });

      // Bridge should continue working normally
      const snapshot = timedBridge.getSession("sess-1");
      expect(snapshot).toBeDefined();
      expect(snapshot!.state.capabilities).toBeUndefined();

      timedBridge.close();
      vi.useRealTimers();
    });

    it("late-joining consumer receives capabilities_ready", () => {
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());
      bridge.handleCLIMessage("sess-1", makeControlResponse());

      // Now a new consumer joins
      const lateConsumer = createMockSocket();
      bridge.handleConsumerOpen(lateConsumer, authContext("sess-1"));

      const consumerMsgs = lateConsumer.sentMessages.map((m) => JSON.parse(m));
      const capMsg = consumerMsgs.find((m: any) => m.type === "capabilities_ready");
      expect(capMsg).toBeDefined();
      expect(capMsg.commands).toHaveLength(2);
      expect(capMsg.models).toHaveLength(2);
      expect(capMsg.account).toEqual({
        email: "user@example.com",
        organization: "Acme Corp",
        subscriptionType: "pro",
      });
    });

    it("capabilities_ready includes skills from session state", () => {
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg({ skills: ["commit", "review-pr"] }));

      consumerSocket.sentMessages.length = 0;
      bridge.handleCLIMessage("sess-1", makeControlResponse());

      const consumerMsgs = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      const capMsg = consumerMsgs.find((m: any) => m.type === "capabilities_ready");
      expect(capMsg).toBeDefined();
      expect(capMsg.skills).toEqual(["commit", "review-pr"]);
    });

    it("late-joining consumer receives skills in capabilities_ready", () => {
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg({ skills: ["commit"] }));
      bridge.handleCLIMessage("sess-1", makeControlResponse());

      const lateConsumer = createMockSocket();
      bridge.handleConsumerOpen(lateConsumer, authContext("sess-1"));

      const consumerMsgs = lateConsumer.sentMessages.map((m) => JSON.parse(m));
      const capMsg = consumerMsgs.find((m: any) => m.type === "capabilities_ready");
      expect(capMsg).toBeDefined();
      expect(capMsg.skills).toEqual(["commit"]);
    });

    it("CLI disconnect cancels pending initialize timer", () => {
      vi.useFakeTimers();
      const { bridge: timedBridge } = createBridge();

      const cliSocket = createMockSocket();
      timedBridge.handleCLIOpen(cliSocket, "sess-1");

      const timeoutHandler = vi.fn();
      timedBridge.on("capabilities:timeout", timeoutHandler);

      timedBridge.handleCLIMessage("sess-1", makeInitMsg());

      // Disconnect before timeout
      timedBridge.handleCLIClose("sess-1");

      // Advance past the timeout — should NOT fire
      vi.advanceTimersByTime(10000);

      expect(timeoutHandler).not.toHaveBeenCalled();

      timedBridge.close();
      vi.useRealTimers();
    });

    it("no duplicate initialize requests if system.init fires twice", () => {
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      // Fire init again
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      // Should NOT have sent another initialize request (dedup)
      const sent = cliSocket.sentMessages.map((m) => JSON.parse(m));
      const initReqs = sent.filter(
        (m: any) => m.type === "control_request" && m.request?.subtype === "initialize",
      );
      expect(initReqs).toHaveLength(1);
    });

    describe("accessor APIs with populated capabilities", () => {
      beforeEach(() => {
        const cliSocket = createMockSocket();
        bridge.handleCLIOpen(cliSocket, "sess-1");
        bridge.handleCLIMessage("sess-1", makeInitMsg());
        bridge.handleCLIMessage("sess-1", makeControlResponse());
      });

      it("getSupportedModels returns correct data", () => {
        const models = bridge.getSupportedModels("sess-1");
        expect(models).toHaveLength(2);
        expect(models[0]).toEqual({
          value: "claude-sonnet-4-5-20250929",
          displayName: "Claude Sonnet 4.5",
          description: "Fast",
        });
      });

      it("getSupportedCommands returns correct data", () => {
        const commands = bridge.getSupportedCommands("sess-1");
        expect(commands).toHaveLength(2);
        expect(commands[0]).toEqual({
          name: "/help",
          description: "Show help",
          argumentHint: "[topic]",
        });
      });

      it("getAccountInfo returns correct data", () => {
        const account = bridge.getAccountInfo("sess-1");
        expect(account).toEqual({
          email: "user@example.com",
          organization: "Acme Corp",
          subscriptionType: "pro",
        });
      });
    });

    it("getSupportedModels returns empty array when no capabilities", () => {
      bridge.getOrCreateSession("sess-1");
      expect(bridge.getSupportedModels("sess-1")).toEqual([]);
    });

    it("getSupportedCommands returns empty array when no capabilities", () => {
      bridge.getOrCreateSession("sess-1");
      expect(bridge.getSupportedCommands("sess-1")).toEqual([]);
    });

    it("getAccountInfo returns null when no capabilities", () => {
      bridge.getOrCreateSession("sess-1");
      expect(bridge.getAccountInfo("sess-1")).toBeNull();
    });

    it("returns empty/null for nonexistent sessions", () => {
      expect(bridge.getSupportedModels("nonexistent")).toEqual([]);
      expect(bridge.getSupportedCommands("nonexistent")).toEqual([]);
      expect(bridge.getAccountInfo("nonexistent")).toBeNull();
    });

    it("ignores control_response with unknown request_id", () => {
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      const readyHandler = vi.fn();
      bridge.on("capabilities:ready", readyHandler);

      const unknownResponse = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "unknown-id",
          response: { commands: [], models: [] },
        },
      });

      bridge.handleCLIMessage("sess-1", unknownResponse);

      expect(readyHandler).not.toHaveBeenCalled();
      expect(bridge.getSession("sess-1")!.state.capabilities).toBeUndefined();
    });

    it("handles control_response with empty response gracefully", () => {
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      const emptyResponse = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "test-uuid",
        },
      });

      expect(() => bridge.handleCLIMessage("sess-1", emptyResponse)).not.toThrow();
      expect(bridge.getSession("sess-1")!.state.capabilities).toBeUndefined();
    });

    it("closeSession cancels pending initialize timer", () => {
      vi.useFakeTimers();
      const { bridge: timedBridge } = createBridge();

      const cliSocket = createMockSocket();
      timedBridge.handleCLIOpen(cliSocket, "sess-1");

      const timeoutHandler = vi.fn();
      timedBridge.on("capabilities:timeout", timeoutHandler);

      timedBridge.handleCLIMessage("sess-1", makeInitMsg());

      timedBridge.closeSession("sess-1");

      vi.advanceTimersByTime(10000);

      expect(timeoutHandler).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("removeSession cancels pending initialize timer", () => {
      vi.useFakeTimers();
      const { bridge: timedBridge } = createBridge();

      const cliSocket = createMockSocket();
      timedBridge.handleCLIOpen(cliSocket, "sess-1");

      const timeoutHandler = vi.fn();
      timedBridge.on("capabilities:timeout", timeoutHandler);

      timedBridge.handleCLIMessage("sess-1", makeInitMsg());

      timedBridge.removeSession("sess-1");

      vi.advanceTimersByTime(10000);

      expect(timeoutHandler).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("handles partial capabilities (only commands, no models or account)", () => {
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      const partialResponse = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "test-uuid",
          response: {
            commands: [{ name: "/help", description: "Help" }],
          },
        },
      });

      bridge.handleCLIMessage("sess-1", partialResponse);

      const snapshot = bridge.getSession("sess-1");
      expect(snapshot!.state.capabilities).toBeDefined();
      expect(snapshot!.state.capabilities!.commands).toHaveLength(1);
      expect(snapshot!.state.capabilities!.models).toEqual([]);
      expect(snapshot!.state.capabilities!.account).toBeNull();
    });
  });
});
