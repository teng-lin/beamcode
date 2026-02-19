/**
 * CodexSession — a live WebSocket connection to a codex app-server.
 *
 * Implements BackendSession by translating between UnifiedMessage
 * and Codex's JSON-RPC 2.0 protocol over WebSocket.
 */

import WebSocket from "ws";
import type { BackendSession } from "../../core/interfaces/backend-adapter.js";
import type { UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { CodexLauncher } from "./codex-launcher.js";
import type {
  CodexApprovalRequest,
  CodexContentPart,
  CodexInitResponse,
  CodexItem,
  CodexItemContent,
  CodexRefusalPart,
  CodexResponse,
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

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
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
  threadId?: string;
}

export class CodexSession implements BackendSession {
  readonly sessionId: string;
  private readonly ws: WebSocket;
  private readonly launcher: CodexLauncher;
  private nextRpcId = 1;
  private closed = false;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;

  /** The current Codex thread ID (null until first message initializes a thread). */
  get currentThreadId(): string | null {
    return this.threadId;
  }
  private initializingThread: Promise<void> | null = null;
  private queuedTurnInputs: string[] = [];
  private pendingApprovalMethods = new Map<string, string>();
  private pendingRpc = new Map<
    number,
    {
      resolve: (response: JsonRpcResponse) => void;
      reject: (error: Error) => void;
      method: string;
    }
  >();

  /** Queued incoming messages for the async iterable consumer. */
  private readonly messageQueue: UnifiedMessage[] = [];
  private messageResolve: ((value: IteratorResult<UnifiedMessage>) => void) | null = null;
  private done = false;

  constructor(options: CodexSessionOptions) {
    this.sessionId = options.sessionId;
    this.ws = options.ws;
    this.launcher = options.launcher;
    this.threadId = options.threadId ?? null;

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
        this.sendTurnInput(action.input ?? "");
        break;
      case "approval_response":
        this.respondToApproval(action.itemId, action.approve === true);
        break;
      case "cancel":
        this.interruptTurn();
        break;
    }
  }

  sendRaw(_ndjson: string): void {
    throw new Error("CodexSession does not support raw NDJSON");
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
              return Promise.resolve({
                value: undefined,
                done: true,
              } as IteratorResult<UnifiedMessage>);
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

  private sendRpcRequest(method: string, params?: Record<string, unknown>): number {
    const id = this.nextRpcId++;
    const msg: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    this.ws.send(JSON.stringify(msg));
    return id;
  }

  private sendRpcNotification(method: string, params?: Record<string, unknown>): void {
    const msg: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.ws.send(JSON.stringify(msg));
  }

  private sendRpcResult(id: number | string, result: unknown): void {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private sendRpcError(id: number | string, message: string, code = -32601): void {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  requestRpc(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<JsonRpcResponse> {
    const id = this.sendRpcRequest(method, params);
    const rpcPromise = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pendingRpc.set(id, { resolve, reject, method });
    });

    if (timeoutMs <= 0) return rpcPromise;

    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`RPC "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    return Promise.race([rpcPromise, timeoutPromise]).finally(() => {
      clearTimeout(timer);
    });
  }

  private sendTurnInput(text: string): void {
    this.queuedTurnInputs.push(text);
    if (this.threadId) {
      this.flushQueuedTurns();
      return;
    }
    void this.ensureThreadInitialized()
      .then(() => this.flushQueuedTurns())
      .catch((err) => {
        this.queuedTurnInputs = [];
        this.enqueue(
          createUnifiedMessage({
            type: "result",
            role: "system",
            metadata: {
              is_error: true,
              status: "failed",
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        );
      });
  }

  private async ensureThreadInitialized(): Promise<void> {
    if (this.threadId) return;
    if (this.initializingThread) return this.initializingThread;

    this.initializingThread = (async () => {
      let threadId: string | null = null;
      try {
        const started = await this.requestRpc("thread/start", {});
        threadId = this.extractThreadIdFromResult(started.result);
      } catch {
        // Fall through to legacy API fallback.
      }

      if (!threadId) {
        const legacy = await this.requestRpc("newConversation", {});
        threadId = this.extractThreadIdFromResult(legacy.result);
      }

      if (!threadId) {
        throw new Error("Failed to initialize Codex thread");
      }
      this.threadId = threadId;
    })();

    try {
      await this.initializingThread;
    } finally {
      this.initializingThread = null;
    }
  }

  /** Start a fresh thread, interrupting any active turn first. */
  async resetThread(): Promise<string> {
    if (this.activeTurnId) {
      this.interruptTurn();
      this.activeTurnId = null;
    }
    // Wait for any in-flight thread initialization to settle before clearing
    // state, otherwise the old init could resolve and overwrite our new thread.
    if (this.initializingThread) {
      await this.initializingThread.catch(() => {});
    }
    this.threadId = null;
    this.initializingThread = null;
    this.queuedTurnInputs = [];
    await this.ensureThreadInitialized();
    return this.threadId!;
  }

  private flushQueuedTurns(): void {
    if (!this.threadId) return;
    while (this.queuedTurnInputs.length > 0) {
      const input = this.queuedTurnInputs.shift() ?? "";
      this.sendRpcRequest("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: input }],
      });
    }
  }

  private interruptTurn(): void {
    if (this.threadId && this.activeTurnId) {
      this.sendRpcRequest("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      });
      return;
    }
    // Legacy fallback
    this.sendRpcNotification("turn.cancel");
  }

  private respondToApproval(requestId: string | undefined, approve: boolean): void {
    if (!requestId) return;
    const method = this.pendingApprovalMethods.get(requestId);
    if (!method) {
      // Legacy fallback used by older Codex protocol variants.
      this.sendRpcRequest("approval.respond", {
        approve,
        item_id: requestId,
      });
      return;
    }
    this.pendingApprovalMethods.delete(requestId);

    const id: number | string = /^\d+$/.test(requestId)
      ? Number.parseInt(requestId, 10)
      : requestId;

    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      this.sendRpcResult(id, { decision: approve ? "accept" : "decline" });
      return;
    }
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      this.sendRpcResult(id, { decision: approve ? "approved" : "denied" });
      return;
    }

    this.sendRpcError(id, `Unsupported approval method: ${method}`);
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

    // JSON-RPC request from server (expects client response)
    if ("id" in parsed && "method" in parsed) {
      this.handleServerRequest(parsed as JsonRpcRequest);
      return;
    }

    // JSON-RPC notification (no id) — these are Codex events
    if (!("id" in parsed) && "method" in parsed) {
      this.handleNotification(parsed as JsonRpcNotification);
      return;
    }

    // JSON-RPC response — some Codex builds return turn output/errors via
    // request responses instead of notifications.
    if ("id" in parsed) {
      this.handleResponse(parsed as JsonRpcResponse);
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const params = notification.params ?? {};

    if (notification.method === "thread/started") {
      const maybeThreadId = (params as { thread?: { id?: unknown } }).thread?.id;
      if (typeof maybeThreadId === "string" && maybeThreadId.length > 0) {
        this.threadId = maybeThreadId;
      }
      return;
    }

    if (notification.method === "turn/started") {
      const turnId = (params as { turn?: { id?: unknown } }).turn?.id;
      this.activeTurnId = typeof turnId === "string" ? turnId : null;
      this.enqueue(
        createUnifiedMessage({
          type: "stream_event",
          role: "assistant",
          metadata: { event: { type: "message_start", message: {} } },
        }),
      );
      return;
    }

    if (notification.method === "item/agentMessage/delta") {
      const delta = (params as { delta?: unknown }).delta;
      if (typeof delta === "string" && delta.length > 0) {
        this.enqueue(
          createUnifiedMessage({
            type: "stream_event",
            role: "assistant",
            metadata: {
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: delta },
              },
            },
          }),
        );
      }
      return;
    }

    if (notification.method === "item/completed") {
      const item = (params as { item?: { type?: string; id?: string; text?: string } }).item;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        this.enqueue(
          createUnifiedMessage({
            type: "assistant",
            role: "assistant",
            content: [{ type: "text", text: item.text }],
            metadata: { item_id: item.id },
          }),
        );
      }
      return;
    }

    if (notification.method === "turn/completed") {
      this.activeTurnId = null;
      const turn = (params as { turn?: { status?: string; error?: { message?: string } } }).turn;
      const status = turn?.status ?? "completed";
      const errorMessage = turn?.error?.message;
      this.enqueue(
        createUnifiedMessage({
          type: "result",
          role: "system",
          metadata: {
            status,
            is_error: status === "failed",
            error: errorMessage,
            errors: errorMessage ? [errorMessage] : undefined,
          },
        }),
      );
      return;
    }

    if (notification.method === "error") {
      const errorMessage = (params as { error?: { message?: unknown } }).error?.message;
      const message =
        typeof errorMessage === "string" && errorMessage.length > 0
          ? errorMessage
          : "Codex backend error";
      this.enqueue(
        createUnifiedMessage({
          type: "result",
          role: "system",
          metadata: {
            status: "failed",
            is_error: true,
            error: message,
            errors: [message],
          },
        }),
      );
      return;
    }

    if (notification.method === "approval_requested") {
      const request = params as unknown as CodexApprovalRequest;
      const unified = translateApprovalRequest(request);
      this.enqueue(unified);
      return;
    }

    // Support both:
    // 1) method-based notifications (method is event type), and
    // 2) wrapped event notifications ({ method: "event", params: { type: ... } }).
    const eventType =
      typeof (params as { type?: unknown }).type === "string"
        ? ((params as { type: string }).type as CodexTurnEvent["type"])
        : (notification.method as CodexTurnEvent["type"]);
    const event = { type: eventType, ...params } as unknown as CodexTurnEvent;
    const unified = translateCodexEvent(event);
    if (unified) {
      this.enqueue(unified);
    }
  }

  private handleServerRequest(request: JsonRpcRequest): void {
    const requestId = String(request.id);
    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval" ||
      request.method === "execCommandApproval" ||
      request.method === "applyPatchApproval"
    ) {
      this.pendingApprovalMethods.set(requestId, request.method);
      this.enqueue(
        createUnifiedMessage({
          type: "permission_request",
          role: "system",
          metadata: {
            request_id: requestId,
            tool_name: request.method,
            input: request.params ?? {},
            tool_use_id: requestId,
            description: "Codex requested approval to continue",
          },
        }),
      );
      return;
    }

    this.sendRpcError(request.id, `Unsupported server request method: ${request.method}`);
  }

  private handleResponse(response: JsonRpcResponse): void {
    if (typeof response.id === "number") {
      const pending = this.pendingRpc.get(response.id);
      if (pending) {
        this.pendingRpc.delete(response.id);
        pending.resolve(response);
        return;
      }
    }

    if (response.error) {
      this.enqueue(
        createUnifiedMessage({
          type: "result",
          role: "system",
          metadata: {
            status: "failed",
            is_error: true,
            error: response.error.message,
          },
        }),
      );
      return;
    }

    const maybeThreadId = this.extractThreadIdFromResult(response.result);
    if (maybeThreadId) {
      this.threadId = maybeThreadId;
    }
    const maybeTurnId = this.extractTurnIdFromResult(response.result);
    if (maybeTurnId) {
      this.activeTurnId = maybeTurnId;
    }

    const result = response.result as
      | CodexResponse
      | { response?: CodexResponse }
      | { output_text?: string }
      | null
      | undefined;
    const codexResponse =
      result && typeof result === "object" && "response" in result
        ? result.response
        : (result as CodexResponse | undefined);

    if (
      codexResponse &&
      typeof codexResponse === "object" &&
      Array.isArray((codexResponse as { output?: unknown }).output)
    ) {
      this.enqueueResponseItems(codexResponse);
      return;
    }

    if (
      result &&
      typeof result === "object" &&
      "output_text" in result &&
      typeof (result as { output_text?: unknown }).output_text === "string"
    ) {
      const text = (result as { output_text: string }).output_text;
      if (text.length > 0) {
        this.enqueue(
          createUnifiedMessage({
            type: "assistant",
            role: "assistant",
            content: [{ type: "text", text }],
            metadata: {},
          }),
        );
      }
      this.enqueue(
        createUnifiedMessage({
          type: "result",
          role: "system",
          metadata: { status: "completed" },
        }),
      );
    }
  }

  private extractThreadIdFromResult(result: unknown): string | null {
    if (!result || typeof result !== "object") return null;
    const withThread = result as { thread?: { id?: unknown }; conversationId?: unknown };
    if (typeof withThread.thread?.id === "string" && withThread.thread.id.length > 0) {
      return withThread.thread.id;
    }
    if (typeof withThread.conversationId === "string" && withThread.conversationId.length > 0) {
      return withThread.conversationId;
    }
    return null;
  }

  private extractTurnIdFromResult(result: unknown): string | null {
    if (!result || typeof result !== "object") return null;
    const withTurn = result as { turn?: { id?: unknown }; turnId?: unknown };
    if (typeof withTurn.turn?.id === "string" && withTurn.turn.id.length > 0) {
      return withTurn.turn.id;
    }
    if (typeof withTurn.turnId === "string" && withTurn.turnId.length > 0) {
      return withTurn.turnId;
    }
    return null;
  }

  private enqueueResponseItems(response: CodexResponse): void {
    const outputItems = Array.isArray(response.output) ? response.output : [];
    for (const item of outputItems) {
      if (item.type !== "message") continue;
      const text = this.itemToText(item);
      if (!text) continue;
      this.enqueue(
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text }],
          metadata: {
            item_id: item.id,
            status: item.status,
          },
        }),
      );
    }
    this.enqueue(
      createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: {
          status: response.status || "completed",
          response_id: response.id,
          output_items: outputItems.length,
        },
      }),
    );
  }

  private itemToText(item: CodexItem): string {
    if (!Array.isArray(item.content)) return "";
    return item.content
      .map((part: CodexItemContent): string => {
        if (part.type === "output_text") {
          return (part as CodexContentPart).text ?? "";
        }
        if (part.type === "refusal") {
          return (part as CodexRefusalPart).refusal ?? "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
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
      resolve({ value: undefined, done: true } as IteratorResult<UnifiedMessage>);
    }

    for (const pending of this.pendingRpc.values()) {
      pending.reject(new Error("Codex session closed before RPC response"));
    }
    this.pendingRpc.clear();
  }
}
