export type ConsumerRole = "participant" | "observer";

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
