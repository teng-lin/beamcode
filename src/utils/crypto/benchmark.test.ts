import { describe, expect, it } from "vitest";
import { decrypt, encrypt, generateNonce } from "./crypto-box.js";
import { generateKeypair } from "./key-manager.js";

describe("crypto benchmark", () => {
  it("encrypt/decrypt completes in < 5ms per message", async () => {
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    const plaintext = new TextEncoder().encode("benchmark payload — typical message size");

    const iterations = 100;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      const nonce = await generateNonce();
      const ct = await encrypt(plaintext, nonce, bob.publicKey, alice.secretKey);
      await decrypt(ct, nonce, alice.publicKey, bob.secretKey);
    }

    const elapsed = performance.now() - start;
    const perMessage = elapsed / iterations;

    // Log for visibility in test output
    console.log(
      `  encrypt+decrypt: ${perMessage.toFixed(2)}ms per message (${iterations} iterations)`,
    );
    expect(perMessage).toBeLessThan(5);
  });
});
