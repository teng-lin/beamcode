/**
 * CodexSession — a live WebSocket connection to a codex app-server.
 *
 * Implements BackendSession by translating between UnifiedMessage
 * and Codex's JSON-RPC 2.0 protocol over WebSocket.
 */

import WebSocket from "ws";
import type { BackendSession } from "../../core/interfaces/backend-adapter.js";
import type { UnifiedMessage } from "../../core/types/unified-message.js";
import type { CodexLauncher } from "./codex-launcher.js";
import type {
  CodexApprovalRequest,
  CodexInitResponse,
  CodexTurnEvent,
} from "./codex-message-translator.js";
import {
  translateApprovalRequest,
  translateCodexEvent,
  translateInitResponse,
  translateToCodex,
} from "./codex-message-translator.js";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types (local)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ---------------------------------------------------------------------------
// CodexSession
// ---------------------------------------------------------------------------

export interface CodexSessionOptions {
  sessionId: string;
  ws: WebSocket;
  launcher: CodexLauncher;
  initResponse?: CodexInitResponse;
}

export class CodexSession implements BackendSession {
  readonly sessionId: string;
  private readonly ws: WebSocket;
  private readonly launcher: CodexLauncher;
  private nextRpcId = 1;
  private closed = false;

  /** Queued incoming messages for the async iterable consumer. */
  private readonly messageQueue: UnifiedMessage[] = [];
  private messageResolve: ((value: IteratorResult<UnifiedMessage>) => void) | null = null;
  private done = false;

  constructor(options: CodexSessionOptions) {
    this.sessionId = options.sessionId;
    this.ws = options.ws;
    this.launcher = options.launcher;

    if (options.initResponse) {
      this.enqueue(translateInitResponse(options.initResponse));
    }

    this.ws.on("message", (data: WebSocket.RawData) => {
      this.handleRawMessage(data);
    });

    this.ws.on("close", () => {
      this.finish();
    });

    this.ws.on("error", () => {
      this.finish();
    });
  }

  // ---------------------------------------------------------------------------
  // BackendSession — send
  // ---------------------------------------------------------------------------

  send(message: UnifiedMessage): void {
    if (this.closed) throw new Error("Session is closed");

    const action = translateToCodex(message);

    switch (action.type) {
      case "turn":
        this.sendRpcRequest("turn.create", { input: action.input });
        break;
      case "approval_response":
        this.sendRpcRequest("approval.respond", {
          approve: action.approve,
          item_id: action.itemId,
        });
        break;
      case "cancel":
        this.sendRpcNotification("turn.cancel");
        break;
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
            // If there are queued messages, return the next one
            const queued = self.messageQueue.shift();
            if (queued) {
              return Promise.resolve({ value: queued, done: false });
            }

            // If done, signal completion
            if (self.done) {
              return Promise.resolve({ value: undefined as unknown as UnifiedMessage, done: true });
            }

            // Wait for the next message
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

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }

    await this.launcher.killProcess(this.sessionId);
    this.finish();
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC helpers
  // ---------------------------------------------------------------------------

  private sendRpcRequest(method: string, params?: Record<string, unknown>): void {
    const msg: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextRpcId++,
      method,
      params,
    };
    this.ws.send(JSON.stringify(msg));
  }

  private sendRpcNotification(method: string, params?: Record<string, unknown>): void {
    const msg: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.ws.send(JSON.stringify(msg));
  }

  // ---------------------------------------------------------------------------
  // Incoming message handling
  // ---------------------------------------------------------------------------

  private handleRawMessage(data: WebSocket.RawData): void {
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(data.toString()) as JsonRpcMessage;
    } catch {
      return;
    }

    // JSON-RPC notification (no id) — these are Codex events
    if (!("id" in parsed) && "method" in parsed) {
      this.handleNotification(parsed as JsonRpcNotification);
      return;
    }

    // JSON-RPC response — currently not used for message generation
    // (initialize response is handled during connect handshake)
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const params = notification.params ?? {};

    if (notification.method === "approval_requested") {
      const request = params as unknown as CodexApprovalRequest;
      const unified = translateApprovalRequest(request);
      this.enqueue(unified);
      return;
    }

    // All other notifications are turn events
    const event = { type: notification.method, ...params } as unknown as CodexTurnEvent;
    const unified = translateCodexEvent(event);
    if (unified) {
      this.enqueue(unified);
    }
  }

  // ---------------------------------------------------------------------------
  // Queue management
  // ---------------------------------------------------------------------------

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
      resolve({ value: undefined as unknown as UnifiedMessage, done: true });
    }
  }
}
