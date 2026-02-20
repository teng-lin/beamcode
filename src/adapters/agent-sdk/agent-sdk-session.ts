/**
 * AgentSdkSession — a live session wrapping the Claude Agent SDK's query function.
 *
 * Implements BackendSession by translating between UnifiedMessage
 * and the SDK's streaming async iterable protocol.
 */

import { AsyncMessageQueue } from "../../core/async-message-queue.js";
import type { BackendSession } from "../../core/interfaces/backend-adapter.js";
import { extractTraceContext, type MessageTracer } from "../../core/message-tracer.js";
import type { UnifiedMessage } from "../../core/types/unified-message.js";
import { PermissionBridge } from "./permission-bridge.js";
import type { SDKMessage, SDKUserMessage } from "./sdk-message-translator.js";
import { translateSdkMessage, translateToSdkInput } from "./sdk-message-translator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Query function signature — injected, not imported from SDK. */
export type QueryFn = (options: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Record<string, unknown>;
}) => AsyncIterable<SDKMessage>;

// ---------------------------------------------------------------------------
// AgentSdkSession
// ---------------------------------------------------------------------------

export class AgentSdkSession implements BackendSession {
  readonly sessionId: string;
  private readonly permissionBridge: PermissionBridge;
  private readonly queue = new AsyncMessageQueue<UnifiedMessage>();
  private closed = false;
  private abortController = new AbortController();

  private readonly inputQueue: SDKUserMessage[] = [];
  private inputResolve: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private queryRunning = false;
  private readonly tracer?: MessageTracer;

  constructor(
    sessionId: string,
    private readonly queryFn: QueryFn,
    private readonly queryOptions?: Record<string, unknown>,
    tracer?: MessageTracer,
  ) {
    this.sessionId = sessionId;
    this.permissionBridge = new PermissionBridge((msg) => this.queue.enqueue(msg));
    this.tracer = tracer;
  }

  // ---------------------------------------------------------------------------
  // BackendSession — send
  // ---------------------------------------------------------------------------

  send(message: UnifiedMessage): void {
    if (this.closed) throw new Error("Session is closed");
    const trace = extractTraceContext(message.metadata);

    if (message.type === "permission_response") {
      const { requestId, behavior, updatedInput } = message.metadata as {
        requestId: string;
        behavior: "allow" | "deny";
        updatedInput?: unknown;
      };
      this.permissionBridge.respondToPermission(requestId, behavior, updatedInput);
    } else if (message.type === "user_message") {
      const sdkInput = translateToSdkInput(message);
      this.tracer?.translate(
        "translateToSdkInput",
        "T2",
        { format: "UnifiedMessage", body: message },
        { format: "SDKUserMessage", body: sdkInput },
        {
          sessionId: this.sessionId,
          traceId: trace.traceId,
          requestId: trace.requestId,
          command: trace.command,
          phase: "t2",
        },
      );
      if (sdkInput) {
        this.tracer?.send("backend", "native_outbound", sdkInput, {
          sessionId: this.sessionId,
          traceId: trace.traceId,
          requestId: trace.requestId,
          command: trace.command,
          phase: "t2_send_native",
        });
        if (!this.queryRunning) {
          this.startQuery(sdkInput);
        } else {
          this.pushInput(sdkInput);
        }
      }
    } else if (message.type === "interrupt") {
      this.abortController.abort();
      this.abortController = new AbortController();
    }
  }

  sendRaw(_ndjson: string): void {
    throw new Error("AgentSdkSession does not support raw NDJSON");
  }

  // ---------------------------------------------------------------------------
  // BackendSession — messages (async iterable)
  // ---------------------------------------------------------------------------

  get messages(): AsyncIterable<UnifiedMessage> {
    return this.queue;
  }

  // ---------------------------------------------------------------------------
  // BackendSession — close
  // ---------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.abortController.abort();
    this.permissionBridge.rejectAll();

    if (this.inputResolve) {
      this.inputResolve({ value: undefined, done: true } as IteratorResult<SDKUserMessage>);
      this.inputResolve = null;
    }
    this.queue.finish();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private pushInput(sdkInput: SDKUserMessage): void {
    if (this.inputResolve) {
      const r = this.inputResolve;
      this.inputResolve = null;
      r({ value: sdkInput, done: false });
    } else {
      this.inputQueue.push(sdkInput);
    }
  }

  private async startQuery(firstMessage: SDKUserMessage): Promise<void> {
    this.queryRunning = true;
    const self = this;

    const inputStream: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            if (self.inputQueue.length > 0) {
              const value = self.inputQueue.shift() as SDKUserMessage;
              return Promise.resolve({ value, done: false });
            }
            if (self.closed) {
              return Promise.resolve({
                value: undefined,
                done: true,
              } as IteratorResult<SDKUserMessage>);
            }
            return new Promise((resolve) => {
              self.inputResolve = resolve;
            });
          },
        };
      },
    };

    const prompt = (async function* () {
      yield firstMessage;
      yield* inputStream;
    })();

    try {
      const sdkStream = this.queryFn({
        prompt,
        options: {
          ...this.queryOptions,
          canUseTool: (toolName: string, input: Record<string, unknown>) =>
            this.permissionBridge.handleToolRequest(toolName, input),
          abortSignal: this.abortController.signal,
        },
      });

      for await (const sdkMsg of sdkStream) {
        if (this.closed) break;
        this.tracer?.recv("backend", "native_inbound", sdkMsg, {
          sessionId: this.sessionId,
          phase: "t3_recv_native",
        });
        const unified = translateSdkMessage(sdkMsg);
        this.tracer?.translate(
          "translateSdkMessage",
          "T3",
          { format: "SDKMessage", body: sdkMsg },
          { format: "UnifiedMessage", body: unified },
          { sessionId: this.sessionId, phase: "t3" },
        );
        this.queue.enqueue(unified);
      }
    } catch {
      // Query ended (abort or error) — not a session error
    } finally {
      this.queryRunning = false;
    }
  }
}
