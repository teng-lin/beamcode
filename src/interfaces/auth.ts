/**
 * Authentication and identity types for consumer WebSocket connections.
 *
 * Consumers authenticate when connecting to a session. The {@link Authenticator}
 * interface is pluggable — callers can supply their own implementation or rely on
 * the built-in anonymous identity fallback.
 * @module
 */

/** Whether a consumer can send messages ("participant") or only observe ("observer"). */
export type ConsumerRole = "participant" | "observer";

/** Identity assigned to a connected consumer after authentication. */
export interface ConsumerIdentity {
  userId: string;
  displayName: string;
  role: ConsumerRole;
}

/** Transport-agnostic connection metadata. Adapters populate `transport` with runtime-specific details. */
export interface AuthContext {
  /** The session the consumer is connecting to. */
  sessionId: string;
  /**
   * Transport-specific metadata bag. For Node.js ws adapter:
   * - headers: Record<string, string>
   * - query: Record<string, string>
   * - remoteAddress?: string
   *
   * Custom adapters may populate different fields.
   */
  transport: Record<string, unknown>;
}

/**
 * Pluggable authenticator for consumer connections.
 * Return ConsumerIdentity to accept the connection, throw to reject.
 */
export interface Authenticator {
  authenticate(context: AuthContext): Promise<ConsumerIdentity>;
}
