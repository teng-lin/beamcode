/**
 * Metrics collection interface for observability and monitoring.
 * Allows tracking of key events, performance metrics, and errors.
 */

export interface MetricsEvent {
  timestamp: number; // Unix timestamp in milliseconds
  type: string;
  sessionId?: string;
  [key: string]: unknown;
}

/** Session lifecycle events */
export interface SessionCreatedEvent extends MetricsEvent {
  type: "session:created";
  sessionId: string;
}

export interface SessionClosedEvent extends MetricsEvent {
  type: "session:closed";
  sessionId: string;
  reason?: string;
}

/** Connection events */
export interface ConsumerConnectedEvent extends MetricsEvent {
  type: "consumer:connected";
  sessionId: string;
  userId: string;
}

export interface ConsumerDisconnectedEvent extends MetricsEvent {
  type: "consumer:disconnected";
  sessionId: string;
  userId: string;
}

export interface CLIConnectedEvent extends MetricsEvent {
  type: "cli:connected";
  sessionId: string;
}

export interface CLIDisconnectedEvent extends MetricsEvent {
  type: "cli:disconnected";
  sessionId: string;
}

/** Message events */
export interface MessageReceivedEvent extends MetricsEvent {
  type: "message:received";
  sessionId: string;
  source: "cli" | "consumer"; // Where message came from
  messageType?: string;
  bytes?: number;
}

export interface MessageSentEvent extends MetricsEvent {
  type: "message:sent";
  sessionId: string;
  target: "cli" | "consumer" | "broadcast"; // Where message goes
  messageType?: string;
  recipientCount?: number;
  bytes?: number;
}

export interface MessageDroppedEvent extends MetricsEvent {
  type: "message:dropped";
  sessionId: string;
  reason: string;
}

/** Error events */
export interface AuthenticationFailedEvent extends MetricsEvent {
  type: "auth:failed";
  sessionId: string;
  reason: string;
}

export interface SendFailedEvent extends MetricsEvent {
  type: "send:failed";
  sessionId: string;
  target: "cli" | "consumer";
  reason: string;
}

export interface ErrorEvent extends MetricsEvent {
  type: "error";
  sessionId?: string;
  source: string; // Component that emitted the error
  error: string;
  severity: "warning" | "error" | "critical";
}

/** Rate limiting events */
export interface RateLimitExceededEvent extends MetricsEvent {
  type: "ratelimit:exceeded";
  sessionId: string;
  source: "cli" | "consumer";
}

/** Performance events */
export interface LatencyEvent extends MetricsEvent {
  type: "latency";
  sessionId: string;
  operation: string; // e.g., "auth", "message_roundtrip"
  durationMs: number;
}

export interface QueueDepthEvent extends MetricsEvent {
  type: "queue:depth";
  sessionId: string;
  queueType: string; // e.g., "pending_messages", "pending_permissions"
  depth: number;
  maxCapacity?: number;
}

/** Union of all metrics events */
export type MetricsEventType =
  | SessionCreatedEvent
  | SessionClosedEvent
  | ConsumerConnectedEvent
  | ConsumerDisconnectedEvent
  | CLIConnectedEvent
  | CLIDisconnectedEvent
  | MessageReceivedEvent
  | MessageSentEvent
  | MessageDroppedEvent
  | AuthenticationFailedEvent
  | SendFailedEvent
  | ErrorEvent
  | RateLimitExceededEvent
  | LatencyEvent
  | QueueDepthEvent;

/**
 * Metrics collector interface.
 * Implementations can collect, aggregate, export metrics.
 */
export interface MetricsCollector {
  /**
   * Record a metrics event.
   */
  recordEvent(event: MetricsEventType): void;

  /**
   * Get current statistics (optional).
   */
  getStats?(options?: { sessionId?: string }): Record<string, unknown>;

  /**
   * Reset metrics (optional).
   */
  reset?(): void;
}
