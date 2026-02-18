/**
 * InvertedConnectionAdapter — sub-interface for backends where the CLI
 * connects *back* to us (e.g. SdkUrl launched with --sdk-url).
 *
 * Only adapters using an inverted connection pattern implement this.
 * Use the `isInvertedConnectionAdapter` type guard to check.
 */

import type WebSocket from "ws";
import type { BackendAdapter } from "./backend-adapter.js";

export interface InvertedConnectionAdapter extends BackendAdapter {
  /** Deliver a WebSocket that connected back for the given session. Returns true if matched. */
  deliverSocket(sessionId: string, ws: WebSocket): boolean;
  /** Cancel a pending socket registration (e.g. on timeout or session teardown). */
  cancelPending(sessionId: string): void;
}

export function isInvertedConnectionAdapter(
  adapter: BackendAdapter,
): adapter is InvertedConnectionAdapter {
  return (
    "deliverSocket" in adapter &&
    typeof (adapter as unknown as InvertedConnectionAdapter).deliverSocket === "function"
  );
}
