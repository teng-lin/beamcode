/**
 * EncryptedEnvelope — the wire format for E2E encrypted messages.
 *
 * Format: `{ v: 1, sid: string, ct: string }`
 * - `v` — protocol version (currently 1)
 * - `sid` — session ID (plaintext, for routing)
 * - `ct` — base64url-encoded ciphertext (nonce ‖ crypto_box output)
 *
 * The nonce is prepended to the ciphertext so only one field is needed
 * on the wire. Both sides know crypto_box_NONCEBYTES, so splitting is
 * deterministic.
 */

import { decrypt, encrypt, generateNonce } from "./crypto-box.js";
import { getSodium } from "./sodium-loader.js";

export interface EncryptedEnvelope {
  v: 1;
  sid: string;
  ct: string;
}

/**
 * Wrap a plaintext message into an EncryptedEnvelope.
 *
 * @param plaintext - The raw message bytes to encrypt
 * @param sessionId - Session ID for routing (included as plaintext)
 * @param theirPublicKey - Peer's X25519 public key
 * @param mySecretKey - Our X25519 secret key
 */
export async function wrapEnvelope(
  plaintext: Uint8Array,
  sessionId: string,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array,
): Promise<EncryptedEnvelope> {
  const sodium = await getSodium();
  const nonce = await generateNonce();
  const ciphertext = await encrypt(plaintext, nonce, theirPublicKey, mySecretKey);

  // Prepend nonce to ciphertext: nonce ‖ ciphertext
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce, 0);
  combined.set(ciphertext, nonce.length);

  const ct = sodium.to_base64(combined, sodium.base64_variants.URLSAFE_NO_PADDING);

  return { v: 1, sid: sessionId, ct };
}

/**
 * Unwrap an EncryptedEnvelope to recover the plaintext.
 *
 * @param envelope - The encrypted envelope to decrypt
 * @param theirPublicKey - Peer's X25519 public key
 * @param mySecretKey - Our X25519 secret key
 * @returns Decrypted plaintext bytes
 * @throws If decryption fails (tampered, wrong key, etc.)
 */
export async function unwrapEnvelope(
  envelope: EncryptedEnvelope,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array,
): Promise<Uint8Array> {
  if (envelope.v !== 1) {
    throw new Error(`Unsupported envelope version: ${envelope.v}`);
  }

  const sodium = await getSodium();
  const combined = sodium.from_base64(envelope.ct, sodium.base64_variants.URLSAFE_NO_PADDING);

  const nonceLen = sodium.crypto_box_NONCEBYTES;
  if (combined.length < nonceLen) {
    throw new Error("Invalid envelope: ciphertext too short");
  }

  const nonce = combined.slice(0, nonceLen);
  const ciphertext = combined.slice(nonceLen);

  return decrypt(ciphertext, nonce, theirPublicKey, mySecretKey);
}

/** Type guard for EncryptedEnvelope. */
export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.v === 1 && typeof obj.sid === "string" && typeof obj.ct === "string";
}

/** Serialize an EncryptedEnvelope to JSON string. */
export function serializeEnvelope(envelope: EncryptedEnvelope): string {
  return JSON.stringify(envelope);
}

/** Deserialize a JSON string to an EncryptedEnvelope. Throws on invalid input. */
export function deserializeEnvelope(json: string): EncryptedEnvelope {
  const parsed: unknown = JSON.parse(json);
  if (!isEncryptedEnvelope(parsed)) {
    throw new Error("Invalid EncryptedEnvelope format");
  }
  return parsed;
}
