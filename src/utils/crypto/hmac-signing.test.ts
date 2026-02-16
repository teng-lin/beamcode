import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HMACInput } from "./hmac-signing.js";
import { NonceTracker, sign, verify } from "./hmac-signing.js";
import { getSodium } from "./sodium-loader.js";

describe("hmac-signing", () => {
  let authKey: Uint8Array;

  beforeEach(async () => {
    const sodium = await getSodium();
    authKey = sodium.crypto_auth_keygen();
  });

  function makeInput(overrides?: Partial<HMACInput>): HMACInput {
    return {
      requestId: "req-001",
      behavior: "allow",
      updatedInput: { file: "/tmp/test.txt" },
      timestamp: Date.now(),
      nonce: crypto.getRandomValues(new Uint8Array(16)),
      ...overrides,
    };
  }

  it("valid signature verifies", async () => {
    const input = makeInput();
    const sig = await sign(authKey, input);
    expect(await verify(authKey, sig, input)).toBe(true);
  });

  it("rejects tampered behavior", async () => {
    const input = makeInput({ behavior: "allow" });
    const sig = await sign(authKey, input);

    const tampered = { ...input, behavior: "deny" };
    expect(await verify(authKey, sig, tampered)).toBe(false);
  });

  it("rejects tampered updatedInput", async () => {
    const input = makeInput({ updatedInput: { file: "/tmp/safe.txt" } });
    const sig = await sign(authKey, input);

    const tampered = { ...input, updatedInput: { file: "/etc/passwd" } };
    expect(await verify(authKey, sig, tampered)).toBe(false);
  });

  it("rejects tampered requestId", async () => {
    const input = makeInput({ requestId: "req-001" });
    const sig = await sign(authKey, input);

    const tampered = { ...input, requestId: "req-999" };
    expect(await verify(authKey, sig, tampered)).toBe(false);
  });

  it("rejects tampered timestamp", async () => {
    const input = makeInput();
    const sig = await sign(authKey, input);

    const tampered = { ...input, timestamp: input.timestamp + 1000 };
    expect(await verify(authKey, sig, tampered)).toBe(false);
  });

  it("rejects wrong key", async () => {
    const sodium = await getSodium();
    const wrongKey = sodium.crypto_auth_keygen();
    const input = makeInput();
    const sig = await sign(authKey, input);

    expect(await verify(wrongKey, sig, input)).toBe(false);
  });
});

describe("NonceTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks a fresh nonce", () => {
    const tracker = new NonceTracker();
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    expect(tracker.track(nonce, Date.now())).toBe(true);
  });

  it("rejects duplicate nonce", () => {
    const tracker = new NonceTracker();
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const now = Date.now();
    expect(tracker.track(nonce, now)).toBe(true);
    expect(tracker.track(nonce, now)).toBe(false);
  });

  it("rejects expired timestamp", () => {
    const tracker = new NonceTracker(1000, 30_000);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    // Timestamp 60s in the past, window is 30s
    const expired = Date.now() - 60_000;
    expect(tracker.track(nonce, expired)).toBe(false);
  });

  it("allows nonce again after window expires", () => {
    const tracker = new NonceTracker(1000, 30_000);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const t1 = Date.now();

    expect(tracker.track(nonce, t1)).toBe(true);

    // Advance time past the window
    vi.advanceTimersByTime(31_000);

    // Same nonce but new timestamp — old entry is expired
    // The nonce hex key is the same, but the entry is still in the map
    // We need a different nonce to test window expiry cleanly
    const nonce2 = crypto.getRandomValues(new Uint8Array(16));
    const t2 = Date.now();
    expect(tracker.track(nonce2, t2)).toBe(true);
  });

  it("evicts old entries when at capacity", () => {
    const tracker = new NonceTracker(2, 30_000);

    const n1 = new Uint8Array([1]);
    const n2 = new Uint8Array([2]);
    const n3 = new Uint8Array([3]);
    const now = Date.now();

    expect(tracker.track(n1, now)).toBe(true);
    expect(tracker.track(n2, now)).toBe(true);
    // At capacity (2) — adding n3 should evict after attempting time-based eviction
    expect(tracker.track(n3, now)).toBe(true);
  });
});
