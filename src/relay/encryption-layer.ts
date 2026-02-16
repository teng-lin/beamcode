/**
 * EncryptionLayer — middleware that transparently encrypts/decrypts messages
 * between the SessionBridge and the WebSocket transport.
 *
 * Outbound: ConsumerMessage → serialize → encrypt → EncryptedEnvelope
 * Inbound:  EncryptedEnvelope → decrypt → deserialize → InboundMessage
 *
 * Plugs in between the bridge and WebSocket without requiring bridge changes.
 */

import type { ConsumerMessage } from "../types/consumer-messages.js";
import type { InboundMessage } from "../types/inbound-messages.js";
import {
  deserializeEnvelope,
  isEncryptedEnvelope,
  serializeEnvelope,
  unwrapEnvelope,
  wrapEnvelope,
} from "../utils/crypto/encrypted-envelope.js";
import type { KeyPair } from "../utils/crypto/key-manager.js";

export interface EncryptionLayerOptions {
  /** Our keypair (daemon or consumer side). */
  keypair: KeyPair;
  /** The peer's public key (established during pairing). */
  peerPublicKey: Uint8Array;
  /** Session ID for the envelope routing field. */
  sessionId: string;
}

export class EncryptionLayer {
  private keypair: KeyPair;
  private peerPublicKey: Uint8Array;
  private sessionId: string;
  private active = true;

  constructor(options: EncryptionLayerOptions) {
    this.keypair = options.keypair;
    this.peerPublicKey = options.peerPublicKey;
    this.sessionId = options.sessionId;
  }

  /** Whether the encryption layer is active. */
  isActive(): boolean {
    return this.active;
  }

  /** Deactivate the encryption layer (e.g., after revocation). */
  deactivate(): void {
    this.active = false;
  }

  /** Update the peer's public key (e.g., after re-pairing). */
  updatePeerKey(peerPublicKey: Uint8Array): void {
    this.peerPublicKey = peerPublicKey;
    this.active = true;
  }

  /**
   * Encrypt an outbound ConsumerMessage into a serialized EncryptedEnvelope.
   *
   * @returns JSON string of the EncryptedEnvelope, ready for ws.send()
   * @throws If encryption layer is deactivated
   */
  async encryptOutbound(message: ConsumerMessage): Promise<string> {
    if (!this.active) {
      throw new Error("Encryption layer is deactivated");
    }

    const plaintext = new TextEncoder().encode(JSON.stringify(message));
    const envelope = await wrapEnvelope(
      plaintext,
      this.sessionId,
      this.peerPublicKey,
      this.keypair.secretKey,
    );
    return serializeEnvelope(envelope);
  }

  /**
   * Decrypt an inbound message (raw WebSocket data) into an InboundMessage.
   *
   * @param data - Raw WebSocket message (string or Buffer)
   * @returns Decrypted and parsed InboundMessage
   * @throws If decryption or parsing fails
   */
  async decryptInbound(data: string | Buffer): Promise<InboundMessage> {
    if (!this.active) {
      throw new Error("Encryption layer is deactivated");
    }

    const raw = typeof data === "string" ? data : data.toString("utf-8");
    const envelope = deserializeEnvelope(raw);
    const plaintext = await unwrapEnvelope(envelope, this.peerPublicKey, this.keypair.secretKey);
    const json = new TextDecoder().decode(plaintext);
    return JSON.parse(json) as InboundMessage;
  }

  /**
   * Try to detect if a raw message is an encrypted envelope.
   * Useful for mixed-mode operation during pairing transition.
   */
  static isEncrypted(data: string | Buffer): boolean {
    const raw = typeof data === "string" ? data : data.toString("utf-8");
    try {
      const parsed: unknown = JSON.parse(raw);
      return isEncryptedEnvelope(parsed);
    } catch {
      return false;
    }
  }
}
