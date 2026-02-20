/**
 * MessageTracer — debug tracing for message flows across translation boundaries.
 *
 * When enabled via `--trace`, emits NDJSON trace events to stderr showing every
 * send, receive, and translation boundary crossing. When disabled, the `noopTracer`
 * has zero overhead.
 */

import { randomUUID } from "node:crypto";
import { diffObjects } from "./trace-differ.js";

// ─── Types ──────────────────────────────────────────────────────────────────────

export type TraceLevel = "smart" | "headers" | "full";
export type TraceOutcome =
  | "success"
  | "empty_result"
  | "unmapped_type"
  | "parse_error"
  | "intercepted_user_echo"
  | "backend_error";

export interface TraceEvent {
  trace: true;
  traceId: string;
  parentTraceId?: string;
  layer: "frontend" | "bridge" | "backend";
  direction: "send" | "recv" | "translate";
  messageType: string;
  sessionId?: string;
  seq?: number;
  ts: string;
  elapsed_ms: number;
  size_bytes?: number;
  body?: unknown;
  from?: { format: string; body: unknown };
  to?: { format: string; body: unknown };
  diff?: string[];
  translator?: string;
  boundary?: string;
  error?: string;
  zodErrors?: unknown[];
  action?: string;
  requestId?: string;
  command?: string;
  phase?: string;
  outcome?: TraceOutcome;
}

export interface TraceSummary {
  totalTraces: number;
  complete: number;
  stale: number;
  errors: number;
  avgRoundTripMs: number;
}

export interface TraceOpts {
  sessionId?: string;
  traceId?: string;
  parentTraceId?: string;
  requestId?: string;
  command?: string;
  phase?: string;
  outcome?: TraceOutcome;
}

export interface TraceErrorOpts extends TraceOpts {
  zodErrors?: unknown[];
  action?: string;
}

/** Lightweight context bag carried through a single message flow. */
export interface TraceContext {
  traceId?: string;
  requestId?: string;
  command?: string;
}

/**
 * Extract trace correlation fields from a UnifiedMessage's metadata.
 * Shared across all adapter session classes to avoid duplicating
 * the same typeof-guarded extraction logic.
 */
export function extractTraceContext(metadata: Record<string, unknown>): TraceContext {
  return {
    traceId: typeof metadata.trace_id === "string" ? metadata.trace_id : undefined,
    requestId:
      typeof metadata.slash_request_id === "string" ? metadata.slash_request_id : undefined,
    command: typeof metadata.slash_command === "string" ? metadata.slash_command : undefined,
  };
}

// ─── Sensitive key redaction ────────────────────────────────────────────────────

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "api_key",
  "apikey",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "password",
  "credential",
  "private_key",
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

/** Redact sensitive keys only (used by "full" level without allowSensitive). */
function redact(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = redact(value);
    }
  }
  return result;
}

// ─── Smart sanitize (single-pass redact + truncate) ─────────────────────────────

/** Single-pass redaction + truncation for "smart" level. */
function smartSanitize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    if (obj.length > 200) {
      const sizeKb = (obj.length / 1024).toFixed(1);
      return `${obj.slice(0, 200)}...[${sizeKb}KB]`;
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    // Detect message_history-like arrays (array of objects with role/content)
    if (
      obj.length > 3 &&
      obj.every(
        (item) => typeof item === "object" && item !== null && ("role" in item || "type" in item),
      )
    ) {
      return `[${obj.length} messages]`;
    }
    return obj.map(smartSanitize);
  }
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = "[REDACTED]";
      } else if (key === "data" && typeof value === "string" && value.length > 1000) {
        const sizeKb = (value.length / 1024).toFixed(0);
        result[key] = `[image ${sizeKb}KB]`;
      } else if (key === "message_history" && Array.isArray(value)) {
        result[key] = `[${value.length} messages]`;
      } else {
        result[key] = smartSanitize(value);
      }
    }
    return result;
  }
  return obj;
}

// ─── MessageTracer interface ────────────────────────────────────────────────────

export interface MessageTracer {
  send(layer: TraceEvent["layer"], messageType: string, body: unknown, opts?: TraceOpts): void;

  recv(layer: TraceEvent["layer"], messageType: string, body: unknown, opts?: TraceOpts): void;

  translate(
    translator: string,
    boundary: string,
    from: { format: string; body: unknown },
    to: { format: string; body: unknown },
    opts?: TraceOpts,
  ): void;

  error(
    layer: TraceEvent["layer"],
    messageType: string,
    error: string,
    opts?: TraceErrorOpts,
  ): void;

  summary(sessionId: string): TraceSummary;

  /** Clean up resources (timers, etc.). Call during graceful shutdown. */
  destroy(): void;
}

// ─── Noop implementation ────────────────────────────────────────────────────────

export const noopTracer: MessageTracer = {
  send() {},
  recv() {},
  translate() {},
  error() {},
  summary() {
    return {
      totalTraces: 0,
      complete: 0,
      stale: 0,
      errors: 0,
      avgRoundTripMs: 0,
    };
  },
  destroy() {},
};

// ─── Internal state ─────────────────────────────────────────────────────────────

interface TraceState {
  startTime: bigint;
  lastEventTime: bigint;
  lastLayer: TraceEvent["layer"];
  lastDirection: TraceEvent["direction"];
  hasError: boolean;
}

interface SessionSeq {
  counter: number;
}

// ─── Size estimation ────────────────────────────────────────────────────────────

function roughObjectSize(obj: unknown, depth = 0): number {
  if (depth > 10 || obj === null || obj === undefined) return 4;
  if (typeof obj === "string") return obj.length;
  if (typeof obj === "number" || typeof obj === "boolean") return 8;
  if (Array.isArray(obj)) {
    let size = 2; // brackets
    for (const item of obj) size += roughObjectSize(item, depth + 1) + 1;
    return size;
  }
  if (typeof obj === "object") {
    let size = 2; // braces
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      size += key.length + 3 + roughObjectSize(value, depth + 1) + 1;
    }
    return size;
  }
  return 8;
}

// ─── Implementation ─────────────────────────────────────────────────────────────

export interface MessageTracerOptions {
  level: TraceLevel;
  allowSensitive: boolean;
  /** Override stderr for testing. */
  write?: (line: string) => void;
  /** Override hrtime for testing. */
  now?: () => bigint;
  /** Override stale timeout (ms) for testing. Default 30000. */
  staleTimeoutMs?: number;
}

export class MessageTracerImpl implements MessageTracer {
  private readonly level: TraceLevel;
  private readonly allowSensitive: boolean;
  private readonly writeLine: (line: string) => void;
  private readonly now: () => bigint;
  private readonly staleTimeoutMs: number;

  private static readonly MAX_COMPLETED = 10_000;
  private static readonly MAX_STALE = 1_000;
  private static readonly MAX_ERRORS = 1_000;
  private static readonly MAX_SESSIONS = 1_000;

  private readonly openTraces = new Map<string, TraceState>();
  private readonly sessionSeqs = new Map<string, SessionSeq>();
  private readonly staleTraces = new Set<string>();
  private readonly errorTraces = new Set<string>();
  private readonly completedTraces: number[] = []; // round-trip ms values
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: MessageTracerOptions) {
    this.level = opts.level;
    this.allowSensitive = opts.allowSensitive;
    this.writeLine = opts.write ?? ((line) => process.stderr.write(line + "\n"));
    this.now = opts.now ?? (() => process.hrtime.bigint());
    this.staleTimeoutMs = opts.staleTimeoutMs ?? 30_000;

    this.staleTimer = setInterval(() => this.sweepStale(), this.staleTimeoutMs);
    if (this.staleTimer.unref) this.staleTimer.unref();
  }

  send(layer: TraceEvent["layer"], messageType: string, body: unknown, opts?: TraceOpts): void {
    this.emitDirection("send", layer, messageType, body, opts);
  }

  recv(layer: TraceEvent["layer"], messageType: string, body: unknown, opts?: TraceOpts): void {
    this.emitDirection("recv", layer, messageType, body, opts);
  }

  translate(
    translator: string,
    boundary: string,
    from: { format: string; body: unknown },
    to: { format: string; body: unknown },
    opts?: TraceOpts,
  ): void {
    const traceId = opts?.traceId ?? this.generateTraceId();
    // Sanitize once and reuse for both diff computation and output
    const sanitizedFrom = this.sanitizeBody(from.body);
    const sanitizedTo = this.sanitizeBody(to.body);
    // Only diff when both sides are objects (skip when one is a string like NDJSON)
    const diff =
      typeof sanitizedFrom === "object" && typeof sanitizedTo === "object"
        ? diffObjects(sanitizedFrom, sanitizedTo)
        : undefined;
    // Pass pre-sanitized bodies to avoid redundant sanitization in emit
    this.emit({
      layer: "bridge",
      direction: "translate",
      messageType: `${boundary}:${translator}`,
      body: undefined,
      traceId,
      parentTraceId: opts?.parentTraceId,
      sessionId: opts?.sessionId,
      requestId: opts?.requestId,
      command: opts?.command,
      phase: opts?.phase,
      outcome: opts?.outcome,
      translator,
      boundary,
      from: { format: from.format, body: sanitizedFrom },
      to: { format: to.format, body: sanitizedTo },
      diff,
      preSanitized: true,
    });
  }

  error(
    layer: TraceEvent["layer"],
    messageType: string,
    errorStr: string,
    opts?: TraceErrorOpts,
  ): void {
    const traceId = opts?.traceId ?? this.generateTraceId();
    this.errorTraces.add(traceId);
    // Evict oldest error entries to bound memory
    if (this.errorTraces.size > MessageTracerImpl.MAX_ERRORS) {
      const it = this.errorTraces.values();
      this.errorTraces.delete(it.next().value!);
    }
    this.emit({
      layer,
      direction: "recv",
      messageType,
      body: undefined,
      traceId,
      parentTraceId: opts?.parentTraceId,
      sessionId: opts?.sessionId,
      error: errorStr,
      zodErrors: opts?.zodErrors,
      action: opts?.action,
      requestId: opts?.requestId,
      command: opts?.command,
      phase: opts?.phase,
      outcome: opts?.outcome,
    });
  }

  summary(_sessionId: string): TraceSummary {
    // TODO: per-session tracking (currently global)
    // Count unique error traces: those in errorTraces set plus any open traces
    // with hasError that aren't already in errorTraces
    const errorSet = new Set(this.errorTraces);
    for (const [traceId, state] of this.openTraces) {
      if (state.hasError) errorSet.add(traceId);
    }

    const stale = this.staleTraces.size;
    const complete = this.completedTraces.length;
    const avgRoundTripMs =
      complete > 0 ? Math.round(this.completedTraces.reduce((a, b) => a + b, 0) / complete) : 0;

    return {
      totalTraces: this.openTraces.size + complete + stale,
      complete,
      stale,
      errors: errorSet.size,
      avgRoundTripMs,
    };
  }

  /** Stop the stale sweep timer. */
  destroy(): void {
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private emitDirection(
    direction: "send" | "recv",
    layer: TraceEvent["layer"],
    messageType: string,
    body: unknown,
    opts?: TraceOpts,
  ): void {
    const traceId = opts?.traceId ?? this.generateTraceId();
    this.emit({
      layer,
      direction,
      messageType,
      body,
      traceId,
      parentTraceId: opts?.parentTraceId,
      sessionId: opts?.sessionId,
      requestId: opts?.requestId,
      command: opts?.command,
      phase: opts?.phase,
      outcome: opts?.outcome,
    });
  }

  private generateTraceId(): string {
    return `t_${randomUUID().slice(0, 8)}`;
  }

  private getSeq(sessionId?: string): number | undefined {
    if (!sessionId) return undefined;
    let seq = this.sessionSeqs.get(sessionId);
    if (!seq) {
      // Evict oldest session to bound memory
      if (this.sessionSeqs.size >= MessageTracerImpl.MAX_SESSIONS) {
        const oldest = this.sessionSeqs.keys().next().value!;
        this.sessionSeqs.delete(oldest);
      }
      seq = { counter: 0 };
      this.sessionSeqs.set(sessionId, seq);
    }
    return ++seq.counter;
  }

  private emit(params: {
    layer: TraceEvent["layer"];
    direction: TraceEvent["direction"];
    messageType: string;
    body: unknown;
    traceId: string;
    parentTraceId?: string;
    sessionId?: string;
    translator?: string;
    boundary?: string;
    from?: { format: string; body: unknown };
    to?: { format: string; body: unknown };
    diff?: string[];
    error?: string;
    zodErrors?: unknown[];
    action?: string;
    requestId?: string;
    command?: string;
    phase?: string;
    outcome?: TraceOutcome;
    /** When true, from/to bodies are already sanitized — skip redundant processing. */
    preSanitized?: boolean;
  }): void {
    const nowBigint = this.now();

    // Track trace state
    let state = this.openTraces.get(params.traceId);
    if (!state) {
      state = {
        startTime: nowBigint,
        lastEventTime: nowBigint,
        lastLayer: params.layer,
        lastDirection: params.direction,
        hasError: !!params.error,
      };
      this.openTraces.set(params.traceId, state);
    } else {
      state.lastEventTime = nowBigint;
      state.lastLayer = params.layer;
      state.lastDirection = params.direction;
      if (params.error) state.hasError = true;
    }

    const elapsedNs = nowBigint - state.startTime;
    const elapsedMs = Number(elapsedNs / 1_000_000n);

    const event: TraceEvent = {
      trace: true,
      traceId: params.traceId,
      layer: params.layer,
      direction: params.direction,
      messageType: params.messageType,
      ts: new Date().toISOString(),
      elapsed_ms: elapsedMs,
    };

    if (params.parentTraceId) event.parentTraceId = params.parentTraceId;
    if (params.sessionId) {
      event.sessionId = params.sessionId;
      event.seq = this.getSeq(params.sessionId);
    }
    if (params.translator) event.translator = params.translator;
    if (params.boundary) event.boundary = params.boundary;
    if (params.error) event.error = params.error;
    if (params.zodErrors) event.zodErrors = params.zodErrors;
    if (params.action) event.action = params.action;
    if (params.requestId) event.requestId = params.requestId;
    if (params.command) event.command = params.command;
    if (params.phase) event.phase = params.phase;
    if (params.outcome) event.outcome = params.outcome;

    // Body handling based on trace level
    if (params.body !== undefined) {
      event.size_bytes = this.estimateSize(params.body);
      if (this.level !== "headers") {
        event.body = this.sanitizeBody(params.body);
      }
    }
    if (this.level !== "headers") {
      if (params.from) {
        event.from = params.preSanitized
          ? params.from
          : { format: params.from.format, body: this.sanitizeBody(params.from.body) };
      }
      if (params.to) {
        event.to = params.preSanitized
          ? params.to
          : { format: params.to.format, body: this.sanitizeBody(params.to.body) };
      }
    }
    if (params.diff) event.diff = params.diff;

    this.writeLine(JSON.stringify(event));

    // Mark traces as complete when they hit a "send" at bridge/frontend layer
    // (response going back out to consumer)
    if (
      params.direction === "send" &&
      (params.layer === "bridge" || params.layer === "frontend") &&
      !params.error
    ) {
      this.openTraces.delete(params.traceId);
      this.completedTraces.push(elapsedMs);
      // Evict oldest entries to bound memory
      if (this.completedTraces.length > MessageTracerImpl.MAX_COMPLETED) {
        this.completedTraces.splice(
          0,
          this.completedTraces.length - MessageTracerImpl.MAX_COMPLETED,
        );
      }
    }
  }

  /** Apply redaction and optional truncation based on trace level. */
  private sanitizeBody(body: unknown): unknown {
    if (this.level === "smart") return smartSanitize(body);
    // "full" level — redact unless sensitive logging is explicitly allowed
    return this.allowSensitive ? body : redact(body);
  }

  private estimateSize(body: unknown): number {
    if (body === undefined || body === null) return 0;
    if (typeof body === "string") return body.length;
    // Rough estimate: avoid expensive JSON.stringify for size_bytes metadata
    return roughObjectSize(body);
  }

  private sweepStale(): void {
    const nowBigint = this.now();
    const thresholdNs = BigInt(this.staleTimeoutMs) * 1_000_000n;

    for (const [traceId, state] of this.openTraces) {
      if (nowBigint - state.lastEventTime > thresholdNs) {
        this.staleTraces.add(traceId);
        this.openTraces.delete(traceId);
        this.writeLine(
          JSON.stringify({
            trace: true,
            traceId,
            direction: "recv",
            messageType: "trace_stale",
            layer: state.lastLayer,
            ts: new Date().toISOString(),
            elapsed_ms: Number((nowBigint - state.startTime) / 1_000_000n),
            error: `trace stale: last event was ${state.lastDirection} at ${state.lastLayer}`,
          }),
        );
      }
    }
    // Evict oldest stale entries to bound memory
    while (this.staleTraces.size > MessageTracerImpl.MAX_STALE) {
      const it = this.staleTraces.values();
      this.staleTraces.delete(it.next().value!);
    }
  }
}
