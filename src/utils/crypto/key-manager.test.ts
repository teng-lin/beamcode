import { describe, expect, it } from "vitest";
import { destroyKey, fingerprintPublicKey, generateKeypair } from "./key-manager.js";

describe("key-manager", () => {
  it("generates a keypair with 32-byte keys", async () => {
    const kp = await generateKeypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(32);
  });

  it("generates distinct keypairs each call", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    expect(a.publicKey).not.toEqual(b.publicKey);
    expect(a.secretKey).not.toEqual(b.secretKey);
  });

  it("destroyKey zero-fills the secret key", async () => {
    const kp = await generateKeypair();
    // Ensure the key has non-zero bytes
    expect(kp.secretKey.some((b) => b !== 0)).toBe(true);

    destroyKey(kp.secretKey);

    expect(kp.secretKey.every((b) => b === 0)).toBe(true);
  });

  it("fingerprintPublicKey returns first 8 bytes as hex", async () => {
    const kp = await generateKeypair();
    const fp = fingerprintPublicKey(kp.publicKey);

    expect(fp.length).toBe(16); // 8 bytes × 2 hex chars
    expect(/^[0-9a-f]{16}$/.test(fp)).toBe(true);

    // Verify it matches the actual first 8 bytes
    const expected = Array.from(kp.publicKey.slice(0, 8))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(fp).toBe(expected);
  });
});
