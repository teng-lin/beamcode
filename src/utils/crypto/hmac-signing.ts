/**
 * HMAC signing — integrity protection for control messages.
 *
 * Signs a structured input (requestId, behavior, updatedInput, timestamp, nonce)
 * using HMAC-SHA-512/256 from libsodium (crypto_auth).
 */

import { canonicalize } from "../../core/types/unified-message.js";
import { getSodium } from "./sodium-loader.js";

export interface HMACInput {
  requestId: string;
  behavior: string;
  updatedInput: unknown;
  timestamp: number;
  nonce: Uint8Array;
}

/** Build the canonical byte string from structured HMAC input. */
function buildMessage(input: HMACInput): Uint8Array {
  const hexNonce = Array.from(input.nonce)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const msg =
    input.requestId +
    input.behavior +
    canonicalize(input.updatedInput) +
    input.timestamp.toString() +
    hexNonce;

  return new TextEncoder().encode(msg);
}

/** Sign an HMACInput with a shared secret key (crypto_auth). */
export async function sign(secretKey: Uint8Array, input: HMACInput): Promise<Uint8Array> {
  const sodium = await getSodium();
  const message = buildMessage(input);
  return sodium.crypto_auth(message, secretKey);
}

/** Verify an HMAC signature against the expected input. */
export async function verify(
  secretKey: Uint8Array,
  signature: Uint8Array,
  input: HMACInput,
): Promise<boolean> {
  const sodium = await getSodium();
  const message = buildMessage(input);
  return sodium.crypto_auth_verify(signature, message, secretKey);
}

// ---------------------------------------------------------------------------
// NonceTracker — replay protection
// ---------------------------------------------------------------------------

/** Tracks recently seen nonces to prevent replay attacks. */
export class NonceTracker {
  private seen = new Map<string, number>();
  private readonly maxSize: number;
  private readonly windowMs: number;

  constructor(maxSize = 1000, windowMs = 30_000) {
    this.maxSize = maxSize;
    this.windowMs = windowMs;
  }

  /**
   * Record a nonce + timestamp.
   * Returns `true` if the nonce is fresh (not seen before and within the time window).
   * Returns `false` if duplicate or expired.
   */
  track(nonce: Uint8Array, timestamp: number): boolean {
    const now = Date.now();
    if (Math.abs(now - timestamp) > this.windowMs) return false;

    const key = Array.from(nonce)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (this.seen.has(key)) return false;

    // Evict oldest entries if at capacity
    if (this.seen.size >= this.maxSize) {
      const cutoff = now - this.windowMs;
      for (const [k, ts] of this.seen) {
        if (ts < cutoff) this.seen.delete(k);
      }
      // If still full after eviction, remove the oldest entry
      if (this.seen.size >= this.maxSize) {
        const oldest = this.seen.keys().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
    }

    this.seen.set(key, timestamp);
    return true;
  }
}
