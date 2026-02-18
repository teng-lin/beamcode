import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { MemoryStorage } from "../adapters/memory-storage.js";
import type { Authenticator, ConsumerIdentity } from "../interfaces/auth.js";
import {
  MockBackendAdapter,
  makeAssistantUnifiedMsg,
  makePermissionRequestUnifiedMsg,
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

function createBridge(options?: { storage?: MemoryStorage; authenticator?: Authenticator }) {
  const storage = options?.storage ?? new MemoryStorage();
  const adapter = new MockBackendAdapter();
  const bridge = new SessionBridge({
    storage,
    authenticator: options?.authenticator,
    config: { port: 3456 },
    logger: noopLogger,
    adapter,
  });
  return { bridge, storage, adapter };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — auth", () => {
  let bridge: SessionBridge;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridge();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  // ── Authentication ──────────────────────────────────────────────────

  describe("Authentication", () => {
    it("rejects consumer when authenticator throws", async () => {
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockRejectedValue(new Error("Invalid token")),
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");

      const failedHandler = vi.fn();
      authBridge.on("consumer:auth_failed", failedHandler);

      const ws = createMockSocket();
      authBridge.handleConsumerOpen(ws, authContext("sess-1"));

      // Let the authenticator promise reject
      await new Promise((r) => setTimeout(r, 0));

      expect(ws.close).toHaveBeenCalledWith(4001, "Authentication failed");
      expect(failedHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        reason: "Invalid token",
      });
    });

    it("accepts consumer when authenticator resolves", async () => {
      const identity: ConsumerIdentity = {
        userId: "user-42",
        displayName: "Alice",
        role: "participant",
      };
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockResolvedValue(identity),
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");

      const authedHandler = vi.fn();
      authBridge.on("consumer:authenticated", authedHandler);

      const ws = createMockSocket();
      authBridge.handleConsumerOpen(ws, authContext("sess-1"));

      await new Promise((r) => setTimeout(r, 0));

      expect(ws.close).not.toHaveBeenCalled();
      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "identity")).toBe(true);
      expect(parsed.some((m: any) => m.type === "session_init")).toBe(true);
      expect(authedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-1",
          userId: "user-42",
          displayName: "Alice",
          role: "participant",
        }),
      );
    });

    it("sends identity message to authenticated consumer", async () => {
      const identity: ConsumerIdentity = {
        userId: "user-99",
        displayName: "Bob",
        role: "observer",
      };
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockResolvedValue(identity),
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");

      const ws = createMockSocket();
      authBridge.handleConsumerOpen(ws, authContext("sess-1"));

      await new Promise((r) => setTimeout(r, 0));

      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      const identityMsg = parsed.find((m: any) => m.type === "identity");
      expect(identityMsg).toEqual({
        type: "identity",
        userId: "user-99",
        displayName: "Bob",
        role: "observer",
      });
    });

    it("assigns anonymous identity when no authenticator (dev mode)", () => {
      bridge.getOrCreateSession("sess-1");
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));

      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      const identityMsg = parsed.find((m: any) => m.type === "identity");
      expect(identityMsg).toEqual({
        type: "identity",
        userId: "anonymous-1",
        displayName: "User 1",
        role: "participant",
      });
    });

    it("authenticator receives correct sessionId in context", async () => {
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockResolvedValue({
          userId: "u1",
          displayName: "U1",
          role: "participant",
        }),
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("my-session");

      const ws = createMockSocket();
      authBridge.handleConsumerOpen(ws, authContext("my-session"));

      await new Promise((r) => setTimeout(r, 0));

      expect(authenticator.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "my-session" }),
      );
    });

    it("authenticator receives transport metadata", async () => {
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockResolvedValue({
          userId: "u1",
          displayName: "U1",
          role: "participant",
        }),
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");

      const ws = createMockSocket();
      const transport = { headers: { authorization: "Bearer abc" }, query: { token: "xyz" } };
      authBridge.handleConsumerOpen(ws, { sessionId: "sess-1", transport });

      await new Promise((r) => setTimeout(r, 0));

      expect(authenticator.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          transport: expect.objectContaining({ headers: { authorization: "Bearer abc" } }),
        }),
      );
    });
  });

  // ── Role-based authorization ────────────────────────────────────────

  describe("Role-based authorization", () => {
    function createObserverBridge() {
      const identity: ConsumerIdentity = {
        userId: "obs-1",
        displayName: "Observer",
        role: "observer",
      };
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockResolvedValue(identity),
      };
      return createBridge({ authenticator });
    }

    async function connectObserver(b: SessionBridge, sessionId: string) {
      b.getOrCreateSession(sessionId);
      const ws = createMockSocket();
      b.handleConsumerOpen(ws, authContext(sessionId));
      await new Promise((r) => setTimeout(r, 0));
      ws.sentMessages.length = 0;
      return ws;
    }

    it("observer receives all broadcast messages", async () => {
      const { bridge: obsBridge, adapter: obsAdapter } = createObserverBridge();
      obsBridge.getOrCreateSession("sess-1");

      await obsBridge.connectBackend("sess-1");
      const backendSession = obsAdapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const ws = createMockSocket();
      obsBridge.handleConsumerOpen(ws, authContext("sess-1"));
      await new Promise((r) => setTimeout(r, 0));
      ws.sentMessages.length = 0;

      backendSession.pushMessage(makeAssistantUnifiedMsg());
      await tick();

      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "assistant")).toBe(true);
    });

    it("observer blocked from user_message", async () => {
      const { bridge: obsBridge, adapter: obsAdapter } = createObserverBridge();
      obsBridge.getOrCreateSession("sess-1");

      await obsBridge.connectBackend("sess-1");
      const backendSession = obsAdapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const ws = await connectObserver(obsBridge, "sess-1");
      // Clear any messages sent during init (e.g. initialize control_request)
      backendSession.sentMessages.length = 0;
      backendSession.sentRawMessages.length = 0;

      obsBridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "hello" }),
      );

      // Should NOT reach backend
      expect(backendSession.sentMessages).toHaveLength(0);
      expect(backendSession.sentRawMessages).toHaveLength(0);

      // Should get error back
      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "error")).toBe(true);
    });

    it("observer blocked from permission_response", async () => {
      const { bridge: obsBridge, adapter: obsAdapter } = createObserverBridge();
      obsBridge.getOrCreateSession("sess-1");

      await obsBridge.connectBackend("sess-1");
      const backendSession = obsAdapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      // Push a permission request so there is a pending permission to respond to
      backendSession.pushMessage(makePermissionRequestUnifiedMsg());
      await tick();

      const ws = await connectObserver(obsBridge, "sess-1");
      backendSession.sentMessages.length = 0;
      backendSession.sentRawMessages.length = 0;

      obsBridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({
          type: "permission_response",
          request_id: "perm-req-1",
          behavior: "allow",
        }),
      );

      expect(backendSession.sentMessages).toHaveLength(0);
      expect(backendSession.sentRawMessages).toHaveLength(0);
      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "error")).toBe(true);
    });

    it("observer blocked from interrupt", async () => {
      const { bridge: obsBridge, adapter: obsAdapter } = createObserverBridge();
      obsBridge.getOrCreateSession("sess-1");

      await obsBridge.connectBackend("sess-1");
      const backendSession = obsAdapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const ws = await connectObserver(obsBridge, "sess-1");
      backendSession.sentMessages.length = 0;
      backendSession.sentRawMessages.length = 0;

      obsBridge.handleConsumerMessage(ws, "sess-1", JSON.stringify({ type: "interrupt" }));

      expect(backendSession.sentMessages).toHaveLength(0);
      expect(backendSession.sentRawMessages).toHaveLength(0);
      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "error")).toBe(true);
    });

    it("observer blocked from set_model", async () => {
      const { bridge: obsBridge, adapter: obsAdapter } = createObserverBridge();
      obsBridge.getOrCreateSession("sess-1");

      await obsBridge.connectBackend("sess-1");
      const backendSession = obsAdapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const ws = await connectObserver(obsBridge, "sess-1");
      backendSession.sentMessages.length = 0;
      backendSession.sentRawMessages.length = 0;

      obsBridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "set_model", model: "claude-opus-4-20250514" }),
      );

      expect(backendSession.sentMessages).toHaveLength(0);
      expect(backendSession.sentRawMessages).toHaveLength(0);
      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "error")).toBe(true);
    });

    it("observer blocked from set_permission_mode", async () => {
      const { bridge: obsBridge, adapter: obsAdapter } = createObserverBridge();
      obsBridge.getOrCreateSession("sess-1");

      await obsBridge.connectBackend("sess-1");
      const backendSession = obsAdapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const ws = await connectObserver(obsBridge, "sess-1");
      backendSession.sentMessages.length = 0;
      backendSession.sentRawMessages.length = 0;

      obsBridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "set_permission_mode", mode: "plan" }),
      );

      expect(backendSession.sentMessages).toHaveLength(0);
      expect(backendSession.sentRawMessages).toHaveLength(0);
      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "error")).toBe(true);
    });

    it("observer receives error message when blocked", async () => {
      const { bridge: obsBridge, adapter: obsAdapter } = createObserverBridge();
      obsBridge.getOrCreateSession("sess-1");

      await obsBridge.connectBackend("sess-1");
      const backendSession = obsAdapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const ws = await connectObserver(obsBridge, "sess-1");

      obsBridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "hello" }),
      );

      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      const errorMsg = parsed.find((m: any) => m.type === "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.message).toBe("Observers cannot send user_message messages");
    });

    it("participant can send all message types", async () => {
      // Default anonymous is participant
      bridge.getOrCreateSession("sess-1");

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      // Clear messages sent during connect/init
      backendSession.sentMessages.length = 0;
      backendSession.sentRawMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "hello from participant" }),
      );

      // With adapter path, messages go through backendSession.send()
      expect(backendSession.sentMessages.length).toBeGreaterThan(0);
      const userMsg = backendSession.sentMessages.find((m) => m.type === "user_message");
      expect(userMsg).toBeDefined();
    });

    it("observer can send presence_query", async () => {
      const { bridge: obsBridge } = createObserverBridge();
      obsBridge.getOrCreateSession("sess-1");

      const ws = await connectObserver(obsBridge, "sess-1");
      ws.sentMessages.length = 0;

      obsBridge.handleConsumerMessage(ws, "sess-1", JSON.stringify({ type: "presence_query" }));

      // Should NOT get error
      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "error")).toBe(false);
      // Should get presence_update instead
      expect(parsed.some((m: any) => m.type === "presence_update")).toBe(true);
    });
  });

  // ── Edge cases (auth-related) ──────────────────────────────────────

  describe("Edge cases", () => {
    it("messages from unregistered sockets are silently dropped", async () => {
      bridge.getOrCreateSession("sess-1");

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      // Clear messages from init
      backendSession.sentMessages.length = 0;
      backendSession.sentRawMessages.length = 0;

      // ws is NOT registered as a consumer — never called handleConsumerOpen
      const ws = createMockSocket();
      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "sneaky" }),
      );

      // Nothing forwarded to backend
      expect(backendSession.sentMessages).toHaveLength(0);
      expect(backendSession.sentRawMessages).toHaveLength(0);
      // No error sent to unregistered socket either
      expect(ws.sentMessages).toHaveLength(0);
    });

    it("messages during pending auth are silently dropped", async () => {
      let resolveAuth!: (id: ConsumerIdentity) => void;
      const authenticator: Authenticator = {
        authenticate: () =>
          new Promise((resolve) => {
            resolveAuth = resolve;
          }),
      };
      const { bridge: authBridge, adapter: authAdapter } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");

      await authBridge.connectBackend("sess-1");
      const backendSession = authAdapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const ws = createMockSocket();
      authBridge.handleConsumerOpen(ws, authContext("sess-1"));

      // Auth still pending — try to send a message
      backendSession.sentMessages.length = 0;
      backendSession.sentRawMessages.length = 0;
      authBridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "too early" }),
      );

      // Dropped — socket not yet in map
      expect(backendSession.sentMessages).toHaveLength(0);
      expect(backendSession.sentRawMessages).toHaveLength(0);

      // Now resolve auth
      resolveAuth({ userId: "u1", displayName: "User 1", role: "participant" });
      await new Promise((r) => setTimeout(r, 0));

      // Now message should work
      authBridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "now it works" }),
      );
      expect(
        backendSession.sentMessages.length + backendSession.sentRawMessages.length,
      ).toBeGreaterThan(0);
    });

    it("synchronous authenticator throw is caught", () => {
      const authenticator: Authenticator = {
        authenticate: () => {
          throw new Error("sync boom");
        },
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");

      const events: unknown[] = [];
      authBridge.on("consumer:auth_failed", (e) => events.push(e));

      const ws = createMockSocket();
      // Should not throw
      authBridge.handleConsumerOpen(ws, authContext("sess-1"));

      expect(events).toHaveLength(1);
      expect(ws.close).toHaveBeenCalledWith(4001, "Authentication failed");
    });

    it("auth timeout rejects slow authenticators", async () => {
      const authenticator: Authenticator = {
        authenticate: () => new Promise(() => {}), // never resolves
      };
      // Override authTimeoutMs via config
      const authAdapter = new MockBackendAdapter();
      const fastBridge = new SessionBridge({
        authenticator,
        config: { port: 3456, authTimeoutMs: 50 },
        logger: noopLogger,
        adapter: authAdapter,
      });
      fastBridge.getOrCreateSession("sess-1");

      const events: unknown[] = [];
      fastBridge.on("consumer:auth_failed", (e) => events.push(e));

      const ws = createMockSocket();
      fastBridge.handleConsumerOpen(ws, authContext("sess-1"));

      // Wait for timeout
      await new Promise((r) => setTimeout(r, 100));

      expect(events).toHaveLength(1);
      expect((events[0] as any).reason).toBe("Authentication timed out");
      expect(ws.close).toHaveBeenCalledWith(4001, "Authentication failed");
    });

    it("session removed during async auth rejects consumer", async () => {
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockResolvedValue({
          userId: "u1",
          displayName: "User 1",
          role: "participant",
        }),
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");

      const events: unknown[] = [];
      authBridge.on("consumer:auth_failed", (e) => events.push(e));

      const ws = createMockSocket();
      authBridge.handleConsumerOpen(ws, authContext("sess-1"));

      // Remove session before auth resolves
      authBridge.removeSession("sess-1");

      await new Promise((r) => setTimeout(r, 0));

      expect(events).toHaveLength(1);
      expect((events[0] as any).reason).toBe("Session closed during authentication");
      expect(ws.close).toHaveBeenCalledWith(4001, "Authentication failed");
    });

    it("permission cancellations on CLI disconnect are only sent to participants", async () => {
      const identity: ConsumerIdentity = {
        userId: "obs-1",
        displayName: "Observer",
        role: "observer",
      };
      const participantIdentity: ConsumerIdentity = {
        userId: "part-1",
        displayName: "Participant",
        role: "participant",
      };
      let callCount = 0;
      const authenticator: Authenticator = {
        authenticate: () => {
          callCount++;
          return Promise.resolve(callCount === 1 ? participantIdentity : identity);
        },
      };
      const { bridge: authBridge, adapter: authAdapter } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");

      await authBridge.connectBackend("sess-1");
      const backendSession = authAdapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      // Connect participant
      const wsParticipant = createMockSocket();
      authBridge.handleConsumerOpen(wsParticipant, authContext("sess-1"));
      await new Promise((r) => setTimeout(r, 0));

      // Connect observer
      const wsObserver = createMockSocket();
      authBridge.handleConsumerOpen(wsObserver, authContext("sess-1"));
      await new Promise((r) => setTimeout(r, 0));

      // Add a pending permission via adapter path
      backendSession.pushMessage(makePermissionRequestUnifiedMsg());
      await tick();

      wsParticipant.sentMessages.length = 0;
      wsObserver.sentMessages.length = 0;

      // Disconnect backend — should send permission_cancelled only to participant
      await authBridge.disconnectBackend("sess-1");

      const participantMsgs = wsParticipant.sentMessages.map((m) => JSON.parse(m));
      const observerMsgs = wsObserver.sentMessages.map((m) => JSON.parse(m));

      // Participant gets cli_disconnected + permission_cancelled
      expect(participantMsgs.some((m: any) => m.type === "permission_cancelled")).toBe(true);
      // Observer gets cli_disconnected but NOT permission_cancelled
      expect(observerMsgs.some((m: any) => m.type === "cli_disconnected")).toBe(true);
      expect(observerMsgs.some((m: any) => m.type === "permission_cancelled")).toBe(false);
    });
  });
});
