import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InMemoryTokenRegistry } from "./auth-token.js";

describe("InMemoryTokenRegistry property tests", () => {
  it("generated tokens are always 64 hex characters", () => {
    fc.assert(
      fc.property(fc.uuid(), (sessionId) => {
        const registry = new InMemoryTokenRegistry();
        const token = registry.generate(sessionId);
        expect(token).toMatch(/^[0-9a-f]{64}$/);
      }),
    );
  });

  it("valid token always passes validation", () => {
    fc.assert(
      fc.property(fc.uuid(), (sessionId) => {
        const registry = new InMemoryTokenRegistry();
        const token = registry.generate(sessionId);
        expect(registry.validate(sessionId, token)).toBe(true);
      }),
    );
  });

  it("tokens are unique across sessions", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 100 }), (sessionIds) => {
        const registry = new InMemoryTokenRegistry();
        const tokens = sessionIds.map((id) => registry.generate(id));
        expect(new Set(tokens).size).toBe(tokens.length);
      }),
    );
  });

  it("token for session A does not validate for session B", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (sessionA, sessionB) => {
        fc.pre(sessionA !== sessionB);
        const registry = new InMemoryTokenRegistry();
        const tokenA = registry.generate(sessionA);
        registry.generate(sessionB);
        expect(registry.validate(sessionB, tokenA)).toBe(false);
      }),
    );
  });

  it("regenerating a token invalidates the previous one", () => {
    fc.assert(
      fc.property(fc.uuid(), (sessionId) => {
        const registry = new InMemoryTokenRegistry();
        const token1 = registry.generate(sessionId);
        registry.generate(sessionId);
        expect(registry.validate(sessionId, token1)).toBe(false);
      }),
    );
  });

  it("revoke makes token invalid and has() return false", () => {
    fc.assert(
      fc.property(fc.uuid(), (sessionId) => {
        const registry = new InMemoryTokenRegistry();
        const token = registry.generate(sessionId);
        registry.revoke(sessionId);
        expect(registry.validate(sessionId, token)).toBe(false);
        expect(registry.has(sessionId)).toBe(false);
      }),
    );
  });

  it("revoking one session does not affect others", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (sessionA, sessionB) => {
        fc.pre(sessionA !== sessionB);
        const registry = new InMemoryTokenRegistry();
        registry.generate(sessionA);
        const tokenB = registry.generate(sessionB);
        registry.revoke(sessionA);
        expect(registry.validate(sessionB, tokenB)).toBe(true);
      }),
    );
  });

  it("arbitrary strings that are not the correct token fail validation", () => {
    const hexChar = fc.mapToConstant(
      { num: 10, build: (v) => String.fromCharCode(0x30 + v) }, // '0'-'9'
      { num: 6, build: (v) => String.fromCharCode(0x61 + v) }, // 'a'-'f'
    );
    const hexString64 = fc
      .array(hexChar, { minLength: 64, maxLength: 64 })
      .map((arr) => arr.join(""));

    fc.assert(
      fc.property(fc.uuid(), hexString64, (sessionId, fakeToken) => {
        const registry = new InMemoryTokenRegistry();
        const realToken = registry.generate(sessionId);
        fc.pre(fakeToken !== realToken);
        expect(registry.validate(sessionId, fakeToken)).toBe(false);
      }),
    );
  });
});
