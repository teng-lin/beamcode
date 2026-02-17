import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Authenticator, ConsumerIdentity } from "../interfaces/auth.js";
import {
  authContext,
  createMockSession,
  createTestSocket,
} from "../testing/cli-message-factories.js";
import { resolveConfig } from "../types/config.js";
import { ConsumerGatekeeper, PARTICIPANT_ONLY_TYPES } from "./consumer-gatekeeper.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const defaultConfig = resolveConfig({ port: 3456 });

function createGatekeeper(authenticator?: Authenticator | null) {
  return new ConsumerGatekeeper(authenticator ?? null, defaultConfig);
}

function makeIdentity(role: "participant" | "observer" = "participant"): ConsumerIdentity {
  return { userId: "u1", displayName: "Alice", role };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ConsumerGatekeeper", () => {
  // ─── Authentication flows ───────────────────────────────────────────────

  describe("authenticateAsync", () => {
    it("throws when no authenticator is configured", () => {
      const gk = createGatekeeper(null);
      const ws = createTestSocket();
      expect(() => gk.authenticateAsync(ws, authContext("sess-1"))).toThrow(
        "authenticateAsync requires an authenticator",
      );
    });

    it("returns identity when auth succeeds", async () => {
      const id = makeIdentity();
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockResolvedValue(id),
      };
      const gk = createGatekeeper(authenticator);
      const ws = createTestSocket();

      const result = await gk.authenticateAsync(ws, authContext("sess-1"));

      expect(result).toEqual(id);
    });

    it("rejects when authenticator rejects", async () => {
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockRejectedValue(new Error("denied")),
      };
      const gk = createGatekeeper(authenticator);
      const ws = createTestSocket();

      await expect(gk.authenticateAsync(ws, authContext("sess-1"))).rejects.toThrow("denied");
    });

    it("rejects with timeout when auth takes too long", async () => {
      vi.useFakeTimers();
      try {
        const authenticator: Authenticator = {
          authenticate: () => new Promise(() => {}), // never resolves
        };
        const gk = createGatekeeper(authenticator);
        const ws = createTestSocket();

        const promise = gk.authenticateAsync(ws, authContext("sess-1"));
        vi.advanceTimersByTime(defaultConfig.authTimeoutMs + 1);

        await expect(promise).rejects.toThrow("Authentication timed out");
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns null when socket closes during auth", async () => {
      let resolveAuth!: (id: ConsumerIdentity) => void;
      const authenticator: Authenticator = {
        authenticate: () =>
          new Promise<ConsumerIdentity>((resolve) => {
            resolveAuth = resolve;
          }),
      };
      const gk = createGatekeeper(authenticator);
      const ws = createTestSocket();

      const promise = gk.authenticateAsync(ws, authContext("sess-1"));
      // Simulate socket close by cancelling pending auth
      gk.cancelPendingAuth(ws);
      // Now resolve the authenticator
      resolveAuth(makeIdentity());

      const result = await promise;
      expect(result).toBeNull();
    });

    it("rejects with timeout using short authTimeoutMs", async () => {
      vi.useFakeTimers();
      try {
        const shortConfig = resolveConfig({
          port: 3456,
          authTimeoutMs: 50,
        });
        const authenticator: Authenticator = {
          authenticate: () => new Promise(() => {}),
        };
        const gk = new ConsumerGatekeeper(authenticator, shortConfig);
        const ws = createTestSocket();

        const promise = gk.authenticateAsync(ws, authContext("sess-1"));
        vi.advanceTimersByTime(51);

        await expect(promise).rejects.toThrow("Authentication timed out");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ─── Authorization (behavioral) ────────────────────────────────────────

  describe("authorize", () => {
    let gk: ConsumerGatekeeper;

    beforeEach(() => {
      gk = createGatekeeper();
    });

    it("participant can send all message types including PARTICIPANT_ONLY_TYPES", () => {
      const participant = makeIdentity("participant");
      for (const type of PARTICIPANT_ONLY_TYPES) {
        expect(gk.authorize(participant, type)).toBe(true);
      }
    });

    it("observer cannot send any of the PARTICIPANT_ONLY_TYPES", () => {
      const observer = makeIdentity("observer");
      for (const type of PARTICIPANT_ONLY_TYPES) {
        expect(gk.authorize(observer, type)).toBe(false);
      }
    });

    it("observer CAN send non-participant types", () => {
      const observer = makeIdentity("observer");
      expect(gk.authorize(observer, "subscribe_events")).toBe(true);
      expect(gk.authorize(observer, "ping")).toBe(true);
    });

    it("PARTICIPANT_ONLY_TYPES contains exactly 10 types", () => {
      expect(PARTICIPANT_ONLY_TYPES.size).toBe(10);
      expect(PARTICIPANT_ONLY_TYPES).toContain("user_message");
      expect(PARTICIPANT_ONLY_TYPES).toContain("permission_response");
      expect(PARTICIPANT_ONLY_TYPES).toContain("interrupt");
      expect(PARTICIPANT_ONLY_TYPES).toContain("set_model");
      expect(PARTICIPANT_ONLY_TYPES).toContain("set_permission_mode");
      expect(PARTICIPANT_ONLY_TYPES).toContain("slash_command");
      expect(PARTICIPANT_ONLY_TYPES).toContain("set_adapter");
      expect(PARTICIPANT_ONLY_TYPES).toContain("queue_message");
      expect(PARTICIPANT_ONLY_TYPES).toContain("update_queued_message");
      expect(PARTICIPANT_ONLY_TYPES).toContain("cancel_queued_message");
    });
  });

  // ─── Rate limiting ─────────────────────────────────────────────────────

  describe("checkRateLimit", () => {
    it("first call creates limiter and returns true", () => {
      const gk = createGatekeeper();
      const ws = createTestSocket();
      const session = createMockSession();

      expect(gk.checkRateLimit(ws, session)).toBe(true);
      expect(session.consumerRateLimiters.size).toBe(1);
    });

    it("rapid calls exhaust limiter and return false", () => {
      const gk = createGatekeeper();
      const ws = createTestSocket();
      const session = createMockSession();

      // Default burst size is 20 — exhaust it
      for (let i = 0; i < 20; i++) {
        gk.checkRateLimit(ws, session);
      }
      expect(gk.checkRateLimit(ws, session)).toBe(false);
    });

    it("limiter refills after time advances", () => {
      vi.useFakeTimers();
      try {
        const gk = createGatekeeper();
        const ws = createTestSocket();
        const session = createMockSession();

        // Exhaust burst
        for (let i = 0; i < 20; i++) {
          gk.checkRateLimit(ws, session);
        }
        expect(gk.checkRateLimit(ws, session)).toBe(false);

        // Advance time to refill tokens (50 tokens/sec = 1 token per 20ms)
        vi.advanceTimersByTime(1000);
        expect(gk.checkRateLimit(ws, session)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
