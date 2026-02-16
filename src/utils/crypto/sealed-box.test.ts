import { describe, expect, it } from "vitest";
import { generateKeypair } from "./key-manager.js";
import { seal, sealOpen } from "./sealed-box.js";

describe("sealed-box", () => {
  it("roundtrips: seal → sealOpen recovers plaintext", async () => {
    const kp = await generateKeypair();
    const plaintext = new TextEncoder().encode("hello from pairing handshake");

    const ciphertext = await seal(plaintext, kp.publicKey);
    const decrypted = await sealOpen(ciphertext, kp.publicKey, kp.secretKey);

    expect(decrypted).toEqual(plaintext);
  });

  it("rejects tampered ciphertext", async () => {
    const kp = await generateKeypair();
    const plaintext = new TextEncoder().encode("tamper test");

    const ciphertext = await seal(plaintext, kp.publicKey);
    // Flip a byte in the middle of the ciphertext
    ciphertext[ciphertext.length - 1] ^= 0xff;

    await expect(sealOpen(ciphertext, kp.publicKey, kp.secretKey)).rejects.toThrow();
  });

  it("rejects decryption with wrong key", async () => {
    const sender = await generateKeypair();
    const wrongRecipient = await generateKeypair();
    const plaintext = new TextEncoder().encode("wrong key test");

    const ciphertext = await seal(plaintext, sender.publicKey);

    await expect(
      sealOpen(ciphertext, wrongRecipient.publicKey, wrongRecipient.secretKey),
    ).rejects.toThrow();
  });
});
