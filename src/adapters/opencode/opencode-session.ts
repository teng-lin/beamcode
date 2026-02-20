/**
 * OpencodeSession -- a live connection to a single opencode session.
 *
 * Implements BackendSession by translating between UnifiedMessage
 * and opencode's REST + SSE protocol.
 */

import { AsyncMessageQueue } from "../../core/async-message-queue.js";
import type { BackendSession } from "../../core/interfaces/backend-adapter.js";
import { extractTraceContext, type MessageTracer } from "../../core/message-tracer.js";
import type { UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { OpencodeHttpClient } from "./opencode-http-client.js";
import { translateEvent, translateToOpencode } from "./opencode-message-translator.js";
import type { OpencodeEvent } from "./opencode-types.js";

// ---------------------------------------------------------------------------
// OpencodeSession
// ---------------------------------------------------------------------------

export class OpencodeSession implements BackendSession {
  readonly sessionId: string;
  private readonly opcSessionId: string;
  private readonly httpClient: OpencodeHttpClient;
  private readonly unsubscribe: () => void;
  private closed = false;
  private readonly queue = new AsyncMessageQueue<UnifiedMessage>();
  private readonly tracer?: MessageTracer;

  constructor(options: {
    sessionId: string;
    opcSessionId: string;
    httpClient: OpencodeHttpClient;
    subscribe: (handler: (event: OpencodeEvent) => void) => () => void;
    tracer?: MessageTracer;
  }) {
    this.sessionId = options.sessionId;
    this.opcSessionId = options.opcSessionId;
    this.httpClient = options.httpClient;
    this.tracer = options.tracer;

    this.unsubscribe = options.subscribe((event) => {
      this.tracer?.recv("backend", "native_inbound", event, {
        sessionId: this.sessionId,
        phase: "t3_recv_native",
      });
      const unified = translateEvent(event);
      if (unified) {
        this.tracer?.translate(
          "translateEvent",
          "T3",
          { format: "OpencodeEvent", body: event },
          { format: "UnifiedMessage", body: unified },
          { sessionId: this.sessionId, phase: "t3" },
        );
        this.queue.enqueue(unified);
      } else {
        this.tracer?.error("backend", event.type, "Opencode event did not map to UnifiedMessage", {
          sessionId: this.sessionId,
          action: "dropped",
          phase: "t3",
          outcome: "unmapped_type",
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // BackendSession -- send
  // ---------------------------------------------------------------------------

  send(message: UnifiedMessage): void {
    if (this.closed) throw new Error("Session is closed");

    const trace = extractTraceContext(message.metadata);
    const action = translateToOpencode(message);
    this.tracer?.translate(
      "translateToOpencode",
      "T2",
      { format: "UnifiedMessage", body: message },
      { format: "OpencodeAction", body: action },
      {
        sessionId: this.sessionId,
        traceId: trace.traceId,
        requestId: trace.requestId,
        command: trace.command,
        phase: "t2",
      },
    );

    if (action.type !== "noop") {
      this.tracer?.send("backend", "native_outbound", action, {
        sessionId: this.sessionId,
        traceId: trace.traceId,
        requestId: trace.requestId,
        command: trace.command,
        phase: "t2_send_native",
      });
    }

    switch (action.type) {
      case "prompt":
        this.sendAction(
          this.httpClient.promptAsync(this.opcSessionId, {
            parts: action.parts,
            model: action.model,
          }),
        );
        break;
      case "permission_reply":
        this.sendAction(
          this.httpClient.replyPermission(action.requestId, {
            reply: action.reply,
          }),
        );
        break;
      case "abort":
        this.sendAction(this.httpClient.abort(this.opcSessionId));
        break;
      case "noop":
        break;
    }
  }

  private sendAction(promise: Promise<unknown>): void {
    promise.catch((err: unknown) => {
      this.tracer?.error("backend", "native_outbound", "Opencode action failed", {
        sessionId: this.sessionId,
        action: "failed",
        phase: "t2_send_native",
        outcome: "backend_error",
      });
      this.queue.enqueue(
        createUnifiedMessage({
          type: "result",
          role: "system",
          metadata: {
            is_error: true,
            error_message: err instanceof Error ? err.message : String(err),
          },
        }),
      );
    });
  }

  // ---------------------------------------------------------------------------
  // BackendSession -- sendRaw
  // ---------------------------------------------------------------------------

  sendRaw(_ndjson: string): void {
    throw new Error("opencode adapter does not support raw NDJSON");
  }

  // ---------------------------------------------------------------------------
  // BackendSession -- messages (async iterable)
  // ---------------------------------------------------------------------------

  get messages(): AsyncIterable<UnifiedMessage> {
    return this.queue;
  }

  // ---------------------------------------------------------------------------
  // BackendSession -- close
  // ---------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.queue.finish();
  }
}
