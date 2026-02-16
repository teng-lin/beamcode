/**
 * AgentSdkSession — a live session wrapping the Claude Agent SDK's query function.
 *
 * Implements BackendSession by translating between UnifiedMessage
 * and the SDK's streaming async iterable protocol.
 */

import type { BackendSession } from "../../core/interfaces/backend-adapter.js";
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
  private readonly messageQueue: UnifiedMessage[] = [];
  private messageResolve: ((result: IteratorResult<UnifiedMessage>) => void) | null = null;
  private closed = false;
  private abortController = new AbortController();

  private readonly inputQueue: SDKUserMessage[] = [];
  private inputResolve: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private queryRunning = false;

  constructor(
    sessionId: string,
    private readonly queryFn: QueryFn,
    private readonly queryOptions?: Record<string, unknown>,
  ) {
    this.sessionId = sessionId;
    this.permissionBridge = new PermissionBridge((msg) => this.pushMessage(msg));
  }

  // ---------------------------------------------------------------------------
  // BackendSession — send
  // ---------------------------------------------------------------------------

  send(message: UnifiedMessage): void {
    if (this.closed) throw new Error("Session is closed");

    if (message.type === "permission_response") {
      const { requestId, behavior, updatedInput } = message.metadata as {
        requestId: string;
        behavior: "allow" | "deny";
        updatedInput?: unknown;
      };
      this.permissionBridge.respondToPermission(requestId, behavior, updatedInput);
    } else if (message.type === "user_message") {
      const sdkInput = translateToSdkInput(message);
      if (sdkInput) {
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

  // ---------------------------------------------------------------------------
  // BackendSession — messages (async iterable)
  // ---------------------------------------------------------------------------

  get messages(): AsyncIterable<UnifiedMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<UnifiedMessage>> {
            if (self.messageQueue.length > 0) {
              const value = self.messageQueue.shift() as UnifiedMessage;
              return Promise.resolve({ value, done: false });
            }
            if (self.closed) {
              return Promise.resolve({ value: undefined as unknown as UnifiedMessage, done: true });
            }
            return new Promise((resolve) => {
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

    this.abortController.abort();
    this.permissionBridge.rejectAll();

    if (this.inputResolve) {
      this.inputResolve({ value: undefined as unknown as SDKUserMessage, done: true });
      this.inputResolve = null;
    }
    if (this.messageResolve) {
      this.messageResolve({ value: undefined as unknown as UnifiedMessage, done: true });
      this.messageResolve = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private pushMessage(msg: UnifiedMessage): void {
    if (this.messageResolve) {
      const r = this.messageResolve;
      this.messageResolve = null;
      r({ value: msg, done: false });
    } else {
      this.messageQueue.push(msg);
    }
  }

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
              return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
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
        const unified = translateSdkMessage(sdkMsg);
        this.pushMessage(unified);
      }
    } catch {
      // Query ended (abort or error) — not a session error
    } finally {
      this.queryRunning = false;
    }
  }
}
