/**
 * Key management — generate X25519 keypairs, securely destroy secrets,
 * and produce human-readable public-key fingerprints.
 */

import { getSodium } from "./sodium-loader.js";

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Generate a new X25519 keypair for box / sealed-box operations. */
export async function generateKeypair(): Promise<KeyPair> {
  const sodium = await getSodium();
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

/** Zero-fill a secret key, rendering it unusable. */
export function destroyKey(secretKey: Uint8Array): void {
  secretKey.fill(0);
}

/** First 8 bytes of a public key, encoded as lowercase hex. */
export function fingerprintPublicKey(pk: Uint8Array): string {
  const first8 = pk.slice(0, 8);
  return Array.from(first8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
