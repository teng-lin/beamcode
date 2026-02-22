import { randomUUID } from "node:crypto";
import { normalizeInbound } from "../inbound-normalizer.js";
import type { InboundCommand } from "../interfaces/runtime-commands.js";
import type { MessageTracer } from "../message-tracer.js";
import type { UnifiedMessage } from "../types/unified-message.js";

export function tracedNormalizeInbound(
  tracer: MessageTracer,
  msg: InboundCommand,
  sessionId: string,
  trace?: { traceId?: string; requestId?: string; command?: string },
): UnifiedMessage | null {
  const unified = normalizeInbound(msg);
  if (unified && trace) {
    if (trace.traceId) unified.metadata.trace_id = trace.traceId;
    if (trace.requestId) unified.metadata.slash_request_id = trace.requestId;
    if (trace.command) unified.metadata.slash_command = trace.command;
  }
  tracer.translate(
    "normalizeInbound",
    "T1",
    { format: "InboundMessage", body: msg },
    { format: "UnifiedMessage", body: unified },
    {
      sessionId,
      traceId: trace?.traceId,
      requestId: trace?.requestId,
      command: trace?.command,
      phase: "t1",
    },
  );
  if (!unified) {
    tracer.error("bridge", msg.type, "normalizeInbound returned null", {
      sessionId,
      traceId: trace?.traceId,
      requestId: trace?.requestId,
      command: trace?.command,
      action: "dropped",
      phase: "t1",
      outcome: "unmapped_type",
    });
  }
  return unified;
}

export function generateTraceId(): string {
  return `t_${randomUUID().slice(0, 8)}`;
}

export function generateSlashRequestId(): string {
  return `sr_${randomUUID().slice(0, 8)}`;
}
