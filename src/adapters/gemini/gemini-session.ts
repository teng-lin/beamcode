/**
 * GeminiSession — a live HTTP+SSE connection to a Gemini A2A server.
 *
 * Implements BackendSession by translating between UnifiedMessage
 * and the Gemini A2A protocol over HTTP with SSE streaming.
 */

import type { BackendSession } from "../../core/interfaces/backend-adapter.js";
import type { UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { Logger } from "../../interfaces/logger.js";
import type { GeminiLauncher } from "./gemini-launcher.js";
import {
  buildCancelBody,
  buildMessageStreamBody,
  translateA2AEvent,
  translateToGemini,
} from "./gemini-message-translator.js";
import { parseSSEData, parseSSEStream } from "./gemini-sse-parser.js";
import type { A2AStatusUpdate, A2AStreamEvent, GeminiMessage } from "./gemini-types.js";

// ---------------------------------------------------------------------------
// GeminiSession
// ---------------------------------------------------------------------------

/** Known coderAgent event kinds that the translator handles. */
const KNOWN_CODER_AGENT_KINDS = new Set([
  "text-content",
  "tool-call-update",
  "tool-call-confirmation",
  "thought",
  "state-change",
]);

export interface GeminiSessionOptions {
  sessionId: string;
  baseUrl: string;
  launcher: GeminiLauncher;
  logger?: Logger;
  fetchFn?: typeof fetch;
}

export class GeminiSession implements BackendSession {
  readonly sessionId: string;
  private readonly baseUrl: string;
  private readonly launcher: GeminiLauncher;
  private readonly logger?: Logger;
  private readonly fetchFn: typeof fetch;
  private nextRpcId = 1;
  private closed = false;
  private currentTaskId: string | undefined;
  private sseAbortController: AbortController | null = null;

  /** Queued incoming messages for the async iterable consumer. */
  private readonly messageQueue: UnifiedMessage[] = [];
  private messageResolve: ((value: IteratorResult<UnifiedMessage>) => void) | null = null;
  private done = false;

  constructor(options: GeminiSessionOptions) {
    // Validate baseUrl points to localhost to prevent SSRF
    const parsed = new URL(options.baseUrl);
    if (
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "::1"
    ) {
      throw new Error(`baseUrl must point to localhost, got "${parsed.hostname}"`);
    }

    this.sessionId = options.sessionId;
    this.baseUrl = options.baseUrl;
    this.launcher = options.launcher;
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? fetch;

    // Detect unexpected server exit and surface it to consumers
    this.launcher.on("process:exited", this.onProcessExited);
  }

  // ---------------------------------------------------------------------------
  // BackendSession — send
  // ---------------------------------------------------------------------------

  send(message: UnifiedMessage): void {
    if (this.closed) throw new Error("Session is closed");

    const action = translateToGemini(message);

    switch (action.type) {
      case "message_stream":
      case "message_stream_resume":
        if (action.message) {
          void this.sendMessageStream(action.message, action.taskId);
        }
        break;
      case "cancel":
        void this.sendCancel(action.taskId ?? this.currentTaskId);
        break;
      case "noop":
        break;
    }
  }

  sendRaw(_ndjson: string): void {
    throw new Error("GeminiSession does not support raw NDJSON");
  }

  // ---------------------------------------------------------------------------
  // BackendSession — messages (async iterable)
  // ---------------------------------------------------------------------------

  get messages(): AsyncIterable<UnifiedMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<UnifiedMessage>> {
            const queued = self.messageQueue.shift();
            if (queued) {
              return Promise.resolve({ value: queued, done: false });
            }

            if (self.done) {
              return Promise.resolve({
                value: undefined,
                done: true,
              } as IteratorResult<UnifiedMessage>);
            }

            return new Promise<IteratorResult<UnifiedMessage>>((resolve) => {
              self.messageResolve = resolve;
            });
          },
        };
      },
    };
  }

  // ---------------------------------------------------------------------------
  // BackendSession — close
  // ---------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.launcher.off("process:exited", this.onProcessExited);

    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }

    await this.launcher.killProcess(this.sessionId);
    this.finish();
  }

  // ---------------------------------------------------------------------------
  // HTTP + SSE communication
  // ---------------------------------------------------------------------------

  private async sendMessageStream(message: GeminiMessage, taskId?: string): Promise<void> {
    // Abort any existing SSE stream before starting a new one
    if (this.sseAbortController) {
      this.sseAbortController.abort();
    }

    const controller = new AbortController();
    this.sseAbortController = controller;
    const rpcId = this.nextRpcId++;
    const body = buildMessageStreamBody(rpcId, message, taskId);

    try {
      const response = await this.fetchFn(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        this.enqueueError(`HTTP ${response.status}: ${response.statusText}`);
        return;
      }

      if (!response.body) {
        this.enqueueError("No response body from A2A server");
        return;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        this.enqueueError(
          `Expected text/event-stream response but got "${contentType || "(none)"}"`,
        );
        return;
      }

      await this.consumeSSEStream(response.body, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      this.enqueueError(err instanceof Error ? err.message : String(err));
    }
  }

  private async sendCancel(taskId?: string): Promise<void> {
    if (!taskId) return;

    const rpcId = this.nextRpcId++;
    const body = buildCancelBody(rpcId, taskId);

    // Abort current SSE stream
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }

    try {
      await this.fetchFn(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch {
      // Best-effort cancel — errors are expected if process is already gone
    }
  }

  private async consumeSSEStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    for await (const sseEvent of parseSSEStream(body, signal)) {
      const a2aEvent = parseSSEData<A2AStreamEvent>(sseEvent.data);
      if (!a2aEvent) continue;

      // Track the task ID from the first task event
      if (a2aEvent.result?.kind === "task") {
        this.currentTaskId = a2aEvent.result.id;
      }

      const unified = translateA2AEvent(a2aEvent);
      if (unified) {
        this.enqueue(unified);
      } else if (a2aEvent.result?.kind === "status-update") {
        const kind = (a2aEvent.result as A2AStatusUpdate).metadata?.coderAgent?.kind;
        if (kind && !KNOWN_CODER_AGENT_KINDS.has(kind)) {
          this.logger?.debug?.(`Unhandled coderAgent event kind: "${kind}"`);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Queue management
  // ---------------------------------------------------------------------------

  private enqueueError(error: string): void {
    this.enqueue(
      createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: { status: "failed", is_error: true, error },
      }),
    );
  }

  private enqueue(message: UnifiedMessage): void {
    if (this.messageResolve) {
      const resolve = this.messageResolve;
      this.messageResolve = null;
      resolve({ value: message, done: false });
    } else {
      this.messageQueue.push(message);
    }
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;

    if (this.messageResolve) {
      const resolve = this.messageResolve;
      this.messageResolve = null;
      resolve({ value: undefined, done: true } as IteratorResult<UnifiedMessage>);
    }
  }

  /** Handle unexpected server process exit. */
  private readonly onProcessExited = (event: {
    sessionId: string;
    exitCode: number | null;
  }): void => {
    if (event.sessionId !== this.sessionId || this.closed) return;

    // Abort any in-flight SSE stream
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }

    this.enqueueError(`Gemini A2A server exited unexpectedly (code=${event.exitCode})`);
    this.finish();
  };
}
