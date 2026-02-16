import { describe, expect, it } from "vitest";
import { InMemoryTokenRegistry } from "./auth-token.js";

describe("InMemoryTokenRegistry", () => {
  // ---------------------------------------------------------------------------
  // Token generation
  // ---------------------------------------------------------------------------

  describe("generate", () => {
    it("produces a 64-character hex string", () => {
      const registry = new InMemoryTokenRegistry();
      const token = registry.generate("session-1");
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("produces unique tokens for different sessions", () => {
      const registry = new InMemoryTokenRegistry();
      const t1 = registry.generate("session-1");
      const t2 = registry.generate("session-2");
      expect(t1).not.toBe(t2);
    });

    it("replaces old token when re-generating for the same session", () => {
      const registry = new InMemoryTokenRegistry();
      const oldToken = registry.generate("session-1");
      const newToken = registry.generate("session-1");

      expect(oldToken).not.toBe(newToken);
      expect(registry.validate("session-1", oldToken)).toBe(false);
      expect(registry.validate("session-1", newToken)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Token validation
  // ---------------------------------------------------------------------------

  describe("validate", () => {
    it("accepts a valid token", () => {
      const registry = new InMemoryTokenRegistry();
      const token = registry.generate("session-1");
      expect(registry.validate("session-1", token)).toBe(true);
    });

    it("rejects an invalid token (wrong value, same length)", () => {
      const registry = new InMemoryTokenRegistry();
      registry.generate("session-1");
      const wrongToken = "a".repeat(64);
      expect(registry.validate("session-1", wrongToken)).toBe(false);
    });

    it("returns false for a missing session", () => {
      const registry = new InMemoryTokenRegistry();
      expect(registry.validate("no-such-session", "abc123")).toBe(false);
    });

    it("rejects an empty string token", () => {
      const registry = new InMemoryTokenRegistry();
      registry.generate("session-1");
      expect(registry.validate("session-1", "")).toBe(false);
    });

    it("handles non-hex token gracefully (no crash)", () => {
      const registry = new InMemoryTokenRegistry();
      registry.generate("session-1");
      expect(registry.validate("session-1", "not-valid-hex!!!")).toBe(false);
      expect(registry.validate("session-1", "zzzz")).toBe(false);
    });

    it("rejects a token with wrong length", () => {
      const registry = new InMemoryTokenRegistry();
      registry.generate("session-1");
      expect(registry.validate("session-1", "abcd")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Token revocation
  // ---------------------------------------------------------------------------

  describe("revoke", () => {
    it("makes validate return false after revocation", () => {
      const registry = new InMemoryTokenRegistry();
      const token = registry.generate("session-1");
      expect(registry.validate("session-1", token)).toBe(true);

      registry.revoke("session-1");
      expect(registry.validate("session-1", token)).toBe(false);
    });

    it("does not throw when revoking a non-existent session", () => {
      const registry = new InMemoryTokenRegistry();
      expect(() => registry.revoke("no-such-session")).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // has()
  // ---------------------------------------------------------------------------

  describe("has", () => {
    it("returns false before any token is generated", () => {
      const registry = new InMemoryTokenRegistry();
      expect(registry.has("session-1")).toBe(false);
    });

    it("returns true after a token is generated", () => {
      const registry = new InMemoryTokenRegistry();
      registry.generate("session-1");
      expect(registry.has("session-1")).toBe(true);
    });

    it("returns false after revocation", () => {
      const registry = new InMemoryTokenRegistry();
      registry.generate("session-1");
      registry.revoke("session-1");
      expect(registry.has("session-1")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-session independence
  // ---------------------------------------------------------------------------

  describe("multi-session independence", () => {
    it("sessions have independent tokens", () => {
      const registry = new InMemoryTokenRegistry();
      const t1 = registry.generate("session-1");
      const t2 = registry.generate("session-2");

      // Each token only validates for its own session
      expect(registry.validate("session-1", t1)).toBe(true);
      expect(registry.validate("session-2", t2)).toBe(true);
      expect(registry.validate("session-1", t2)).toBe(false);
      expect(registry.validate("session-2", t1)).toBe(false);
    });

    it("revoking one session does not affect others", () => {
      const registry = new InMemoryTokenRegistry();
      const t1 = registry.generate("session-1");
      registry.generate("session-2");

      registry.revoke("session-2");
      expect(registry.validate("session-1", t1)).toBe(true);
      expect(registry.has("session-2")).toBe(false);
    });
  });
});
