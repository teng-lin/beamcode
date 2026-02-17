/**
 * ConsumerGatekeeper — extracted from SessionBridge (Phase 3).
 *
 * Handles consumer authentication, RBAC, and rate limiting.
 * Does NOT orchestrate acceptConsumer (that stays on the bridge).
 */

import { TokenBucketLimiter } from "../adapters/token-bucket-limiter.js";
import type { AuthContext, Authenticator, ConsumerIdentity } from "../interfaces/auth.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import { createAnonymousIdentity } from "../types/auth.js";
import type { ResolvedConfig } from "../types/config.js";
import type { Session } from "./session-store.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Message types that require participant role (observers cannot send these). */
export const PARTICIPANT_ONLY_TYPES = new Set([
  "user_message",
  "permission_response",
  "interrupt",
  "set_model",
  "set_permission_mode",
  "slash_command",
  "set_adapter",
  "queue_message",
  "update_queued_message",
  "cancel_queued_message",
]);

// ─── ConsumerGatekeeper ──────────────────────────────────────────────────────

export class ConsumerGatekeeper {
  private authenticator: Authenticator | null;
  private config: ResolvedConfig;
  private pendingAuth = new WeakSet<WebSocketLike>();

  constructor(authenticator: Authenticator | null, config: ResolvedConfig) {
    this.authenticator = authenticator;
    this.config = config;
  }

  /** Whether an authenticator is configured. */
  hasAuthenticator(): boolean {
    return this.authenticator !== null;
  }

  /** Create an anonymous identity (for use when no authenticator is configured). */
  createAnonymousIdentity(index: number): ConsumerIdentity {
    return createAnonymousIdentity(index);
  }

  /**
   * Start async authentication. Returns a promise that resolves to the identity.
   *
   * Throws synchronously if the authenticator.authenticate() call throws synchronously.
   * The returned promise resolves to null if the socket was closed during auth.
   */
  authenticateAsync(ws: WebSocketLike, context: AuthContext): Promise<ConsumerIdentity | null> {
    if (!this.authenticator) {
      throw new Error("authenticateAsync requires an authenticator");
    }

    this.pendingAuth.add(ws);

    let authPromise: Promise<ConsumerIdentity>;
    try {
      authPromise = this.authenticator.authenticate(context);
    } catch (err) {
      this.pendingAuth.delete(ws);
      throw err; // Re-throw synchronously
    }

    // Race against auth timeout to prevent hanging connections
    const timeoutMs = this.config.authTimeoutMs;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("Authentication timed out")), timeoutMs);
    });

    const cleanup = (): boolean => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      return this.pendingAuth.delete(ws);
    };

    return Promise.race([authPromise, timeout])
      .then((identity) => {
        if (!cleanup()) return null; // socket closed during auth
        return identity;
      })
      .catch((err) => {
        if (!cleanup()) return null; // socket closed during auth
        throw err;
      });
  }

  /** Cancel pending authentication (e.g., when socket closes). */
  cancelPendingAuth(ws: WebSocketLike): void {
    this.pendingAuth.delete(ws);
  }

  /** Check if a socket is still authenticating. */
  isAuthenticated(ws: WebSocketLike): boolean {
    return !this.pendingAuth.has(ws);
  }

  /** Check if a consumer with given role can send a given message type. */
  authorize(identity: ConsumerIdentity, messageType: string): boolean {
    return identity.role !== "observer" || !PARTICIPANT_ONLY_TYPES.has(messageType);
  }

  /** Check rate limit for a consumer. Returns true if allowed, false if exceeded. */
  checkRateLimit(ws: WebSocketLike, session: Session): boolean {
    let limiter = session.consumerRateLimiters.get(ws);
    if (!limiter) {
      const rateConfig = this.config.consumerMessageRateLimit ?? {
        burstSize: 20,
        tokensPerSecond: 50,
      };
      limiter = new TokenBucketLimiter(rateConfig.burstSize, 1000, rateConfig.tokensPerSecond);
      session.consumerRateLimiters.set(ws, limiter);
    }
    return limiter.tryConsume();
  }
}
