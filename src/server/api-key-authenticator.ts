import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthContext, Authenticator, ConsumerIdentity } from "../interfaces/auth.js";

/**
 * Authenticator that validates an API key from the WebSocket query params.
 * Used to enforce authentication on consumer connections when a tunnel is active,
 * since tunnel-forwarded requests bypass bind-address and origin checks.
 *
 * Consumers connect with `?token=<apiKey>` on the WebSocket URL.
 */
export class ApiKeyAuthenticator implements Authenticator {
  private readonly keyHash: Buffer;

  constructor(apiKey: string) {
    this.keyHash = createHash("sha256").update(apiKey).digest();
  }

  async authenticate(context: AuthContext): Promise<ConsumerIdentity> {
    const query = context.transport.query;
    if (!query || typeof query !== "object") {
      throw new Error("Authentication required: missing token query parameter");
    }

    const token = (query as Record<string, unknown>).token;
    if (typeof token !== "string" || !token) {
      throw new Error("Authentication required: missing token query parameter");
    }

    const providedHash = createHash("sha256").update(token).digest();
    if (!timingSafeEqual(providedHash, this.keyHash)) {
      throw new Error("Authentication failed: invalid token");
    }

    return {
      userId: "api-key-user",
      displayName: "Authenticated User",
      role: "participant",
    };
  }
}
