import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { MemoryStorage } from "../adapters/memory-storage.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import {
  createBridgeWithAdapter,
  ErrorBackendAdapter,
  MockBackendAdapter,
  type MockBackendSession,
  makeControlResponseUnifiedMsg,
  makeResultUnifiedMsg,
  makeSessionInitMsg,
  makeStatusChangeMsg,
  makeStreamEventUnifiedMsg,
  noopLogger,
  PassthroughBackendAdapter,
  setupInitializedSession,
  tick,
} from "../testing/adapter-test-helpers.js";
import {
  authContext,
  createTestSocket as createMockSocket,
  findMessage,
} from "../testing/cli-message-factories.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Local Helpers ────────────────────────────────────────────────────────────

/**
 * A mock socket using vi.fn() so tests can mutate sentMessages.length = 0.
 */
function createViMockSocket(): WebSocketLike & {
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

/** Check whether the backend received a user_message with the given text content. */
function backendReceivedUserMessage(backendSession: MockBackendSession, text: string): boolean {
  return backendSession.sentMessages.some(
    (m) =>
      m.type === "user_message" &&
      m.content.some((c) => c.type === "text" && "text" in c && c.text === text),
  );
}

/** Set up a session via the adapter path with a consumer connected. */
async function setupSessionWithConsumer(bridge: SessionBridge, adapter: MockBackendAdapter) {
  const backendSession = await setupInitializedSession(bridge, adapter, "sess-1");

  const consumerSocket = createMockSocket();
  bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
  consumerSocket.sentMessages.length = 0;

  return { backendSession, consumerSocket };
}

/** Simulate a status change coming from the backend. */
async function simulateStatusChange(backendSession: MockBackendSession, status: string | null) {
  backendSession.pushMessage(makeStatusChangeMsg({ status }));
  await tick();
}

/** Simulate the backend starting a response (stream_event message_start). */
async function simulateMessageStart(backendSession: MockBackendSession) {
  backendSession.pushMessage(
    makeStreamEventUnifiedMsg({
      event: { type: "message_start" },
      parent_tool_use_id: null,
    }),
  );
  await tick();
}

/** Simulate the backend completing a turn (result message). */
async function simulateResult(backendSession: MockBackendSession) {
  backendSession.pushMessage(makeResultUnifiedMsg());
  await tick();
}

/** Full control_response matching original capabilities test data. */
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

describe("SessionBridge — delegation integration", () => {
  // ── Backend stream error handling ───────────────────────────────────

  describe("backend stream error handling", () => {
    it("emits error on stream error", async () => {
      const errorAdapter = new ErrorBackendAdapter();
      const { bridge: errorBridge } = createBridgeWithAdapter({ adapter: errorAdapter });

      const errorHandler = vi.fn();
      errorBridge.on("error", errorHandler);

      await errorBridge.connectBackend("sess-1");
      await tick(50);

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "backendConsumption",
          sessionId: "sess-1",
        }),
      );
    });
  });

  // ── Passthrough echo interception ───────────────────────────────────

  describe("passthrough echo interception", () => {
    it("converts passthrough user-echo into slash_command_result", async () => {
      const storage = new MemoryStorage();
      const passthroughAdapter = new PassthroughBackendAdapter();
      const passthroughBridge = new SessionBridge({
        storage,
        config: { port: 3456 },
        logger: noopLogger,
        adapter: passthroughAdapter,
      });
      const consumer = createViMockSocket();

      await passthroughBridge.connectBackend("sess-p");
      const backendSession = passthroughAdapter.getSession("sess-p")!;
      passthroughBridge.handleConsumerOpen(consumer, authContext("sess-p"));
      consumer.sentMessages.length = 0;

      passthroughBridge.handleConsumerMessage(
        consumer,
        "sess-p",
        JSON.stringify({ type: "slash_command", command: "/context", request_id: "req-ctx" }),
      );

      expect(
        backendSession.sentMessages.some(
          (m) =>
            m.type === "user_message" &&
            m.content.some((b) => b.type === "text" && "text" in b && b.text === "/context"),
        ),
      ).toBe(true);

      backendSession.emitUserEcho("Context: 23% used");
      await tick();

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const result = msgs.find((m: { type: string }) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.command).toBe("/context");
      expect(result.request_id).toBe("req-ctx");
      expect(result.source).toBe("cli");
      expect(result.content).toContain("Context");
    });
  });

  // ── Capabilities timeout and late-joiner ────────────────────────────

  describe("capabilities timeout and late-joiner", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("handles timeout gracefully", async () => {
      vi.useFakeTimers();
      const { bridge: timedBridge, adapter: timedAdapter } = createBridgeWithAdapter();

      await timedBridge.connectBackend("sess-1");
      const backendSession = timedAdapter.getSession("sess-1")!;

      const timeoutHandler = vi.fn();
      timedBridge.on("capabilities:timeout", timeoutHandler);

      backendSession.pushMessage(makeSessionInitMsg());
      await vi.advanceTimersByTimeAsync(20);

      vi.advanceTimersByTime(5001);

      expect(timeoutHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });

      const snapshot = timedBridge.getSession("sess-1");
      expect(snapshot).toBeDefined();
      expect(snapshot!.state.capabilities).toBeUndefined();

      timedBridge.close();
    });

    it("late-joining consumer receives capabilities_ready", async () => {
      const { bridge, adapter } = createBridgeWithAdapter();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();
      backendSession.pushMessage(makeFullControlResponse());
      await tick();

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

    it("late-joining consumer receives skills in capabilities_ready", async () => {
      const { bridge, adapter } = createBridgeWithAdapter();

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
      await vi.advanceTimersByTimeAsync(20);

      await timedBridge.disconnectBackend("sess-1");

      vi.advanceTimersByTime(10000);

      expect(timeoutHandler).not.toHaveBeenCalled();

      timedBridge.close();
    });

    it("closeSession cancels pending initialize timer", async () => {
      vi.useFakeTimers();
      const { bridge: timedBridge, adapter: timedAdapter } = createBridgeWithAdapter();

      await timedBridge.connectBackend("sess-1");
      const backendSession = timedAdapter.getSession("sess-1")!;

      const timeoutHandler = vi.fn();
      timedBridge.on("capabilities:timeout", timeoutHandler);

      backendSession.pushMessage(makeSessionInitMsg());
      await vi.advanceTimersByTimeAsync(20);

      timedBridge.closeSession("sess-1");

      vi.advanceTimersByTime(10000);

      expect(timeoutHandler).not.toHaveBeenCalled();
    });
  });

  // ── Queue multi-consumer authorship ─────────────────────────────────

  describe("queue multi-consumer authorship", () => {
    let bridge: SessionBridge;
    let adapter: MockBackendAdapter;

    beforeEach(() => {
      const created = createBridgeWithAdapter();
      bridge = created.bridge;
      adapter = created.adapter;
    });

    it("rejects update from a different user", async () => {
      const { consumerSocket, backendSession } = await setupSessionWithConsumer(bridge, adapter);

      await simulateStatusChange(backendSession, "running");
      consumerSocket.sentMessages.length = 0;

      // Queue a message from the first consumer
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "original" }),
      );

      // Create a second consumer
      const consumer2 = createMockSocket();
      bridge.handleConsumerOpen(consumer2, authContext("sess-1"));
      consumer2.sentMessages.length = 0;

      // Try to update from the second consumer
      bridge.handleConsumerMessage(
        consumer2,
        "sess-1",
        JSON.stringify({ type: "update_queued_message", content: "hacked" }),
      );

      const errorMsg = findMessage(consumer2, "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.message).toContain("Only the message author");
    });

    it("rejects cancel from a different user", async () => {
      const { consumerSocket, backendSession } = await setupSessionWithConsumer(bridge, adapter);

      await simulateStatusChange(backendSession, "running");
      consumerSocket.sentMessages.length = 0;

      // Queue a message from the first consumer
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "mine" }),
      );

      // Create a second consumer
      const consumer2 = createMockSocket();
      bridge.handleConsumerOpen(consumer2, authContext("sess-1"));
      consumer2.sentMessages.length = 0;

      // Try to cancel from the second consumer
      bridge.handleConsumerMessage(
        consumer2,
        "sess-1",
        JSON.stringify({ type: "cancel_queued_message" }),
      );

      const errorMsg = findMessage(consumer2, "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.message).toContain("Only the message author");
    });
  });

  // ── Queue realistic CLI flow ────────────────────────────────────────

  describe("queue realistic CLI flow", () => {
    let bridge: SessionBridge;
    let adapter: MockBackendAdapter;

    beforeEach(() => {
      const created = createBridgeWithAdapter();
      bridge = created.bridge;
      adapter = created.adapter;
    });

    it("queues message when CLI is streaming (message_start sets running)", async () => {
      const { consumerSocket, backendSession } = await setupSessionWithConsumer(bridge, adapter);

      await simulateMessageStart(backendSession);
      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "queued via stream" }),
      );

      const queued = findMessage(consumerSocket, "message_queued");
      expect(queued).toBeDefined();
      expect(queued.content).toBe("queued via stream");
    });

    it("auto-sends queued message when CLI sends result", async () => {
      const { backendSession, consumerSocket } = await setupSessionWithConsumer(bridge, adapter);

      await simulateMessageStart(backendSession);
      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "send on idle" }),
      );
      backendSession.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      await simulateResult(backendSession);

      const sent = findMessage(consumerSocket, "queued_message_sent");
      expect(sent).toBeDefined();

      expect(backendReceivedUserMessage(backendSession, "send on idle")).toBe(true);
    });

    it("queues message sent right after user_message (optimistic running)", async () => {
      const { backendSession, consumerSocket } = await setupSessionWithConsumer(bridge, adapter);

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "first message" }),
      );
      backendSession.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "follow-up" }),
      );

      const queued = findMessage(consumerSocket, "message_queued");
      expect(queued).toBeDefined();
      expect(queued.content).toBe("follow-up");
    });
  });

  // ── Git info refresh on result ──────────────────────────────────────

  describe("git info refresh on result", () => {
    it("result message refreshes git info and broadcasts session_update if changed", async () => {
      const mockGitResolver = {
        resolve: vi.fn().mockReturnValue({
          branch: "main",
          isWorktree: false,
          repoRoot: "/repo",
          ahead: 0,
          behind: 0,
        }),
      };
      const gitAdapter = new MockBackendAdapter();
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
        adapter: gitAdapter,
      });

      await gitBridge.connectBackend("sess-1");
      const gitBackendSession = gitAdapter.getSession("sess-1")!;

      const gitConsumerSocket = createMockSocket();
      gitBridge.handleConsumerOpen(gitConsumerSocket, authContext("sess-1"));

      gitBackendSession.pushMessage(makeSessionInitMsg());
      await tick();
      gitConsumerSocket.sentMessages.length = 0;

      mockGitResolver.resolve.mockReturnValue({
        branch: "main",
        isWorktree: false,
        repoRoot: "/repo",
        ahead: 3,
        behind: 0,
      });

      gitBackendSession.pushMessage(makeResultUnifiedMsg());
      await tick();

      const parsed = gitConsumerSocket.sentMessages.map((m: string) => JSON.parse(m));
      const updateMsg = parsed.find(
        (m: any) => m.type === "session_update" && m.session?.git_ahead !== undefined,
      );
      expect(updateMsg).toBeDefined();
      expect(updateMsg.session.git_ahead).toBe(3);
      expect(updateMsg.session.git_branch).toBe("main");

      const state = gitBridge.getSession("sess-1")!.state;
      expect(state.git_ahead).toBe(3);
    });

    it("result message does not broadcast session_update when git info unchanged", async () => {
      const mockGitResolver = {
        resolve: vi.fn().mockReturnValue({
          branch: "main",
          isWorktree: false,
          repoRoot: "/repo",
          ahead: 0,
          behind: 0,
        }),
      };
      const gitAdapter = new MockBackendAdapter();
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
        adapter: gitAdapter,
      });

      await gitBridge.connectBackend("sess-1");
      const gitBackendSession = gitAdapter.getSession("sess-1")!;
      const gitConsumerSocket = createMockSocket();
      gitBridge.handleConsumerOpen(gitConsumerSocket, authContext("sess-1"));

      gitBackendSession.pushMessage(makeSessionInitMsg());
      await tick();
      gitConsumerSocket.sentMessages.length = 0;

      gitBackendSession.pushMessage(makeResultUnifiedMsg());
      await tick();

      const parsed = gitConsumerSocket.sentMessages.map((m: string) => JSON.parse(m));
      const updateMsg = parsed.find(
        (m: any) => m.type === "session_update" && m.session?.git_ahead !== undefined,
      );
      expect(updateMsg).toBeUndefined();
    });
  });

  // ── Slash command programmatic API ──────────────────────────────────

  describe("slash command programmatic API", () => {
    let bridge: SessionBridge;
    let adapter: MockBackendAdapter;

    beforeEach(() => {
      // Use a PassthroughMockAdapter (slashCommands: true) for slash command tests
      const passthroughAdapter = new (class extends MockBackendAdapter {
        override readonly capabilities = {
          streaming: true,
          permissions: true,
          slashCommands: true,
          availability: "local" as const,
          teams: false,
        };
      })();
      const created = createBridgeWithAdapter({ adapter: passthroughAdapter });
      bridge = created.bridge;
      adapter = created.adapter;
    });

    it("programmatic executeSlashCommand returns emulated result for /help", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const result = await bridge.executeSlashCommand("sess-1", "/help");
      expect(result).toBeDefined();
      expect(result!.content).toContain("Available commands:");
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
      expect(backendReceivedUserMessage(backendSession, "/compact")).toBe(true);
    });
  });

  // ── Slash command registry enrichment ───────────────────────────────

  describe("slash command registry enrichment", () => {
    let bridge: SessionBridge;
    let adapter: MockBackendAdapter;

    beforeEach(() => {
      const passthroughAdapter = new (class extends MockBackendAdapter {
        override readonly capabilities = {
          streaming: true,
          permissions: true,
          slashCommands: true,
          availability: "local" as const,
          teams: false,
        };
      })();
      const created = createBridgeWithAdapter({ adapter: passthroughAdapter });
      bridge = created.bridge;
      adapter = created.adapter;
    });

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

    it("enriches registry from capabilities commands", async () => {
      const ws = createMockSocket();

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg({ skills: ["commit"] }));
      await tick();

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
      expect(result.content).toContain("/compact");
      expect(result.content).toContain("/commit");
    });
  });
});
