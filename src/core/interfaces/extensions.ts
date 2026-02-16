/**
 * Extension interfaces — additive capabilities that adapters MAY implement.
 *
 * Consumers check for support via runtime type narrowing:
 *   if ("interrupt" in session) { session.interrupt(); }
 *
 * Extensions are grouped into two tiers:
 * 1. Core extensions — useful now (Phase 0-1).
 * 2. Relay extensions — needed for Phase 2 relay infrastructure.
 */

import type { UnifiedMessage } from "../types/unified-message.js";

// ---------------------------------------------------------------------------
// Core extensions (Phase 0-1)
// ---------------------------------------------------------------------------

/** The session can cancel in-flight work. */
export interface Interruptible {
  interrupt(): void;
}

/** The session supports runtime configuration changes. */
export interface Configurable {
  setModel(model: string): void;
  setPermissionMode(mode: string): void;
}

/** The session can surface and resolve permission requests. */
export interface PermissionHandler {
  /** Incoming permission requests as an async iterable. */
  readonly permissionRequests: AsyncIterable<PermissionRequestEvent>;
  /** Respond to a pending permission request. */
  respondToPermission(requestId: string, behavior: "allow" | "deny"): void;
}

/** A permission request surfaced by the backend. */
export interface PermissionRequestEvent {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
}

// ---------------------------------------------------------------------------
// Relay extensions (Phase 2 — defined now, implemented later)
// ---------------------------------------------------------------------------

/** The session can recover from disconnections. */
export interface Reconnectable {
  /** Register a callback for disconnect events. */
  onDisconnect(callback: () => void): void;
  /** Replay messages from a given sequence number. */
  replay(fromSeq: number): AsyncIterable<UnifiedMessage>;
}

/** Encrypted message envelope for end-to-end encryption. */
export interface EncryptedEnvelope {
  /** Ciphertext (base64). */
  ciphertext: string;
  /** Initialization vector (base64). */
  iv: string;
  /** Algorithm used. */
  algorithm: string;
}

/** The session supports end-to-end encryption. */
export interface Encryptable {
  encrypt(message: UnifiedMessage): EncryptedEnvelope;
  decrypt(envelope: EncryptedEnvelope): UnifiedMessage;
}
