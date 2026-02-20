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
  private readonly textPartsByMessage = new Map<string, Map<string, string>>();
  private readonly reasoningPartsByMessage = new Map<string, Set<string>>();
  private readonly assistantTextByMessage = new Map<string, string>();

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
        const normalized = this.normalizeUnifiedMessage(unified);
        this.tracer?.translate(
          "translateEvent",
          "T3",
          { format: "OpencodeEvent", body: event },
          { format: "UnifiedMessage", body: normalized },
          { sessionId: this.sessionId, phase: "t3" },
        );
        this.queue.enqueue(normalized);
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

  private normalizeUnifiedMessage(message: UnifiedMessage): UnifiedMessage {
    if (message.type === "stream_event") {
      this.captureStreamText(message);
      return message;
    }

    if (message.type === "assistant") {
      return this.materializeAssistantText(message);
    }

    if (message.type === "result") {
      this.clearStreamState();
    }

    return message;
  }

  private captureStreamText(message: UnifiedMessage): void {
    const metadata = message.metadata as {
      event?: { type?: string; delta?: { type?: string; text?: string } };
      message_id?: string;
      part_id?: string;
      text?: string;
      reasoning?: boolean;
    };

    if (metadata.event?.type !== "content_block_delta") return;
    const messageId = metadata.message_id;
    const partId = metadata.part_id;
    if (typeof messageId !== "string" || messageId.length === 0) return;
    if (typeof partId !== "string" || partId.length === 0) return;

    if (metadata.reasoning === true) {
      let reasoningParts = this.reasoningPartsByMessage.get(messageId);
      if (!reasoningParts) {
        reasoningParts = new Set<string>();
        this.reasoningPartsByMessage.set(messageId, reasoningParts);
      }
      reasoningParts.add(partId);
      return;
    }

    const reasoningParts = this.reasoningPartsByMessage.get(messageId);
    if (reasoningParts?.has(partId)) return;

    const partText =
      typeof metadata.text === "string"
        ? metadata.text
        : metadata.event.delta?.type === "text_delta" &&
            typeof metadata.event.delta.text === "string"
          ? metadata.event.delta.text
          : undefined;
    if (!partText || partText.length === 0) return;

    let parts = this.textPartsByMessage.get(messageId);
    if (!parts) {
      parts = new Map<string, string>();
      this.textPartsByMessage.set(messageId, parts);
    }

    if (typeof metadata.text === "string") {
      parts.set(partId, metadata.text);
      return;
    }

    parts.set(partId, (parts.get(partId) ?? "") + partText);
  }

  private materializeAssistantText(message: UnifiedMessage): UnifiedMessage {
    const messageId = message.metadata.message_id;
    if (typeof messageId !== "string" || messageId.length === 0) return message;

    if (message.content.length > 0) {
      const existingText = this.extractTextFromContent(message);
      if (existingText.length > 0) {
        this.assistantTextByMessage.set(messageId, existingText);
      }
      return message;
    }

    const streamedText = this.getBufferedText(messageId);
    const priorText = this.assistantTextByMessage.get(messageId) ?? "";
    const text = streamedText.length > 0 ? streamedText : priorText;
    if (text.length === 0) return message;

    this.assistantTextByMessage.set(messageId, text);

    return {
      ...message,
      content: [{ type: "text", text }],
    };
  }

  private extractTextFromContent(message: UnifiedMessage): string {
    let text = "";
    for (const block of message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        text += block.text;
      }
    }
    return text;
  }

  private getBufferedText(messageId: string): string {
    const parts = this.textPartsByMessage.get(messageId);
    return parts ? Array.from(parts.values()).join("") : "";
  }

  private clearStreamState(): void {
    this.textPartsByMessage.clear();
    this.reasoningPartsByMessage.clear();
    this.assistantTextByMessage.clear();
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
    this.clearStreamState();
    this.unsubscribe();
    this.queue.finish();
  }
}
