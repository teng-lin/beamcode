/**
 * Sealed box — anonymous sender encryption.
 *
 * Used ONLY during the pairing handshake: the consumer encrypts a message
 * to the daemon's public key without revealing its own identity.
 */

import { getSodium } from "./sodium-loader.js";

/** Encrypt a message so only `recipientPublicKey` can open it. */
export async function seal(
  message: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.crypto_box_seal(message, recipientPublicKey);
}

/** Decrypt a sealed-box ciphertext using the recipient's keypair. */
export async function sealOpen(
  ciphertext: Uint8Array,
  publicKey: Uint8Array,
  secretKey: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.crypto_box_seal_open(ciphertext, publicKey, secretKey);
}
