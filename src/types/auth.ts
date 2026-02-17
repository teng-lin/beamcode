export type {
  AuthContext,
  Authenticator,
  ConsumerIdentity,
  ConsumerRole,
} from "../interfaces/auth.js";

import type { ConsumerIdentity } from "../interfaces/auth.js";

/**
 * Create an anonymous identity with participant role.
 * Note: Observer mode is inert without a configured Authenticator —
 * anonymous identities always receive "participant" role.
 */
export function createAnonymousIdentity(index: number): ConsumerIdentity {
  return { userId: `anonymous-${index}`, displayName: `User ${index}`, role: "participant" };
}
