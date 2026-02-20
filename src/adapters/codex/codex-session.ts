/**
 * CodexSession — a live WebSocket connection to a codex app-server.
 *
 * Implements BackendSession by translating between UnifiedMessage
 * and Codex's JSON-RPC 2.0 protocol over WebSocket.
 */

import WebSocket from "ws";
import { AsyncMessageQueue } from "../../core/async-message-queue.js";
import type { BackendSession } from "../../core/interfaces/backend-adapter.js";
import {
  extractTraceContext,
  type MessageTracer,
  type TraceContext,
} from "../../core/message-tracer.js";
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
  tracer?: MessageTracer;
}

export class CodexSession implements BackendSession {
  readonly sessionId: string;
  private readonly ws: WebSocket;
  private readonly launcher: CodexLauncher;
  private nextRpcId = 1;
  private closed = false;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private readonly tracer?: MessageTracer;

  /** The current Codex thread ID (null until first message initializes a thread). */
  get currentThreadId(): string | null {
    return this.threadId;
  }
  private initializingThread: Promise<void> | null = null;
  private queuedTurnInputs: Array<{ text: string; trace?: TraceContext }> = [];
  private currentTrace?: TraceContext;
  private pendingApprovalMethods = new Map<string, string>();
  private pendingRpc = new Map<
    number,
    {
      resolve: (response: JsonRpcResponse) => void;
      reject: (error: Error) => void;
      method: string;
    }
  >();

  private readonly queue = new AsyncMessageQueue<UnifiedMessage>();

  constructor(options: CodexSessionOptions) {
    this.sessionId = options.sessionId;
    this.ws = options.ws;
    this.launcher = options.launcher;
    this.threadId = options.threadId ?? null;
    this.tracer = options.tracer;

    if (options.initResponse) {
      this.queue.enqueue(translateInitResponse(options.initResponse));
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

    const trace = this.traceFromUnified(message);
    const action = translateToCodex(message);
    this.tracer?.translate(
      "translateToCodex",
      "T2",
      { format: "UnifiedMessage", body: message },
      { format: "CodexAction", body: action },
      {
        sessionId: this.sessionId,
        traceId: trace.traceId,
        requestId: trace.requestId,
        command: trace.command,
        phase: "t2",
      },
    );

    switch (action.type) {
      case "turn":
        this.sendTurnInput(action.input ?? "", trace);
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
    return this.queue;
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

  private sendRpcRequest(
    method: string,
    params?: Record<string, unknown>,
    trace?: TraceContext,
  ): number {
    const id = this.nextRpcId++;
    const msg: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    this.tracer?.send("backend", "native_outbound", msg, {
      sessionId: this.sessionId,
      traceId: trace?.traceId,
      requestId: trace?.requestId,
      command: trace?.command,
      phase: "t2_send_native",
    });
    this.ws.send(JSON.stringify(msg));
    return id;
  }

  private sendRpcNotification(
    method: string,
    params?: Record<string, unknown>,
    trace?: TraceContext,
  ): void {
    const msg: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.tracer?.send("backend", "native_outbound", msg, {
      sessionId: this.sessionId,
      traceId: trace?.traceId,
      requestId: trace?.requestId,
      command: trace?.command,
      phase: "t2_send_native",
    });
    this.ws.send(JSON.stringify(msg));
  }

  private sendRpcResult(id: number | string, result: unknown, trace?: TraceContext): void {
    const msg = { jsonrpc: "2.0" as const, id, result };
    this.tracer?.send("backend", "native_outbound", msg, {
      sessionId: this.sessionId,
      traceId: trace?.traceId,
      requestId: trace?.requestId,
      command: trace?.command,
      phase: "t2_send_native",
    });
    this.ws.send(JSON.stringify(msg));
  }

  private sendRpcError(
    id: number | string,
    message: string,
    code = -32601,
    trace?: TraceContext,
  ): void {
    const msg = { jsonrpc: "2.0" as const, id, error: { code, message } };
    this.tracer?.send("backend", "native_outbound", msg, {
      sessionId: this.sessionId,
      traceId: trace?.traceId,
      requestId: trace?.requestId,
      command: trace?.command,
      phase: "t2_send_native",
    });
    this.ws.send(JSON.stringify(msg));
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

  private sendTurnInput(text: string, trace?: TraceContext): void {
    this.queuedTurnInputs.push({ text, trace });
    if (this.threadId) {
      this.flushQueuedTurns();
      return;
    }
    void this.ensureThreadInitialized()
      .then(() => this.flushQueuedTurns())
      .catch((err) => {
        this.queuedTurnInputs = [];
        this.queue.enqueue(
          createUnifiedMessage({
            type: "result",
            role: "system",
            metadata: {
              is_error: true,
              status: "failed",
              error: err instanceof Error ? err.message : String(err),
              trace_id: trace?.traceId,
              slash_request_id: trace?.requestId,
              slash_command: trace?.command,
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
    this.currentTrace = undefined;
    await this.ensureThreadInitialized();
    return this.threadId!;
  }

  private flushQueuedTurns(): void {
    if (!this.threadId) return;
    while (this.queuedTurnInputs.length > 0) {
      const next = this.queuedTurnInputs.shift();
      if (!next) continue;
      this.currentTrace = next.trace;
      this.sendRpcRequest(
        "turn/start",
        {
          threadId: this.threadId,
          input: [{ type: "text", text: next.text }],
        },
        next.trace,
      );
    }
  }

  private interruptTurn(): void {
    if (this.threadId && this.activeTurnId) {
      this.sendRpcRequest(
        "turn/interrupt",
        {
          threadId: this.threadId,
          turnId: this.activeTurnId,
        },
        this.currentTrace,
      );
      return;
    }
    // Legacy fallback
    this.sendRpcNotification("turn.cancel", undefined, this.currentTrace);
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
      this.sendRpcResult(id, { decision: approve ? "accept" : "decline" }, this.currentTrace);
      return;
    }
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      this.sendRpcResult(id, { decision: approve ? "approved" : "denied" }, this.currentTrace);
      return;
    }

    this.sendRpcError(id, `Unsupported approval method: ${method}`, -32601, this.currentTrace);
  }

  // ---------------------------------------------------------------------------
  // Incoming message handling
  // ---------------------------------------------------------------------------

  private handleRawMessage(data: WebSocket.RawData): void {
    let parsed: JsonRpcMessage;
    const raw = data.toString();
    try {
      parsed = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      this.tracer?.error("backend", "native_inbound", "Failed to parse codex JSON-RPC message", {
        sessionId: this.sessionId,
        action: "dropped",
        phase: "t3_parse",
        outcome: "parse_error",
      });
      return;
    }
    this.tracer?.recv("backend", "native_inbound", parsed, {
      sessionId: this.sessionId,
      traceId: this.currentTrace?.traceId,
      requestId: this.currentTrace?.requestId,
      command: this.currentTrace?.command,
      phase: "t3_recv_native",
    });

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
    // Capture trace context once at entry so later clears of currentTrace
    // don't affect trace events emitted within this handler invocation.
    const trace = this.currentTrace;

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
      this.enqueueTranslated(
        notification,
        createUnifiedMessage({
          type: "stream_event",
          role: "assistant",
          metadata: { event: { type: "message_start", message: {} } },
        }),
        "codex.turn_started",
      );
      return;
    }

    if (notification.method === "item/agentMessage/delta") {
      const delta = (params as { delta?: unknown }).delta;
      if (typeof delta === "string" && delta.length > 0) {
        this.enqueueTranslated(
          notification,
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
          "codex.agent_message_delta",
        );
      }
      return;
    }

    if (notification.method === "item/completed") {
      const item = (params as { item?: { type?: string; id?: string; text?: string } }).item;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        this.enqueueTranslated(
          notification,
          createUnifiedMessage({
            type: "assistant",
            role: "assistant",
            content: [{ type: "text", text: item.text }],
            metadata: { item_id: item.id },
          }),
          "codex.item_completed",
        );
      }
      return;
    }

    if (notification.method === "turn/completed") {
      this.activeTurnId = null;
      const turn = (params as { turn?: { status?: string; error?: { message?: string } } }).turn;
      const status = turn?.status ?? "completed";
      const errorMessage = turn?.error?.message;
      this.enqueueTranslated(
        notification,
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
        "codex.turn_completed",
      );
      this.currentTrace = undefined;
      return;
    }

    if (notification.method === "error") {
      const errorMessage = (params as { error?: { message?: unknown } }).error?.message;
      const errorInfo = (params as { error?: { codexErrorInfo?: string } }).error?.codexErrorInfo;
      const message =
        typeof errorMessage === "string" && errorMessage.length > 0
          ? errorMessage
          : "Codex backend error";
      this.enqueueTranslated(
        notification,
        createUnifiedMessage({
          type: "result",
          role: "system",
          metadata: {
            status: "failed",
            is_error: true,
            error: message,
            errors: [message],
            error_code: errorInfo,
          },
        }),
        "codex.error",
      );
      this.currentTrace = undefined;
      return;
    }

    // Legacy wrapped error: codex/event/error → params.msg.{message, codex_error_info}
    if (notification.method === "codex/event/error") {
      const msg = (params as { msg?: { message?: string; codex_error_info?: string } }).msg;
      const message = msg?.message || "Codex backend error";
      const errorCode = msg?.codex_error_info;
      this.enqueueTranslated(
        notification,
        createUnifiedMessage({
          type: "result",
          role: "system",
          metadata: {
            status: "failed",
            is_error: true,
            error: message,
            errors: [message],
            error_code: errorCode,
          },
        }),
        "codex.legacy_error",
      );
      this.currentTrace = undefined;
      return;
    }

    if (notification.method === "approval_requested") {
      const request = params as unknown as CodexApprovalRequest;
      const unified = translateApprovalRequest(request);
      this.enqueueTranslated(notification, unified, "translateApprovalRequest");
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
      this.enqueueTranslated(notification, unified, "translateCodexEvent");
      if (
        unified.type === "result" &&
        ((unified.metadata.status as string | undefined) === "completed" ||
          (unified.metadata.status as string | undefined) === "failed")
      ) {
        this.currentTrace = undefined;
      }
    } else {
      this.tracer?.error(
        "backend",
        notification.method,
        "Codex notification did not map to UnifiedMessage",
        {
          sessionId: this.sessionId,
          traceId: trace?.traceId,
          requestId: trace?.requestId,
          command: trace?.command,
          action: "dropped",
          phase: "t3",
          outcome: "unmapped_type",
        },
      );
    }
  }

  private handleServerRequest(request: JsonRpcRequest): void {
    // Capture trace context once so it isn't affected if currentTrace is
    // cleared by a concurrent notification processed in the same tick.
    const trace = this.currentTrace;
    const requestId = String(request.id);
    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval" ||
      request.method === "execCommandApproval" ||
      request.method === "applyPatchApproval"
    ) {
      this.pendingApprovalMethods.set(requestId, request.method);
      this.enqueueTranslated(
        request,
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
        "codex.server_request_permission",
      );
      return;
    }

    this.sendRpcError(
      request.id,
      `Unsupported server request method: ${request.method}`,
      -32601,
      trace,
    );
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
      this.enqueueTranslated(
        response,
        createUnifiedMessage({
          type: "result",
          role: "system",
          metadata: {
            status: "failed",
            is_error: true,
            error: response.error.message,
          },
        }),
        "codex.response_error",
      );
      this.currentTrace = undefined;
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
        this.enqueueTranslated(
          response,
          createUnifiedMessage({
            type: "assistant",
            role: "assistant",
            content: [{ type: "text", text }],
            metadata: {},
          }),
          "codex.output_text",
        );
      }
      this.enqueueTranslated(
        response,
        createUnifiedMessage({
          type: "result",
          role: "system",
          metadata: { status: "completed" },
        }),
        "codex.output_text",
      );
      this.currentTrace = undefined;
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
      const msg = this.translateResponseItem(item);
      if (msg) this.enqueueTranslated(item, msg, "codex.response_item");
    }
    this.enqueueTranslated(
      response,
      createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: {
          status: response.status || "completed",
          response_id: response.id,
          output_items: outputItems.length,
        },
      }),
      "codex.response_complete",
    );
    this.currentTrace = undefined;
  }

  private translateResponseItem(item: CodexItem): UnifiedMessage | null {
    switch (item.type) {
      case "message": {
        const text = this.itemToText(item);
        if (!text) return null;
        return createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text }],
          metadata: { item_id: item.id, status: item.status },
        });
      }
      case "function_call":
        return createUnifiedMessage({
          type: "tool_progress",
          role: "tool",
          metadata: {
            name: item.name,
            arguments: item.arguments,
            call_id: item.call_id,
            item_id: item.id,
            status: item.status,
            done: true,
          },
        });
      case "function_call_output":
        return createUnifiedMessage({
          type: "tool_use_summary",
          role: "tool",
          metadata: {
            output: item.output,
            call_id: item.call_id,
            item_id: item.id,
            status: item.status,
          },
        });
      default:
        return null;
    }
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

  private applyTraceToUnified(unified: UnifiedMessage): UnifiedMessage {
    if (this.currentTrace?.traceId) unified.metadata.trace_id = this.currentTrace.traceId;
    if (this.currentTrace?.requestId)
      unified.metadata.slash_request_id = this.currentTrace.requestId;
    if (this.currentTrace?.command) unified.metadata.slash_command = this.currentTrace.command;
    return unified;
  }

  private enqueueTranslated(native: unknown, unified: UnifiedMessage, translator: string): void {
    const traced = this.applyTraceToUnified(unified);
    this.tracer?.translate(
      translator,
      "T3",
      { format: "CodexNative", body: native },
      { format: "UnifiedMessage", body: traced },
      {
        sessionId: this.sessionId,
        traceId: this.currentTrace?.traceId,
        requestId: this.currentTrace?.requestId,
        command: this.currentTrace?.command,
        phase: "t3",
      },
    );
    this.queue.enqueue(traced);
  }

  private traceFromUnified(message: UnifiedMessage): TraceContext {
    return extractTraceContext(message.metadata);
  }

  // ---------------------------------------------------------------------------
  // Queue management
  // ---------------------------------------------------------------------------

  private finish(): void {
    if (this.queue.isFinished) return;
    this.queue.finish();

    for (const pending of this.pendingRpc.values()) {
      pending.reject(new Error("Codex session closed before RPC response"));
    }
    this.pendingRpc.clear();
  }
}
