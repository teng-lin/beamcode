import { describe, expect, it } from "vitest";
import { decrypt, encrypt, generateNonce } from "./crypto-box.js";
import { generateKeypair } from "./key-manager.js";

describe("crypto-box", () => {
  it("roundtrips: encrypt → decrypt recovers plaintext", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const nonce = await generateNonce();
    const plaintext = new TextEncoder().encode("authenticated message");

    const ciphertext = await encrypt(plaintext, nonce, bob.publicKey, alice.secretKey);
    const decrypted = await decrypt(ciphertext, nonce, alice.publicKey, bob.secretKey);

    expect(decrypted).toEqual(plaintext);
  });

  it("rejects tampered ciphertext", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const nonce = await generateNonce();
    const plaintext = new TextEncoder().encode("tamper test");

    const ciphertext = await encrypt(plaintext, nonce, bob.publicKey, alice.secretKey);
    ciphertext[ciphertext.length - 1] ^= 0xff;

    await expect(decrypt(ciphertext, nonce, alice.publicKey, bob.secretKey)).rejects.toThrow();
  });

  it("rejects decryption with wrong key", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const eve = await generateKeypair();
    const nonce = await generateNonce();
    const plaintext = new TextEncoder().encode("wrong key test");

    const ciphertext = await encrypt(plaintext, nonce, bob.publicKey, alice.secretKey);

    await expect(decrypt(ciphertext, nonce, eve.publicKey, bob.secretKey)).rejects.toThrow();
  });

  it("generateNonce produces 24-byte nonces", async () => {
    const nonce = await generateNonce();
    expect(nonce).toBeInstanceOf(Uint8Array);
    expect(nonce.length).toBe(24);
  });

  it("generateNonce produces unique nonces", async () => {
    const a = await generateNonce();
    const b = await generateNonce();
    expect(a).not.toEqual(b);
  });
});
