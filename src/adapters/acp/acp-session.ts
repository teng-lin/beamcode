/**
 * AcpSession — Phase 3
 *
 * A live ACP session wrapping a subprocess. Implements BackendSession by
 * translating UnifiedMessages ↔ JSON-RPC messages over stdio.
 */

import type { ChildProcess } from "node:child_process";
import type { BackendSession } from "../../core/interfaces/backend-adapter.js";
import { extractTraceContext, type MessageTracer } from "../../core/message-tracer.js";
import { createUnifiedMessage, type UnifiedMessage } from "../../core/types/unified-message.js";
import { translateToAcp } from "./inbound-translator.js";
import type { JsonRpcMessage } from "./json-rpc.js";
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type JsonRpcCodec,
} from "./json-rpc.js";
import type { AcpInitializeResult, ErrorClassifier } from "./outbound-translator.js";
import {
  translateAuthStatus,
  translateInitializeResult,
  translatePermissionRequest,
  translatePromptError,
  translatePromptResult,
  translateSessionUpdate,
} from "./outbound-translator.js";

/** Pending request resolution for request/response correlation. */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class AcpSession implements BackendSession {
  readonly sessionId: string;
  private readonly child: ChildProcess;
  private readonly codec: JsonRpcCodec;
  private readonly initResult: AcpInitializeResult;
  private readonly tracer?: MessageTracer;
  private readonly errorClassifier?: ErrorClassifier;
  private readonly pendingRequests = new Map<number | string, PendingRequest>();
  private pendingPermissionRequestId: number | string | undefined;
  private closed = false;
  /** Accumulated streaming text for synthesizing an assistant message when the prompt completes. */
  private streamedText = "";
  /** Whether a status_change(running) has been emitted for the current turn. */
  private turnRunningEmitted = false;

  constructor(
    sessionId: string,
    child: ChildProcess,
    codec: JsonRpcCodec,
    initResult: AcpInitializeResult,
    tracer?: MessageTracer,
    errorClassifier?: ErrorClassifier,
  ) {
    this.sessionId = sessionId;
    this.child = child;
    this.codec = codec;
    this.initResult = initResult;
    this.tracer = tracer;
    this.errorClassifier = errorClassifier;
  }

  send(message: UnifiedMessage): void {
    if (this.closed) throw new Error("Session is closed");

    // Reset turn state on new user prompt
    if (message.type === "user_message") {
      this.streamedText = "";
      this.turnRunningEmitted = false;
    }

    const trace = extractTraceContext(message.metadata);
    const action = translateToAcp(message, {
      pendingRequestId: this.pendingPermissionRequestId,
    });
    if (!action) return;

    // Override sessionId in params with the ACP session's actual ID
    // (beamcode's internal session ID differs from the one assigned by the agent)
    if (action.params && typeof action.params === "object" && "sessionId" in action.params) {
      (action.params as Record<string, unknown>).sessionId = this.sessionId;
    }
    this.tracer?.translate(
      "translateToAcp",
      "T2",
      { format: "UnifiedMessage", body: message },
      { format: "AcpOutboundAction", body: action },
      {
        sessionId: this.sessionId,
        traceId: trace.traceId,
        requestId: trace.requestId,
        command: trace.command,
        phase: "t2",
      },
    );

    let rpcMsg: JsonRpcMessage;

    switch (action.type) {
      case "request": {
        const { id, raw } = this.codec.createRequest(action.method!, action.params);
        rpcMsg = raw;
        this.pendingRequests.set(id, {
          resolve: () => {}, // Handled via routeMessage stream
          reject: () => {},
        });
        break;
      }
      case "notification": {
        rpcMsg = this.codec.createNotification(action.method!, action.params);
        break;
      }
      case "response": {
        if (action.requestId !== undefined) {
          rpcMsg = this.codec.createResponse(action.requestId, action.result);
          this.pendingPermissionRequestId = undefined;
        } else {
          return;
        }
        break;
      }
    }

    this.tracer?.send("backend", "native_outbound", rpcMsg, {
      sessionId: this.sessionId,
      traceId: trace.traceId,
      requestId: trace.requestId,
      command: trace.command,
      phase: "t2_send_native",
    });
    this.child.stdin?.write(this.codec.encode(rpcMsg));
  }

  sendRaw(_ndjson: string): void {
    throw new Error("AcpSession does not support raw NDJSON");
  }

  private cachedMessages: AsyncIterable<UnifiedMessage> | null = null;

  get messages(): AsyncIterable<UnifiedMessage> {
    if (!this.cachedMessages) {
      this.cachedMessages = this.createMessageStream();
    }
    return this.cachedMessages;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Reject any pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("Session closed"));
    }
    this.pendingRequests.clear();

    // Send SIGTERM and wait for exit with timeout
    const exitPromise = new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
    });

    this.child.kill("SIGTERM");

    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 5000);
    });

    await Promise.race([exitPromise, timeout]);
  }

  private createMessageStream(): AsyncIterable<UnifiedMessage> {
    const child = this.child;
    const codec = this.codec;
    const initResult = this.initResult;
    const session = this;

    return {
      [Symbol.asyncIterator]() {
        let buffer = "";
        const queue: UnifiedMessage[] = [];
        let resolve: ((value: IteratorResult<UnifiedMessage>) => void) | null = null;
        let done = false;

        // Yield the init result first
        queue.push(translateInitializeResult(initResult));

        const processLine = (line: string) => {
          if (!line.trim()) return;

          let msg: JsonRpcMessage;
          try {
            msg = codec.decode(line);
          } catch {
            session.tracer?.error(
              "backend",
              "native_inbound",
              "Failed to decode ACP JSON-RPC line",
              {
                sessionId: session.sessionId,
                action: "dropped",
                phase: "t3_parse",
                outcome: "parse_error",
              },
            );
            return; // Skip unparseable lines
          }
          session.tracer?.recv("backend", "native_inbound", msg, {
            sessionId: session.sessionId,
            phase: "t3_recv_native",
          });

          const results = session.routeMessage(msg);
          if (results.length === 0) return;
          for (const unified of results) {
            session.tracer?.translate(
              "routeMessage",
              "T3",
              { format: "AcpJsonRpc", body: msg },
              { format: "UnifiedMessage", body: unified },
              {
                sessionId: session.sessionId,
                phase: "t3",
              },
            );

            if (resolve) {
              const r = resolve;
              resolve = null;
              r({ value: unified, done: false });
            } else {
              queue.push(unified);
            }
          }
        };

        const onData = (chunk: Buffer) => {
          buffer += chunk.toString("utf-8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            processLine(line);
          }
        };

        const onClose = () => {
          done = true;
          if (resolve) {
            const r = resolve;
            resolve = null;
            r({ value: undefined, done: true } as IteratorResult<UnifiedMessage>);
          }
        };

        child.stdout?.on("data", onData);
        child.stdout?.on("close", onClose);

        return {
          next(): Promise<IteratorResult<UnifiedMessage>> {
            if (session.closed) {
              done = true;
              return Promise.resolve({
                value: undefined,
                done: true,
              } as IteratorResult<UnifiedMessage>);
            }
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (done) {
              return Promise.resolve({
                value: undefined,
                done: true,
              } as IteratorResult<UnifiedMessage>);
            }
            return new Promise<IteratorResult<UnifiedMessage>>((r) => {
              resolve = r;
            });
          },
          return(): Promise<IteratorResult<UnifiedMessage>> {
            child.stdout?.removeListener("data", onData);
            child.stdout?.removeListener("close", onClose);
            done = true;
            return Promise.resolve({
              value: undefined,
              done: true,
            } as IteratorResult<UnifiedMessage>);
          },
        };
      },
    };
  }

  /** Route a JSON-RPC message to the appropriate translator(s). */
  private routeMessage(msg: JsonRpcMessage): UnifiedMessage[] {
    if (isJsonRpcNotification(msg)) {
      if (msg.method === "session/update") {
        // ACP session/update comes in two shapes:
        //   nested: {sessionId, update: {sessionUpdate, ...}}
        //   flat:   {sessionId, sessionUpdate, ...}
        // Support both by detecting which format was used.
        const raw = msg.params as Record<string, unknown>;
        const flattened = (
          raw.update && typeof raw.update === "object"
            ? { sessionId: raw.sessionId as string, ...(raw.update as Record<string, unknown>) }
            : raw
        ) as Parameters<typeof translateSessionUpdate>[0];

        // Accumulate text from agent_message_chunk for synthesizing the final assistant message
        if (flattened.sessionUpdate === "agent_message_chunk") {
          const content = flattened.content as { text?: string } | undefined;
          if (content?.text) this.streamedText += content.text;

          if (!this.turnRunningEmitted) {
            this.turnRunningEmitted = true;
            return [
              createUnifiedMessage({
                type: "status_change",
                role: "system",
                metadata: { session_id: this.sessionId, status: "running" },
              }),
              translateSessionUpdate(flattened),
            ];
          }
        }

        return [translateSessionUpdate(flattened)];
      }
      this.tracer?.error("backend", msg.method, "ACP notification not mapped to UnifiedMessage", {
        sessionId: this.sessionId,
        action: "dropped",
        phase: "t3",
        outcome: "unmapped_type",
      });
      return [];
    }

    if (isJsonRpcRequest(msg)) {
      if (msg.method === "session/request_permission") {
        this.pendingPermissionRequestId = msg.id;
        return [
          translatePermissionRequest(
            msg.params as Parameters<typeof translatePermissionRequest>[0],
          ),
        ];
      }

      // Agent-initiated fs/terminal requests — stub with error for now
      if (msg.method?.startsWith("fs/") || msg.method?.startsWith("terminal/")) {
        const errResp = this.codec.createErrorResponse(msg.id, -32601, "Method not supported");
        this.child.stdin?.write(this.codec.encode(errResp));
        return [];
      }

      return [];
    }

    if (isJsonRpcResponse(msg)) {
      // Check if it's a prompt result (response to session/prompt)
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          this.streamedText = "";
          this.turnRunningEmitted = false;
          const result = translatePromptError(this.sessionId, msg.error, this.errorClassifier);

          // Emit auth_status before result so the frontend can show auth state
          if (result.metadata.error_code === "provider_auth") {
            const data = msg.error.data as
              | { validationLink?: string; validationDescription?: string; learnMoreUrl?: string }
              | undefined;
            return [translateAuthStatus(this.sessionId, msg.error.message, data), result];
          }

          return [result];
        }
      }

      // Prompt completed — synthesize an assistant message from accumulated streamed text
      // so the frontend can clear streaming state and show the final message.
      // ACP doesn't send an explicit "assistant" message like Claude does.
      if (msg.result && typeof msg.result === "object" && "stopReason" in msg.result) {
        const messages: UnifiedMessage[] = [];
        if (this.streamedText) {
          messages.push(
            createUnifiedMessage({
              type: "assistant",
              role: "assistant",
              content: [{ type: "text", text: this.streamedText }],
              metadata: { sessionId: this.sessionId },
            }),
          );
        }
        this.streamedText = "";
        this.turnRunningEmitted = false;
        messages.push(
          translatePromptResult(msg.result as Parameters<typeof translatePromptResult>[0]),
        );
        return messages;
      }

      return [];
    }

    return [];
  }
}
