import { describe, expect, it } from "vitest";
import {
  deserializeEnvelope,
  isEncryptedEnvelope,
  serializeEnvelope,
  unwrapEnvelope,
  wrapEnvelope,
} from "./encrypted-envelope.js";
import { generateKeypair } from "./key-manager.js";

describe("EncryptedEnvelope", () => {
  it("roundtrips: wrap → unwrap recovers plaintext", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const plaintext = new TextEncoder().encode('{"type":"user_message","content":"hello"}');

    const envelope = await wrapEnvelope(plaintext, "session-1", bob.publicKey, alice.secretKey);

    expect(envelope.v).toBe(1);
    expect(envelope.sid).toBe("session-1");
    expect(typeof envelope.ct).toBe("string");

    const recovered = await unwrapEnvelope(envelope, alice.publicKey, bob.secretKey);
    expect(recovered).toEqual(plaintext);
  });

  it("rejects tampered ciphertext", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const plaintext = new TextEncoder().encode("tamper test");

    const envelope = await wrapEnvelope(plaintext, "s1", bob.publicKey, alice.secretKey);

    // Tamper with the base64url ciphertext
    const chars = envelope.ct.split("");
    const idx = Math.floor(chars.length / 2);
    chars[idx] = chars[idx] === "A" ? "B" : "A";
    const tampered = { ...envelope, ct: chars.join("") };

    await expect(unwrapEnvelope(tampered, alice.publicKey, bob.secretKey)).rejects.toThrow();
  });

  it("rejects wrong key", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const eve = await generateKeypair();
    const plaintext = new TextEncoder().encode("wrong key test");

    const envelope = await wrapEnvelope(plaintext, "s1", bob.publicKey, alice.secretKey);

    await expect(unwrapEnvelope(envelope, eve.publicKey, bob.secretKey)).rejects.toThrow();
  });

  it("rejects unsupported version", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();

    const envelope = { v: 2 as unknown as 1, sid: "s1", ct: "abc" };
    await expect(unwrapEnvelope(envelope, alice.publicKey, bob.secretKey)).rejects.toThrow(
      "Unsupported envelope version",
    );
  });

  it("rejects truncated ciphertext", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();

    // ct too short to contain a nonce
    const envelope = { v: 1 as const, sid: "s1", ct: "AAAA" };
    await expect(unwrapEnvelope(envelope, alice.publicKey, bob.secretKey)).rejects.toThrow();
  });
});

describe("serializeEnvelope / deserializeEnvelope", () => {
  it("roundtrips through JSON", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const plaintext = new TextEncoder().encode("serialize test");

    const original = await wrapEnvelope(plaintext, "s1", bob.publicKey, alice.secretKey);
    const json = serializeEnvelope(original);
    const restored = deserializeEnvelope(json);

    expect(restored).toEqual(original);
  });

  it("deserializeEnvelope rejects invalid JSON", () => {
    expect(() => deserializeEnvelope("not json")).toThrow();
  });

  it("deserializeEnvelope rejects non-envelope objects", () => {
    expect(() => deserializeEnvelope('{"v":2,"sid":"s1","ct":"abc"}')).toThrow(
      "Invalid EncryptedEnvelope",
    );
  });
});

describe("isEncryptedEnvelope", () => {
  it("returns true for valid envelopes", () => {
    expect(isEncryptedEnvelope({ v: 1, sid: "s1", ct: "abc" })).toBe(true);
  });

  it("returns false for non-objects", () => {
    expect(isEncryptedEnvelope(null)).toBe(false);
    expect(isEncryptedEnvelope("string")).toBe(false);
    expect(isEncryptedEnvelope(42)).toBe(false);
  });

  it("returns false for wrong version", () => {
    expect(isEncryptedEnvelope({ v: 2, sid: "s1", ct: "abc" })).toBe(false);
  });

  it("returns false for missing fields", () => {
    expect(isEncryptedEnvelope({ v: 1, sid: "s1" })).toBe(false);
    expect(isEncryptedEnvelope({ v: 1, ct: "abc" })).toBe(false);
  });
});
