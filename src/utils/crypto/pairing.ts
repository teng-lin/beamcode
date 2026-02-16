/**
 * PairingManager — pairing link generation, consumption, and revocation.
 *
 * Implements the pairing handshake:
 * 1. Daemon generates X25519 keypair and publishes pairing link
 * 2. Link expires after 60s (server-side enforcement)
 * 3. Consumer opens link, extracts daemon public key
 * 4. Consumer generates own keypair, seals its public key with daemon's pk
 * 5. Daemon unseals consumer's public key → both switch to crypto_box
 * 6. Link is invalidated (one-time use)
 */

import type { KeyPair } from "./key-manager.js";
import { destroyKey, fingerprintPublicKey, generateKeypair } from "./key-manager.js";
import { seal, sealOpen } from "./sealed-box.js";
import { getSodium } from "./sodium-loader.js";

export interface PairingLink {
  link: string;
  expiresAt: number;
}

export interface PairingResult {
  success: boolean;
  peerPublicKey?: Uint8Array;
}

const PAIRING_TTL_MS = 60_000;

export class PairingManager {
  private keypair: KeyPair | null = null;
  private peerPublicKey: Uint8Array | null = null;
  private expiresAt = 0;
  private paired = false;
  private pairingInProgress = false;

  /** Generate a new keypair and pairing link. Invalidates any prior pairing. */
  async generatePairingLink(tunnelUrl: string): Promise<PairingLink> {
    // Destroy old secret key if present
    if (this.keypair) {
      destroyKey(this.keypair.secretKey);
    }

    this.keypair = await generateKeypair();
    this.peerPublicKey = null;
    this.paired = false;
    this.pairingInProgress = false;
    this.expiresAt = Date.now() + PAIRING_TTL_MS;

    const sodium = await getSodium();
    const pkBase64url = sodium.to_base64(
      this.keypair.publicKey,
      sodium.base64_variants.URLSAFE_NO_PADDING,
    );
    const fp = fingerprintPublicKey(this.keypair.publicKey);

    // Strip trailing slash from tunnel URL
    const base = tunnelUrl.replace(/\/+$/, "");
    const link = `${base}/pair?pk=${pkBase64url}&fp=${fp}&v=1`;

    return { link, expiresAt: this.expiresAt };
  }

  /**
   * Handle an incoming pairing request containing the consumer's sealed public key.
   *
   * Server-side enforcement:
   * - Rejects if link is expired (>60s)
   * - Rejects if already paired (one-time use)
   * - Rejects if no keypair has been generated
   */
  async handlePairingRequest(sealedPublicKey: Uint8Array): Promise<PairingResult> {
    if (!this.keypair) {
      return { success: false };
    }

    if (this.isExpired()) {
      return { success: false };
    }

    if (this.paired || this.pairingInProgress) {
      return { success: false };
    }

    // Set guard before any async work to prevent concurrent pairing
    this.pairingInProgress = true;

    try {
      const peerPk = await sealOpen(
        sealedPublicKey,
        this.keypair.publicKey,
        this.keypair.secretKey,
      );

      // Validate that the unsealed value is a 32-byte X25519 public key
      if (peerPk.length !== 32) {
        return { success: false };
      }

      this.peerPublicKey = peerPk;
      this.paired = true;
      return { success: true, peerPublicKey: peerPk };
    } catch {
      this.pairingInProgress = false;
      return { success: false };
    }
  }

  /** Whether the pairing link has expired. */
  isExpired(): boolean {
    return Date.now() > this.expiresAt;
  }

  /** Whether a consumer has successfully paired. */
  isPaired(): boolean {
    return this.paired;
  }

  /** Get the local keypair (null if not generated). */
  getKeypair(): KeyPair | null {
    return this.keypair;
  }

  /** Get the peer's public key (null if not paired). */
  getPeerPublicKey(): Uint8Array | null {
    return this.peerPublicKey;
  }

  /**
   * Revoke the current pairing. Destroys the old keypair and generates
   * a fresh one, requiring the consumer to re-pair.
   */
  async revoke(): Promise<void> {
    if (this.keypair) {
      destroyKey(this.keypair.secretKey);
    }
    this.keypair = await generateKeypair();
    this.peerPublicKey = null;
    this.paired = false;
    this.pairingInProgress = false;
    this.expiresAt = 0;
  }
}

// ── Utility: parse pairing link on the consumer side ──

export interface ParsedPairingLink {
  publicKey: Uint8Array;
  fingerprint: string;
  version: number;
}

/** Parse a pairing link URL and extract the daemon's public key. */
export async function parsePairingLink(link: string): Promise<ParsedPairingLink> {
  const url = new URL(link);
  const pkParam = url.searchParams.get("pk");
  const fpParam = url.searchParams.get("fp");
  const vParam = url.searchParams.get("v");

  if (!pkParam || !fpParam || !vParam) {
    throw new Error("Invalid pairing link: missing required parameters");
  }

  const sodium = await getSodium();
  const publicKey = sodium.from_base64(pkParam, sodium.base64_variants.URLSAFE_NO_PADDING);

  if (publicKey.length !== 32) {
    throw new Error("Invalid pairing link: public key must be 32 bytes");
  }

  return {
    publicKey,
    fingerprint: fpParam,
    version: Number.parseInt(vParam, 10),
  };
}

/**
 * Consumer-side: seal our public key for the daemon and return the sealed bytes.
 * The consumer calls this after generating its own keypair.
 */
export async function sealPublicKeyForPairing(
  consumerPublicKey: Uint8Array,
  daemonPublicKey: Uint8Array,
): Promise<Uint8Array> {
  return seal(consumerPublicKey, daemonPublicKey);
}
