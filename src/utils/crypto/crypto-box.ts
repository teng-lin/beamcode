/**
 * Crypto box — authenticated public-key encryption.
 *
 * Used for ALL post-pairing messages between consumer and daemon.
 * Both parties prove their identity via their keypair.
 */

import { getSodium } from "./sodium-loader.js";

/** Encrypt a message with authenticated encryption (crypto_box). */
export async function encrypt(
  message: Uint8Array,
  nonce: Uint8Array,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.crypto_box_easy(message, nonce, theirPublicKey, mySecretKey);
}

/** Decrypt a crypto_box ciphertext. Throws if authentication fails. */
export async function decrypt(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.crypto_box_open_easy(ciphertext, nonce, theirPublicKey, mySecretKey);
}

/** Generate a random nonce suitable for crypto_box. */
export async function generateNonce(): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
}
