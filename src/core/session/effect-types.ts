/**
 * Effect — a typed description of a side effect to perform after a state transition.
 *
 * `reduceSessionData` returns `[SessionData, Effect[]]`. The caller
 * (SessionRuntime) executes each effect via `executeEffects()`.
 *
 * Most effects are plain data — no closures, no dependencies. This keeps
 * the reducer 100% pure and makes effects easy to assert in tests.
 *
 * Exception: `SEND_TO_CONSUMER` carries a `WebSocketLike` handle, which is
 * non-serializable. This is a deliberate pragmatic tradeoff — targeted error
 * delivery requires the specific socket. The handle is always available at the
 * call site (inbound command handler or signal enrichment), so the reducer
 * never needs to look it up.
 *
 * @module SessionControl
 */

import type { WebSocketLike } from "../../interfaces/transport.js";
import type { ConsumerMessage } from "../../types/consumer-messages.js";
import type { SessionState } from "../../types/session-state.js";
import type { UnifiedMessage } from "../types/unified-message.js";

export type Effect =
  /** Broadcast a consumer message to all connected consumers. */
  | { type: "BROADCAST"; message: ConsumerMessage }
  /** Broadcast a permission_request only to session participants (not observers). */
  | { type: "BROADCAST_TO_PARTICIPANTS"; message: ConsumerMessage }
  /** Broadcast a partial session state patch as a session_update. */
  | { type: "BROADCAST_SESSION_UPDATE"; patch: Partial<SessionState> }
  /** Emit a domain event (type + payload). */
  | { type: "EMIT_EVENT"; eventType: string; payload: unknown }
  /** Auto-send a queued message now that the session is idle. */
  | { type: "AUTO_SEND_QUEUED" }
  /** Send a pre-normalized UnifiedMessage to the backend (no-op if no backend session). */
  | { type: "SEND_TO_BACKEND"; message: UnifiedMessage }
  /** Flush state to disk immediately (for critical user-visible writes). */
  | { type: "PERSIST_NOW" }
  /** Resolve git info for the session (after seeding cwd). */
  | { type: "RESOLVE_GIT_INFO" }
  /** Send a targeted message to a specific consumer WebSocket. */
  | { type: "SEND_TO_CONSUMER"; ws: WebSocketLike; message: ConsumerMessage }
  /** Emit a translation event for message flow panel visualization (dev tool). */
  | { type: "EMIT_TRANSLATION"; event: ConsumerMessage };
