/**
 * AcpSession — Phase 3
 *
 * A live ACP session wrapping a subprocess. Implements BackendSession by
 * translating UnifiedMessages ↔ JSON-RPC messages over stdio.
 */

import type { ChildProcess } from "node:child_process";
import type { BackendSession } from "../../core/interfaces/backend-adapter.js";
import type { UnifiedMessage } from "../../core/types/unified-message.js";
import { translateToAcp } from "./inbound-translator.js";
import type { JsonRpcMessage } from "./json-rpc.js";
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type JsonRpcCodec,
} from "./json-rpc.js";
import type { AcpInitializeResult } from "./outbound-translator.js";
import {
  translateInitializeResult,
  translatePermissionRequest,
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
  private readonly pendingRequests = new Map<number | string, PendingRequest>();
  private pendingPermissionRequestId: number | string | undefined;
  private closed = false;

  constructor(
    sessionId: string,
    child: ChildProcess,
    codec: JsonRpcCodec,
    initResult: AcpInitializeResult,
  ) {
    this.sessionId = sessionId;
    this.child = child;
    this.codec = codec;
    this.initResult = initResult;
  }

  send(message: UnifiedMessage): void {
    if (this.closed) throw new Error("Session is closed");

    const action = translateToAcp(message, {
      pendingRequestId: this.pendingPermissionRequestId,
    });
    if (!action) return;

    let rpcMsg: JsonRpcMessage;

    switch (action.type) {
      case "request": {
        const { raw } = this.codec.createRequest(action.method!, action.params);
        rpcMsg = raw;
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
            return; // Skip unparseable lines
          }

          const unified = session.routeMessage(msg);
          if (!unified) return;

          if (resolve) {
            const r = resolve;
            resolve = null;
            r({ value: unified, done: false });
          } else {
            queue.push(unified);
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

  /** Route a JSON-RPC message to the appropriate translator. Returns null for handled responses. */
  private routeMessage(msg: JsonRpcMessage): UnifiedMessage | null {
    if (isJsonRpcNotification(msg)) {
      if (msg.method === "session/update") {
        return translateSessionUpdate(msg.params as Parameters<typeof translateSessionUpdate>[0]);
      }
      return null;
    }

    if (isJsonRpcRequest(msg)) {
      if (msg.method === "session/request_permission") {
        this.pendingPermissionRequestId = msg.id;
        return translatePermissionRequest(
          msg.params as Parameters<typeof translatePermissionRequest>[0],
        );
      }

      // Agent-initiated fs/terminal requests — stub with error for now
      if (msg.method?.startsWith("fs/") || msg.method?.startsWith("terminal/")) {
        const errResp = this.codec.createErrorResponse(msg.id, -32601, "Method not supported");
        this.child.stdin?.write(this.codec.encode(errResp));
        return null;
      }

      return null;
    }

    if (isJsonRpcResponse(msg)) {
      // Check if it's a prompt result (response to session/prompt)
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
        return null;
      }

      // If no pending request matches, treat as a prompt result
      if (msg.result && typeof msg.result === "object" && "stopReason" in msg.result) {
        return translatePromptResult(msg.result as Parameters<typeof translatePromptResult>[0]);
      }

      return null;
    }

    return null;
  }
}
