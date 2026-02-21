/**
 * AgentSdkSession — a live in-process connection to Claude via the Agent SDK.
 *
 * Implements BackendSession by translating between UnifiedMessage and the
 * Agent SDK's typed message stream. Unlike the inverted-connection
 * ClaudeSession (WebSocket), this runs in the same Node.js process.
 */

import { AsyncMessageQueue } from "../../core/async-message-queue.js";
import type { BackendSession, ConnectOptions } from "../../core/interfaces/backend-adapter.js";
import type { UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import { PermissionBridge } from "./permission-bridge.js";
import { translateFromSdk, translateToSdkUserMessage } from "./sdk-message-translator.js";

/**
 * Minimal interface for the SDK's query function to avoid importing the
 * heavy SDK module at the type level. The actual SDK is loaded dynamically
 * in `create()`.
 */
type SdkQueryFn = (_params: {
  prompt: string | AsyncIterable<{ type: "user"; message: unknown }>;
  options?: Record<string, unknown>;
}) => SdkQuery;

interface SdkQuery extends AsyncGenerator<Record<string, unknown>, void> {
  close(): void;
  interrupt(): Promise<void>;
}

export class AgentSdkSession implements BackendSession {
  readonly sessionId: string;
  private readonly queue = new AsyncMessageQueue<UnifiedMessage>();
  private abortController = new AbortController();
  private closed = false;
  private readonly permissionBridge: PermissionBridge;
  private query: SdkQuery | null = null;

  /**
   * Input queue for multi-turn conversations.
   * User messages are pushed here and consumed by the SDK's prompt iterable.
   */
  private inputResolve:
    | ((value: IteratorResult<{ type: "user"; message: unknown }>) => void)
    | null = null;
  private inputQueue: Array<{ type: "user"; message: unknown }> = [];
  private inputDone = false;

  private constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.permissionBridge = new PermissionBridge((msg) => this.queue.enqueue(msg));
  }

  /** Factory — performs async SDK import and starts the query loop. */
  static async create(options: ConnectOptions): Promise<AgentSdkSession> {
    const session = new AgentSdkSession(options.sessionId);
    // Dynamic import — only loads the heavy SDK when actually used
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    session.startQueryLoop(sdk.query as unknown as SdkQueryFn, options);
    return session;
  }

  // ── BackendSession.send ──

  send(message: UnifiedMessage): void {
    if (this.closed) throw new Error("Session is closed");

    switch (message.type) {
      case "user_message": {
        const text = translateToSdkUserMessage(message);
        if (text) {
          this.pushInput({
            type: "user" as const,
            message: { role: "user", content: text },
          });
        }
        break;
      }
      case "interrupt":
        void this.query?.interrupt();
        break;
      case "permission_response":
        this.permissionBridge.resolve(message);
        break;
    }
  }

  // ── BackendSession.sendRaw ──

  sendRaw(_ndjson: string): void {
    throw new Error("AgentSdkSession does not support raw NDJSON");
  }

  // ── BackendSession.messages ──

  get messages(): AsyncIterable<UnifiedMessage> {
    const session = this;
    const queue = this.queue;
    return {
      [Symbol.asyncIterator](): AsyncIterator<UnifiedMessage> {
        const inner = queue[Symbol.asyncIterator]();
        return {
          next(): Promise<IteratorResult<UnifiedMessage>> {
            // After close(), discard any buffered messages and signal done
            if (session.closed && queue.isFinished) {
              return Promise.resolve({
                value: undefined,
                done: true,
              } as IteratorResult<UnifiedMessage>);
            }
            return inner.next();
          },
        };
      },
    };
  }

  // ── BackendSession.close ──

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Close the input stream so the SDK knows no more messages are coming
    this.finishInput();

    // Close the SDK query
    this.query?.close();

    // Cancel all pending permission requests
    this.permissionBridge.cancelAll();

    // Signal end of the message stream
    this.queue.finish();
  }

  // ── Internal: query loop ──

  private startQueryLoop(queryFn: SdkQueryFn, options: ConnectOptions): void {
    const inputIterable = this.createInputIterable();

    const sdkOptions: Record<string, unknown> = {
      cwd: (options.adapterOptions?.cwd as string) ?? process.cwd(),
      abortController: this.abortController,
      includePartialMessages: true,
    };

    // Resume support: pass the backend session ID to the SDK
    if (options.resume) {
      const backendSessionId = options.adapterOptions?.backendSessionId as string | undefined;
      if (backendSessionId) {
        sdkOptions.resume = backendSessionId;
      }
    }

    // Permission callback
    sdkOptions.canUseTool = (
      toolName: string,
      input: Record<string, unknown>,
      callbackOptions: {
        signal: AbortSignal;
        suggestions?: unknown[];
        blockedPath?: string;
        decisionReason?: string;
        toolUseID: string;
        agentID?: string;
      },
    ) => {
      return this.permissionBridge
        .handleToolRequest(toolName, input, {
          toolUseId: callbackOptions.toolUseID,
          agentId: callbackOptions.agentID,
          suggestions: callbackOptions.suggestions,
          blockedPath: callbackOptions.blockedPath,
          decisionReason: callbackOptions.decisionReason,
        })
        .then((decision) => {
          if (decision.behavior === "allow") {
            return {
              behavior: "allow" as const,
              updatedInput: decision.updatedInput,
            };
          }
          return {
            behavior: "deny" as const,
            message: decision.message ?? "Permission denied",
          };
        });
    };

    this.query = queryFn({
      prompt: inputIterable,
      options: sdkOptions,
    });

    // Consume the SDK message stream in the background
    void this.consumeStream();
  }

  private async consumeStream(): Promise<void> {
    if (!this.query) return;

    try {
      for await (const sdkMsg of this.query) {
        if (this.closed) break;

        // Capture the backend session ID from system:init
        if (sdkMsg.type === "system" && (sdkMsg as Record<string, unknown>).subtype === "init") {
          const sessionId = (sdkMsg as Record<string, unknown>).session_id as string;
          if (sessionId) {
            // Store the backend session ID for resume support
            (this as { backendSessionId?: string }).backendSessionId = sessionId;
          }
        }

        const unified = translateFromSdk(sdkMsg as Record<string, unknown>);
        if (unified) {
          this.queue.enqueue(unified);
        }
      }
    } catch (err) {
      if (!this.closed) {
        this.queue.enqueue(
          createUnifiedMessage({
            type: "result",
            role: "system",
            metadata: {
              status: "failed",
              is_error: true,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        );
      }
    } finally {
      if (!this.closed) {
        this.queue.finish();
      }
    }
  }

  // ── Internal: input stream for multi-turn ──

  private createInputIterable(): AsyncIterable<{
    type: "user";
    message: unknown;
  }> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<{ type: "user"; message: unknown }>> {
            const queued = self.inputQueue.shift();
            if (queued !== undefined) {
              return Promise.resolve({ value: queued, done: false });
            }
            if (self.inputDone) {
              return Promise.resolve({
                value: undefined,
                done: true,
              } as IteratorResult<{ type: "user"; message: unknown }>);
            }
            return new Promise((resolve) => {
              self.inputResolve = resolve;
            });
          },
        };
      },
    };
  }

  private pushInput(msg: { type: "user"; message: unknown }): void {
    if (this.inputDone) return;
    if (this.inputResolve) {
      const r = this.inputResolve;
      this.inputResolve = null;
      r({ value: msg, done: false });
    } else {
      this.inputQueue.push(msg);
    }
  }

  private finishInput(): void {
    if (this.inputDone) return;
    this.inputDone = true;
    if (this.inputResolve) {
      const r = this.inputResolve;
      this.inputResolve = null;
      r({
        value: undefined,
        done: true,
      } as IteratorResult<{ type: "user"; message: unknown }>);
    }
  }

  /** The backend session ID captured from system:init (for resume support). */
  backendSessionId?: string;
}
