import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import type { MockBackendSession } from "../testing/adapter-test-helpers.js";
import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  makeControlResponseUnifiedMsg,
  makeSessionInitMsg,
  tick,
} from "../testing/adapter-test-helpers.js";
import {
  authContext,
  createTestSocket as createMockSocket,
} from "../testing/cli-message-factories.js";
import type { SessionBridge } from "./session-bridge.js";
import { createUnifiedMessage } from "./types/unified-message.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Full control_response matching the original test data (2 commands, 2 models, full account). */
function makeFullControlResponse(overrides: Record<string, unknown> = {}) {
  return makeControlResponseUnifiedMsg({
    request_id: "test-uuid",
    subtype: "success",
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
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — capabilities", () => {
  let bridge: SessionBridge;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  afterEach(() => {
    // Ensure fake timers are always restored even if a test assertion fails
    vi.useRealTimers();
  });

  describe("Initialize capabilities", () => {
    it("sends initialize request after session_init", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      // Should have sent initialize control_request via sendRaw
      const sent = backendSession.sentRawMessages.map((m) => JSON.parse(m));
      const initReq = sent.find(
        (m: any) => m.type === "control_request" && m.request?.subtype === "initialize",
      );
      expect(initReq).toBeDefined();
      expect(initReq.request_id).toBe("test-uuid");
    });

    it("handles successful control_response", async () => {
      const consumerSocket = createMockSocket();
      bridge.getOrCreateSession("sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      consumerSocket.sentMessages.length = 0;

      const readyHandler = vi.fn();
      bridge.on("capabilities:ready", readyHandler);

      backendSession.pushMessage(makeFullControlResponse());
      await tick();

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

    it("handles error control_response without crashing", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const errorResponse = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "error",
          request_id: "test-uuid",
          error: "Not supported",
        },
      });

      // Should not throw
      backendSession.pushMessage(errorResponse);
      await tick();

      // Capabilities should remain undefined
      const snapshot = bridge.getSession("sess-1");
      expect(snapshot!.state.capabilities).toBeUndefined();
    });

    it("handles timeout gracefully", async () => {
      vi.useFakeTimers();
      const { bridge: timedBridge, adapter: timedAdapter } = createBridgeWithAdapter();

      await timedBridge.connectBackend("sess-1");
      const backendSession = timedAdapter.getSession("sess-1")!;

      const timeoutHandler = vi.fn();
      timedBridge.on("capabilities:timeout", timeoutHandler);

      backendSession.pushMessage(makeSessionInitMsg());
      await vi.advanceTimersByTimeAsync(20); // flush async message loop

      // Advance past the 5s timeout
      vi.advanceTimersByTime(5001);

      expect(timeoutHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });

      // Bridge should continue working normally
      const snapshot = timedBridge.getSession("sess-1");
      expect(snapshot).toBeDefined();
      expect(snapshot!.state.capabilities).toBeUndefined();

      timedBridge.close();
    });

    it("late-joining consumer receives capabilities_ready", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();
      backendSession.pushMessage(makeFullControlResponse());
      await tick();

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

    it("capabilities_ready includes skills from session state", async () => {
      const consumerSocket = createMockSocket();
      bridge.getOrCreateSession("sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg({ skills: ["commit", "review-pr"] }));
      await tick();

      consumerSocket.sentMessages.length = 0;
      backendSession.pushMessage(makeFullControlResponse());
      await tick();

      const consumerMsgs = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      const capMsg = consumerMsgs.find((m: any) => m.type === "capabilities_ready");
      expect(capMsg).toBeDefined();
      expect(capMsg.skills).toEqual(["commit", "review-pr"]);
    });

    it("late-joining consumer receives skills in capabilities_ready", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg({ skills: ["commit"] }));
      await tick();
      backendSession.pushMessage(makeFullControlResponse());
      await tick();

      const lateConsumer = createMockSocket();
      bridge.handleConsumerOpen(lateConsumer, authContext("sess-1"));

      const consumerMsgs = lateConsumer.sentMessages.map((m) => JSON.parse(m));
      const capMsg = consumerMsgs.find((m: any) => m.type === "capabilities_ready");
      expect(capMsg).toBeDefined();
      expect(capMsg.skills).toEqual(["commit"]);
    });

    it("backend disconnect cancels pending initialize timer", async () => {
      vi.useFakeTimers();
      const { bridge: timedBridge, adapter: timedAdapter } = createBridgeWithAdapter();

      await timedBridge.connectBackend("sess-1");
      const backendSession = timedAdapter.getSession("sess-1")!;

      const timeoutHandler = vi.fn();
      timedBridge.on("capabilities:timeout", timeoutHandler);

      backendSession.pushMessage(makeSessionInitMsg());
      await vi.advanceTimersByTimeAsync(20); // flush async message loop

      // Disconnect before timeout
      await timedBridge.disconnectBackend("sess-1");

      // Advance past the timeout — should NOT fire
      vi.advanceTimersByTime(10000);

      expect(timeoutHandler).not.toHaveBeenCalled();

      timedBridge.close();
    });

    it("no duplicate initialize requests if session_init fires twice", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      // Fire init again
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      // Should NOT have sent another initialize request (dedup)
      const sent = backendSession.sentRawMessages.map((m) => JSON.parse(m));
      const initReqs = sent.filter(
        (m: any) => m.type === "control_request" && m.request?.subtype === "initialize",
      );
      expect(initReqs).toHaveLength(1);
    });

    describe("accessor APIs with populated capabilities", () => {
      let backendSession: MockBackendSession;

      beforeEach(async () => {
        await bridge.connectBackend("sess-1");
        backendSession = adapter.getSession("sess-1")!;
        backendSession.pushMessage(makeSessionInitMsg());
        await tick();
        backendSession.pushMessage(makeFullControlResponse());
        await tick();
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

    it("ignores control_response with unknown request_id", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const readyHandler = vi.fn();
      bridge.on("capabilities:ready", readyHandler);

      const unknownResponse = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: "unknown-id",
          response: { commands: [], models: [] },
        },
      });

      backendSession.pushMessage(unknownResponse);
      await tick();

      expect(readyHandler).not.toHaveBeenCalled();
      expect(bridge.getSession("sess-1")!.state.capabilities).toBeUndefined();
    });

    it("handles control_response with empty response gracefully", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const emptyResponse = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: "test-uuid",
        },
      });

      backendSession.pushMessage(emptyResponse);
      await tick();

      // Should not throw — verified by reaching here
      expect(bridge.getSession("sess-1")!.state.capabilities).toBeUndefined();
    });

    it("closeSession cancels pending initialize timer", async () => {
      vi.useFakeTimers();
      const { bridge: timedBridge, adapter: timedAdapter } = createBridgeWithAdapter();

      await timedBridge.connectBackend("sess-1");
      const backendSession = timedAdapter.getSession("sess-1")!;

      const timeoutHandler = vi.fn();
      timedBridge.on("capabilities:timeout", timeoutHandler);

      backendSession.pushMessage(makeSessionInitMsg());
      await vi.advanceTimersByTimeAsync(20); // flush async message loop

      timedBridge.closeSession("sess-1");

      vi.advanceTimersByTime(10000);

      expect(timeoutHandler).not.toHaveBeenCalled();
    });

    it("removeSession cancels pending initialize timer", async () => {
      vi.useFakeTimers();
      const { bridge: timedBridge, adapter: timedAdapter } = createBridgeWithAdapter();

      await timedBridge.connectBackend("sess-1");
      const backendSession = timedAdapter.getSession("sess-1")!;

      const timeoutHandler = vi.fn();
      timedBridge.on("capabilities:timeout", timeoutHandler);

      backendSession.pushMessage(makeSessionInitMsg());
      await vi.advanceTimersByTimeAsync(20); // flush async message loop

      timedBridge.removeSession("sess-1");

      vi.advanceTimersByTime(10000);

      expect(timeoutHandler).not.toHaveBeenCalled();
    });

    it("handles partial capabilities (only commands, no models or account)", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const partialResponse = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: "test-uuid",
          response: {
            commands: [{ name: "/help", description: "Help" }],
          },
        },
      });

      backendSession.pushMessage(partialResponse);
      await tick();

      const snapshot = bridge.getSession("sess-1");
      expect(snapshot!.state.capabilities).toBeDefined();
      expect(snapshot!.state.capabilities!.commands).toHaveLength(1);
      expect(snapshot!.state.capabilities!.models).toEqual([]);
      expect(snapshot!.state.capabilities!.account).toBeNull();
    });
  });
});
