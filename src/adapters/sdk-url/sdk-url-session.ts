/**
 * SdkUrlSession — a live WebSocket connection to a Claude Code CLI process.
 *
 * Implements BackendSession by translating between UnifiedMessage
 * and the SDK-URL NDJSON protocol over WebSocket.
 *
 * The constructor accepts a deferred `socketPromise` so the session can
 * queue outbound messages before the WebSocket handshake completes.
 */

import type WebSocket from "ws";
import type { RawData } from "ws";
import type { BackendSession } from "../../core/interfaces/backend-adapter.js";
import type { UnifiedMessage } from "../../core/types/unified-message.js";
import type { CLIMessage } from "../../types/cli-messages.js";
import { NDJSONLineBuffer } from "../../utils/ndjson.js";
import { toNDJSON } from "./inbound-translator.js";
import { translate } from "./message-translator.js";

// ---------------------------------------------------------------------------
// SdkUrlSession
// ---------------------------------------------------------------------------

export class SdkUrlSession implements BackendSession {
  readonly sessionId: string;

  private socket: WebSocket | null = null;
  private readonly outboundQueue: string[] = [];
  private closed = false;
  private passthroughHandler: ((rawMsg: CLIMessage) => boolean) | null = null;
  private readonly lineBuffer = new NDJSONLineBuffer();

  // Async iterable queue (same pattern as CodexSession)
  private readonly messageQueue: UnifiedMessage[] = [];
  private messageResolve: ((value: IteratorResult<UnifiedMessage>) => void) | null = null;
  private done = false;

  constructor(opts: { sessionId: string; socketPromise: Promise<WebSocket> }) {
    this.sessionId = opts.sessionId;
    opts.socketPromise.then(
      (ws) => this.attachSocket(ws),
      () => this.finish(), // socket delivery failed (timeout/cancel)
    );
  }

  // ---------------------------------------------------------------------------
  // Passthrough interception
  // ---------------------------------------------------------------------------

  /** Set a handler for intercepting passthrough CLI echo messages (e.g., /cost, /context). */
  setPassthroughHandler(handler: ((rawMsg: CLIMessage) => boolean) | null): void {
    this.passthroughHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // BackendSession — send
  // ---------------------------------------------------------------------------

  send(message: UnifiedMessage): void {
    if (this.closed) throw new Error("Session is closed");
    const ndjson = toNDJSON(message);
    if (ndjson === null) {
      console.warn(
        `[SdkUrlSession] toNDJSON returned null for message type "${message.type}" — message not sent`,
      );
      return;
    }
    this.sendToSocket(ndjson);
  }

  // ---------------------------------------------------------------------------
  // BackendSession — sendRaw
  // ---------------------------------------------------------------------------

  /** Send a raw NDJSON string to the backend (bypass UnifiedMessage translation). */
  sendRaw(ndjson: string): void {
    if (this.closed) throw new Error("Session is closed");
    this.sendToSocket(ndjson);
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
            if (queued) return Promise.resolve({ value: queued, done: false });
            if (self.done)
              return Promise.resolve({
                value: undefined,
                done: true,
              } as IteratorResult<UnifiedMessage>);
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

    if (this.socket && this.socket.readyState === 1 /* WebSocket.OPEN */) {
      this.socket.close();
    }

    this.finish();
  }

  // ---------------------------------------------------------------------------
  // Internal — socket attachment
  // ---------------------------------------------------------------------------

  private attachSocket(ws: WebSocket): void {
    if (this.closed) {
      ws.close();
      return;
    }
    this.socket = ws;

    // Flush queued outbound messages
    for (const ndjson of this.outboundQueue) {
      ws.send(ndjson);
    }
    this.outboundQueue.length = 0;

    // Listen for incoming messages
    ws.on("message", (data: RawData) => {
      this.handleIncoming(data);
    });

    ws.on("close", () => {
      this.handleBufferedRemainder();
      this.finish();
    });

    ws.on("error", () => {
      this.finish();
    });
  }

  // ---------------------------------------------------------------------------
  // Internal — outbound
  // ---------------------------------------------------------------------------

  private sendToSocket(ndjson: string): void {
    const line = ndjson.endsWith("\n") ? ndjson : `${ndjson}\n`;
    if (this.socket) {
      this.socket.send(line);
    } else {
      this.outboundQueue.push(line);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — incoming message handling
  // ---------------------------------------------------------------------------

  private handleIncoming(data: RawData): void {
    const raw = typeof data === "string" ? data : data.toString();
    // Some transports deliver one complete JSON object per WebSocket frame
    // (without newline delimiters). Fast-path that shape first.
    if (!raw.includes("\n")) {
      try {
        const cliMsg = JSON.parse(raw.trim()) as CLIMessage;
        this.processCliMessage(cliMsg);
        return;
      } catch {
        // fall through to line-buffer mode for NDJSON/chunked inputs
      }
    }

    const lines = this.lineBuffer.feed(raw);
    for (const line of lines) {
      let cliMsg: CLIMessage;
      try {
        cliMsg = JSON.parse(line) as CLIMessage;
      } catch {
        continue;
      }
      this.processCliMessage(cliMsg);
    }
  }

  private handleBufferedRemainder(): void {
    const line = this.lineBuffer.flush();
    if (!line) return;
    try {
      const cliMsg = JSON.parse(line) as CLIMessage;
      this.processCliMessage(cliMsg);
    } catch {
      // ignore invalid/incomplete trailing fragment
    }
  }

  private processCliMessage(cliMsg: CLIMessage): void {
    if (cliMsg.type === "user" && this.passthroughHandler?.(cliMsg)) {
      return;
    }
    const unified = translate(cliMsg);
    if (unified) {
      this.enqueue(unified);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — queue management
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
  }
}
