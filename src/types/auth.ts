export type {
  AuthContext,
  Authenticator,
  ConsumerIdentity,
  ConsumerRole,
} from "../interfaces/auth.js";

import type { ConsumerIdentity } from "../interfaces/auth.js";

export function createAnonymousIdentity(index: number): ConsumerIdentity {
  return { userId: `anonymous-${index}`, displayName: `User ${index}`, role: "participant" };
}
