/**
 * SessionRuntimeShadow — shadow lifecycle state machine for parity validation.
 *
 * Runs alongside the legacy SessionBridge in `vnext_shadow` mode, tracking
 * lifecycle transitions (starting → awaiting_backend → active → idle → …)
 * from inbound messages, backend messages, and control signals. Provides
 * snapshots for parity comparison against the legacy runtime path.
 *
 * @module SessionControl
 */

import type { InboundMessage } from "../types/inbound-messages.js";
import type { UnifiedMessage, UnifiedMessageType } from "./types/unified-message.js";

export const SHADOW_LIFECYCLE_STATES = [
  "starting",
  "awaiting_backend",
  "active",
  "idle",
  "degraded",
  "closing",
  "closed",
] as const;

export type ShadowLifecycleState = (typeof SHADOW_LIFECYCLE_STATES)[number];

export type ShadowBackendSignal =
  | "session_created"
  | "backend_connected"
  | "backend_disconnected"
  | "closing"
  | "closed";

export interface SessionRuntimeShadowSnapshot {
  sessionId: string;
  lifecycle: ShadowLifecycleState;
  processedInboundCount: number;
  processedBackendCount: number;
  processedSignalCount: number;
  lastInboundType: InboundMessage["type"] | null;
  lastBackendType: UnifiedMessageType | null;
  lastSignal: ShadowBackendSignal | null;
  lastTransitionAt: number;
}

function transitionOnSignal(
  current: ShadowLifecycleState,
  signal: ShadowBackendSignal,
): ShadowLifecycleState {
  if (signal === "closed") return "closed";
  if (signal === "closing") return current === "closed" ? "closed" : "closing";
  if (signal === "session_created") {
    return current === "starting" ? "awaiting_backend" : current;
  }
  if (signal === "backend_connected") {
    if (current === "closed" || current === "closing") return current;
    return "active";
  }
  if (signal === "backend_disconnected") {
    if (current === "closed" || current === "closing") return current;
    return "degraded";
  }
  return current;
}

function transitionOnInbound(
  current: ShadowLifecycleState,
  inboundType: InboundMessage["type"],
): ShadowLifecycleState {
  if (current === "closed" || current === "closing") return current;

  // Mirrors legacy optimistic running behavior on user input.
  if (inboundType === "user_message") {
    if (current === "idle") return "active";
    return current;
  }

  return current;
}

function transitionOnBackendMessage(
  current: ShadowLifecycleState,
  msg: UnifiedMessage,
): ShadowLifecycleState {
  if (current === "closed" || current === "closing") return current;

  if (msg.type === "status_change") {
    const status = typeof msg.metadata.status === "string" ? msg.metadata.status : null;
    if (status === "idle") return "idle";
    if (status === "running" || status === "compacting") return "active";
    return current;
  }

  if (msg.type === "result") {
    return "idle";
  }

  if (msg.type === "stream_event") {
    const event = msg.metadata.event as { type?: unknown } | undefined;
    if (event?.type === "message_start" && !msg.metadata.parent_tool_use_id) {
      return "active";
    }
    return current;
  }

  if (msg.type === "assistant" || msg.type === "tool_progress" || msg.type === "tool_use_summary") {
    if (current === "degraded" || current === "awaiting_backend") return "active";
  }

  return current;
}

export class SessionRuntimeShadow {
  private lifecycle: ShadowLifecycleState = "starting";
  private processedInboundCount = 0;
  private processedBackendCount = 0;
  private processedSignalCount = 0;
  private lastInboundType: InboundMessage["type"] | null = null;
  private lastBackendType: UnifiedMessageType | null = null;
  private lastSignal: ShadowBackendSignal | null = null;
  private lastTransitionAt = Date.now();

  constructor(private readonly sessionId: string) {}

  handleInbound(type: InboundMessage["type"]): void {
    this.processedInboundCount += 1;
    this.lastInboundType = type;
    this.lifecycle = transitionOnInbound(this.lifecycle, type);
    this.lastTransitionAt = Date.now();
  }

  handleBackendMessage(msg: UnifiedMessage): void {
    this.processedBackendCount += 1;
    this.lastBackendType = msg.type;
    this.lifecycle = transitionOnBackendMessage(this.lifecycle, msg);
    this.lastTransitionAt = Date.now();
  }

  handleSignal(signal: ShadowBackendSignal): void {
    this.processedSignalCount += 1;
    this.lastSignal = signal;
    this.lifecycle = transitionOnSignal(this.lifecycle, signal);
    this.lastTransitionAt = Date.now();
  }

  snapshot(): SessionRuntimeShadowSnapshot {
    return {
      sessionId: this.sessionId,
      lifecycle: this.lifecycle,
      processedInboundCount: this.processedInboundCount,
      processedBackendCount: this.processedBackendCount,
      processedSignalCount: this.processedSignalCount,
      lastInboundType: this.lastInboundType,
      lastBackendType: this.lastBackendType,
      lastSignal: this.lastSignal,
      lastTransitionAt: this.lastTransitionAt,
    };
  }
}
