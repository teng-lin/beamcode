/**
 * ClaudeSession — a live WebSocket connection to a Claude Code CLI process.
 *
 * Implements BackendSession by translating between UnifiedMessage
 * and the Claude NDJSON protocol over WebSocket.
 *
 * The constructor accepts a deferred `socketPromise` so the session can
 * queue outbound messages before the WebSocket handshake completes.
 */

import type WebSocket from "ws";
import type { RawData } from "ws";
import { AsyncMessageQueue } from "../../core/async-message-queue.js";
import type { BackendSession } from "../../core/interfaces/backend-adapter.js";
import type { MessageTracer } from "../../core/message-tracer.js";
import type { UnifiedMessage } from "../../core/types/unified-message.js";
import type { Logger } from "../../interfaces/logger.js";
import type { CLIMessage } from "../../types/cli-messages.js";
import { NDJSONLineBuffer } from "../../utils/ndjson.js";
import { noopLogger } from "../noop-logger.js";
import { toNDJSON } from "./inbound-translator.js";
import { translate } from "./message-translator.js";

// ---------------------------------------------------------------------------
// ClaudeSession
// ---------------------------------------------------------------------------

export class ClaudeSession implements BackendSession {
  readonly sessionId: string;

  private socket: WebSocket | null = null;
  private readonly outboundQueue: string[] = [];
  private closed = false;
  private passthroughHandler: ((rawMsg: CLIMessage) => boolean) | null = null;
  private readonly lineBuffer = new NDJSONLineBuffer();
  private readonly queue = new AsyncMessageQueue<UnifiedMessage>();
  private readonly logger: Logger;
  private readonly tracer?: MessageTracer;

  constructor(opts: {
    sessionId: string;
    socketPromise: Promise<WebSocket>;
    logger?: Logger;
    tracer?: MessageTracer;
  }) {
    this.sessionId = opts.sessionId;
    this.logger = opts.logger ?? noopLogger;
    this.tracer = opts.tracer;
    opts.socketPromise.then(
      (ws) => this.attachSocket(ws),
      () => this.queue.finish(), // socket delivery failed (timeout/cancel)
    );
  }

  // ---------------------------------------------------------------------------
  // Passthrough interception
  // ---------------------------------------------------------------------------

  /** Set a handler for intercepting passthrough CLI echo messages (e.g., /context). */
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
      this.logger.warn("toNDJSON returned null, message not sent", { messageType: message.type });
      return;
    }
    this.tracer?.translate(
      "toNDJSON",
      "T2",
      { format: "UnifiedMessage", body: message },
      { format: "Claude NDJSON", body: ndjson },
      { sessionId: this.sessionId },
    );
    this.tracer?.send("backend", message.type, message, { sessionId: this.sessionId });
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
    return this.queue;
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

    this.queue.finish();
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
      this.queue.finish();
    });

    ws.on("error", () => {
      this.queue.finish();
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
        this.traceUnparsedLine(line, "Failed to parse CLI NDJSON line");
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
      this.traceUnparsedLine(line, "Failed to parse trailing CLI NDJSON fragment");
    }
  }

  private processCliMessage(cliMsg: CLIMessage): void {
    if (cliMsg.type === "user" && this.passthroughHandler?.(cliMsg)) {
      return;
    }
    const unified = translate(cliMsg);
    if (unified) {
      this.tracer?.translate(
        "translate",
        "T3",
        { format: "Claude CLIMessage", body: cliMsg },
        { format: "UnifiedMessage", body: unified },
        { sessionId: this.sessionId },
      );
      this.queue.enqueue(unified);
    } else {
      const consumedType = cliMsg.type === "user" || cliMsg.type === "keep_alive";
      this.tracer?.error(
        "backend",
        cliMsg.type ?? "unknown",
        consumedType
          ? "T3 translate returned null (intentionally consumed CLI message type)"
          : "T3 translate returned null (unmapped CLI message type)",
        {
          sessionId: this.sessionId,
          action: consumedType ? "consumed" : "dropped",
        },
      );
    }
  }

  private traceUnparsedLine(line: string, error: string): void {
    const maxChars = 2_000;
    const truncated =
      line.length > maxChars ? `${line.slice(0, maxChars)}...[truncated ${line.length}]` : line;
    this.tracer?.recv(
      "backend",
      "raw_unparsed_line",
      { raw: truncated },
      { sessionId: this.sessionId },
    );
    this.tracer?.error("backend", "raw_unparsed_line", error, {
      sessionId: this.sessionId,
      action: "dropped",
    });
  }
}
