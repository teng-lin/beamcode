import type { InboundMessage } from "../../types/inbound-messages.js";

/**
 * Requests that flow into SessionRuntime from transports/programmatic callers.
 * Kept structurally equivalent to the consumer protocol for now.
 */
export type InboundCommand = InboundMessage;

/**
 * Advisory commands emitted by policy services and handled by SessionRuntime.
 */
export type PolicyCommand =
  | { type: "reconnect_timeout" }
  | { type: "idle_reap" }
  | { type: "capabilities_timeout" };
