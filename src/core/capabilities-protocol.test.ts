import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockSession, noopLogger } from "../testing/cli-message-factories.js";
import type { ResolvedConfig } from "../types/config.js";
import { DEFAULT_CONFIG } from "../types/config.js";
import { CapabilitiesProtocol } from "./capabilities-protocol.js";
import type { ConsumerBroadcaster } from "./consumer-broadcaster.js";
import type { Session } from "./session-store.js";
import { createUnifiedMessage } from "./types/unified-message.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function createDeps(configOverrides?: Partial<ResolvedConfig>) {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  const sendToCLI = vi.fn<(session: Session, ndjson: string) => void>();
  const broadcaster = {
    broadcast: vi.fn(),
    broadcastToParticipants: vi.fn(),
    sendTo: vi.fn(),
  } as unknown as ConsumerBroadcaster;
  const emitEvent = vi.fn();
  const persistSession = vi.fn();

  const protocol = new CapabilitiesProtocol(
    config,
    noopLogger,
    sendToCLI,
    broadcaster,
    emitEvent,
    persistSession,
  );

  return { protocol, config, sendToCLI, broadcaster, emitEvent, persistSession };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("CapabilitiesProtocol", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── sendInitializeRequest ─────────────────────────────────────────────

  describe("sendInitializeRequest", () => {
    it("sends a control_request with subtype initialize", () => {
      const { protocol, sendToCLI } = createDeps();
      const session = createMockSession();

      protocol.sendInitializeRequest(session);

      expect(sendToCLI).toHaveBeenCalledOnce();
      const [sentSession, ndjson] = sendToCLI.mock.calls[0];
      expect(sentSession).toBe(session);

      const parsed = JSON.parse(ndjson);
      expect(parsed.type).toBe("control_request");
      expect(parsed.request.subtype).toBe("initialize");
      expect(parsed.request_id).toBeTypeOf("string");
    });

    it("sets pendingInitialize on the session", () => {
      const { protocol } = createDeps();
      const session = createMockSession();

      protocol.sendInitializeRequest(session);

      expect(session.pendingInitialize).not.toBeNull();
      expect(session.pendingInitialize!.requestId).toBeTypeOf("string");
      expect(session.pendingInitialize!.timer).toBeDefined();
    });

    it("deduplicates if already pending", () => {
      const { protocol, sendToCLI } = createDeps();
      const session = createMockSession();

      protocol.sendInitializeRequest(session);
      protocol.sendInitializeRequest(session);

      expect(sendToCLI).toHaveBeenCalledOnce();
    });

    it("emits capabilities:timeout after initializeTimeoutMs", () => {
      vi.useFakeTimers();
      const { protocol, emitEvent } = createDeps({ initializeTimeoutMs: 3000 });
      const session = createMockSession();

      protocol.sendInitializeRequest(session);

      vi.advanceTimersByTime(3001);

      expect(emitEvent).toHaveBeenCalledWith("capabilities:timeout", {
        sessionId: session.id,
      });
      expect(session.pendingInitialize).toBeNull();
    });

    it("does not emit timeout if request was already handled", () => {
      vi.useFakeTimers();
      const { protocol, emitEvent } = createDeps({ initializeTimeoutMs: 3000 });
      const session = createMockSession();

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      // Simulate successful response clearing pendingInitialize
      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: requestId,
          response: { commands: [], models: [] },
        },
      });
      protocol.handleControlResponse(session, msg);

      vi.advanceTimersByTime(5000);

      expect(emitEvent).not.toHaveBeenCalledWith("capabilities:timeout", expect.anything());
    });
  });

  // ── cancelPendingInitialize ───────────────────────────────────────────

  describe("cancelPendingInitialize", () => {
    it("clears the pending timer and nulls pendingInitialize", () => {
      vi.useFakeTimers();
      const { protocol, emitEvent } = createDeps({ initializeTimeoutMs: 3000 });
      const session = createMockSession();

      protocol.sendInitializeRequest(session);
      expect(session.pendingInitialize).not.toBeNull();

      protocol.cancelPendingInitialize(session);

      expect(session.pendingInitialize).toBeNull();

      // Timer should not fire
      vi.advanceTimersByTime(5000);
      expect(emitEvent).not.toHaveBeenCalled();
    });

    it("is a no-op if no pending initialize", () => {
      const { protocol } = createDeps();
      const session = createMockSession();

      expect(() => protocol.cancelPendingInitialize(session)).not.toThrow();
      expect(session.pendingInitialize).toBeNull();
    });
  });

  // ── handleControlResponse ─────────────────────────────────────────────

  describe("handleControlResponse", () => {
    it("applies capabilities on successful response", () => {
      const { protocol, broadcaster, emitEvent, persistSession } = createDeps();
      const session = createMockSession();

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: requestId,
          response: {
            commands: [{ name: "/help", description: "Show help" }],
            models: [{ value: "claude-sonnet-4-5-20250929", displayName: "Sonnet 4.5" }],
            account: { email: "user@test.com" },
          },
        },
      });

      protocol.handleControlResponse(session, msg);

      // Capabilities stored
      expect(session.state.capabilities).toBeDefined();
      expect(session.state.capabilities!.commands).toHaveLength(1);
      expect(session.state.capabilities!.models).toHaveLength(1);
      expect(session.state.capabilities!.account).toEqual({ email: "user@test.com" });

      // Broadcast sent
      expect(broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          type: "capabilities_ready",
          commands: [{ name: "/help", description: "Show help" }],
          models: [{ value: "claude-sonnet-4-5-20250929", displayName: "Sonnet 4.5" }],
          account: { email: "user@test.com" },
        }),
      );

      // Event emitted
      expect(emitEvent).toHaveBeenCalledWith(
        "capabilities:ready",
        expect.objectContaining({
          sessionId: session.id,
          commands: expect.arrayContaining([expect.objectContaining({ name: "/help" })]),
        }),
      );

      // Session persisted
      expect(persistSession).toHaveBeenCalledWith(session);

      // Pending cleared
      expect(session.pendingInitialize).toBeNull();
    });

    it("registers commands in the slash command registry", () => {
      const { protocol } = createDeps();
      const session = createMockSession();

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: requestId,
          response: {
            commands: [
              { name: "/help", description: "Show help" },
              { name: "/compact", description: "Compact context" },
            ],
            models: [],
          },
        },
      });

      protocol.handleControlResponse(session, msg);

      expect(session.registry.registerFromCLI).toHaveBeenCalledWith([
        { name: "/help", description: "Show help" },
        { name: "/compact", description: "Compact context" },
      ]);
    });

    it("does not register commands when commands array is empty", () => {
      const { protocol } = createDeps();
      const session = createMockSession();

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: requestId,
          response: { commands: [], models: [] },
        },
      });

      protocol.handleControlResponse(session, msg);

      expect(session.registry.registerFromCLI).not.toHaveBeenCalled();
    });

    it("ignores response with unknown request_id", () => {
      const { protocol, broadcaster, emitEvent } = createDeps();
      const session = createMockSession();

      protocol.sendInitializeRequest(session);

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: "unknown-id",
          response: { commands: [], models: [] },
        },
      });

      protocol.handleControlResponse(session, msg);

      expect(session.state.capabilities).toBeUndefined();
      expect(broadcaster.broadcast).not.toHaveBeenCalled();
      expect(emitEvent).not.toHaveBeenCalledWith("capabilities:ready", expect.anything());
    });

    it("ignores response when no pending initialize", () => {
      const { protocol, broadcaster } = createDeps();
      const session = createMockSession();

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: "some-id",
          response: { commands: [], models: [] },
        },
      });

      protocol.handleControlResponse(session, msg);

      expect(broadcaster.broadcast).not.toHaveBeenCalled();
    });

    it("handles error response without capabilities", () => {
      const { protocol } = createDeps();
      const session = createMockSession();

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "error",
          request_id: requestId,
          error: "Not supported",
        },
      });

      protocol.handleControlResponse(session, msg);

      // No capabilities set (no slash_commands to synthesize from)
      expect(session.state.capabilities).toBeUndefined();
      expect(session.pendingInitialize).toBeNull();
    });

    it("synthesizes capabilities from slash_commands on error fallback", () => {
      const { protocol, broadcaster, emitEvent } = createDeps();
      const session = createMockSession();
      session.state.slash_commands = ["/help", "/compact"];

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "error",
          request_id: requestId,
          error: "Already initialized",
        },
      });

      protocol.handleControlResponse(session, msg);

      // Capabilities synthesized from slash_commands
      expect(session.state.capabilities).toBeDefined();
      expect(session.state.capabilities!.commands).toEqual([
        { name: "/help", description: "" },
        { name: "/compact", description: "" },
      ]);
      expect(session.state.capabilities!.models).toEqual([]);
      expect(session.state.capabilities!.account).toBeNull();

      // Broadcast and emit still fire
      expect(broadcaster.broadcast).toHaveBeenCalled();
      expect(emitEvent).toHaveBeenCalledWith("capabilities:ready", expect.anything());
    });

    it("does not synthesize on error if capabilities already exist", () => {
      const { protocol, broadcaster } = createDeps();
      const session = createMockSession();
      session.state.slash_commands = ["/help"];
      session.state.capabilities = {
        commands: [{ name: "/existing", description: "Existing" }],
        models: [],
        account: null,
        receivedAt: Date.now(),
      };

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "error",
          request_id: requestId,
          error: "Already initialized",
        },
      });

      protocol.handleControlResponse(session, msg);

      // Original capabilities remain unchanged
      expect(session.state.capabilities!.commands).toEqual([
        { name: "/existing", description: "Existing" },
      ]);
      expect(broadcaster.broadcast).not.toHaveBeenCalled();
    });

    it("handles response with missing response body gracefully", () => {
      const { protocol, broadcaster } = createDeps();
      const session = createMockSession();

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: requestId,
          // no response field
        },
      });

      protocol.handleControlResponse(session, msg);

      expect(session.state.capabilities).toBeUndefined();
      expect(broadcaster.broadcast).not.toHaveBeenCalled();
      expect(session.pendingInitialize).toBeNull();
    });

    it("handles partial capabilities (only commands)", () => {
      const { protocol } = createDeps();
      const session = createMockSession();

      protocol.sendInitializeRequest(session);
      const requestId = session.pendingInitialize!.requestId;

      const msg = createUnifiedMessage({
        type: "control_response",
        role: "system",
        metadata: {
          subtype: "success",
          request_id: requestId,
          response: {
            commands: [{ name: "/help", description: "Help" }],
            // no models or account
          },
        },
      });

      protocol.handleControlResponse(session, msg);

      expect(session.state.capabilities!.commands).toHaveLength(1);
      expect(session.state.capabilities!.models).toEqual([]);
      expect(session.state.capabilities!.account).toBeNull();
    });
  });

  // ── applyCapabilities ─────────────────────────────────────────────────

  describe("applyCapabilities", () => {
    it("stores capabilities with receivedAt timestamp", () => {
      const { protocol } = createDeps();
      const session = createMockSession();
      const before = Date.now();

      protocol.applyCapabilities(session, [{ name: "/test", description: "Test" }], [], null);

      expect(session.state.capabilities!.receivedAt).toBeGreaterThanOrEqual(before);
      expect(session.state.capabilities!.receivedAt).toBeLessThanOrEqual(Date.now());
    });

    it("includes skills from session state in broadcast", () => {
      const { protocol, broadcaster } = createDeps();
      const session = createMockSession();
      session.state.skills = ["commit", "review-pr"];

      protocol.applyCapabilities(session, [], [], null);

      expect(broadcaster.broadcast).toHaveBeenCalledWith(
        session,
        expect.objectContaining({
          type: "capabilities_ready",
          skills: ["commit", "review-pr"],
        }),
      );
    });
  });
});
