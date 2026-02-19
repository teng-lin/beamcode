/**
 * OpencodeAdapter -- BackendAdapter for the opencode serve REST + SSE protocol.
 *
 * Manages one shared opencode server process and a single SSE connection,
 * demuxing incoming SSE events to the correct session.
 */

import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";
import type { Logger } from "../../interfaces/logger.js";
import type { ProcessManager } from "../../interfaces/process-manager.js";
import { OpencodeHttpClient } from "./opencode-http-client.js";
import { OpencodeLauncher } from "./opencode-launcher.js";
import { extractSessionId } from "./opencode-message-translator.js";
import { OpencodeSession } from "./opencode-session.js";
import type { OpencodeEvent } from "./opencode-types.js";
import { parseSseStream } from "./sse-parser.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OpencodeAdapterOptions {
  processManager: ProcessManager;
  logger?: Logger;
  port?: number;
  hostname?: string;
  opencodeBinary?: string;
  password?: string;
  directory?: string;
}

// ---------------------------------------------------------------------------
// OpencodeAdapter
// ---------------------------------------------------------------------------

export class OpencodeAdapter implements BackendAdapter {
  readonly name = "opencode" as const;

  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: false,
  };

  private readonly launcher: OpencodeLauncher;
  private readonly logger?: Logger;
  private readonly port: number;
  private readonly hostname: string;
  private readonly opencodeBinary?: string;
  private readonly password?: string;
  private readonly directory: string;

  private httpClient?: OpencodeHttpClient;
  private serverInfo?: { url: string; pid: number };
  private sseAbortController?: AbortController;
  private launchPromise?: Promise<void>;

  private readonly subscribers = new Map<string, (event: OpencodeEvent) => void>();

  constructor(options: OpencodeAdapterOptions) {
    this.logger = options.logger;
    this.port = options.port ?? 4096;
    this.hostname = options.hostname ?? "127.0.0.1";
    this.opencodeBinary = options.opencodeBinary;
    this.password = options.password;
    this.directory = options.directory ?? process.cwd();

    this.launcher = new OpencodeLauncher({
      processManager: options.processManager,
      logger: options.logger,
    });

    // Prevent Node's unhandled-error throw — spawn failures are also
    // surfaced via the thrown Error from launch(), so the event is redundant.
    this.launcher.on("error", ({ source, error }) => {
      this.logger?.warn?.(`Launcher error [${source}]: ${error.message}`);
    });
  }

  // -------------------------------------------------------------------------
  // BackendAdapter -- connect
  // -------------------------------------------------------------------------

  async connect(options: ConnectOptions): Promise<BackendSession> {
    // 1. Launch server if not already running (race-safe via stored promise)
    if (!this.launchPromise) {
      this.launchPromise = this.ensureServer();
    }
    await this.launchPromise;

    // 2. Create a session via the HTTP client
    const { id: opcSessionId } = await this.httpClient!.createSession({
      title: options.sessionId,
    });

    // 3. Create and return the OpencodeSession
    return new OpencodeSession({
      sessionId: options.sessionId,
      opcSessionId,
      httpClient: this.httpClient!,
      subscribe: (handler) => this.addSubscriber(opcSessionId, handler),
    });
  }

  private async ensureServer(): Promise<void> {
    this.serverInfo = await this.launcher.launch("server", {
      port: this.port,
      hostname: this.hostname,
      opencodeBinary: this.opencodeBinary,
      password: this.password,
      cwd: this.directory,
    });

    this.httpClient = new OpencodeHttpClient({
      baseUrl: this.serverInfo.url,
      directory: this.directory,
      password: this.password,
    });

    this.startSseLoop();
  }

  // -------------------------------------------------------------------------
  // SSE event loop
  // -------------------------------------------------------------------------

  private static readonly SSE_MAX_RETRIES = 3;
  private static readonly SSE_RETRY_BASE_MS = 1000;

  private startSseLoop(): void {
    this.sseAbortController = new AbortController();
    const signal = this.sseAbortController.signal;

    void this.runSseLoopWithRetry(signal);
  }

  private async runSseLoopWithRetry(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;

    while (!signal.aborted) {
      try {
        await this.runSseLoop(signal);
        // Stream ended normally — reset failure counter
        consecutiveFailures = 0;
      } catch (err) {
        if (signal.aborted) return;
        this.logger?.error?.("SSE event loop error", { error: err });
        consecutiveFailures++;
      }

      if (signal.aborted) return;

      if (consecutiveFailures > OpencodeAdapter.SSE_MAX_RETRIES) {
        this.notifyAllSessions("SSE connection lost after retries exhausted");
        return;
      }

      const delay =
        consecutiveFailures > 0
          ? OpencodeAdapter.SSE_RETRY_BASE_MS * 2 ** (consecutiveFailures - 1)
          : 0;

      if (delay > 0) {
        this.logger?.debug?.("SSE reconnecting", { attempt: consecutiveFailures, delay });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async runSseLoop(signal: AbortSignal): Promise<void> {
    const stream = await this.httpClient!.connectSse(signal);

    for await (const sseEvent of parseSseStream(stream)) {
      if (signal.aborted) break;

      let event: OpencodeEvent;
      try {
        event = JSON.parse(sseEvent.data) as OpencodeEvent;
      } catch {
        this.logger?.debug?.("Failed to parse SSE event data", { raw: sseEvent.data });
        continue;
      }

      this.dispatchEvent(event);
    }
  }

  private dispatchEvent(event: OpencodeEvent): void {
    const sessionId = extractSessionId(event);

    if (sessionId) {
      const handler = this.subscribers.get(sessionId);
      if (handler) handler(event);
    } else {
      // Broadcast events (server.connected, etc.) reach all sessions
      for (const handler of this.subscribers.values()) {
        handler(event);
      }
    }
  }

  private notifyAllSessions(message: string): void {
    for (const handler of this.subscribers.values()) {
      handler({
        type: "session.error",
        properties: {
          sessionID: "",
          error: { name: "unknown", data: { message } },
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Subscriber management
  // -------------------------------------------------------------------------

  private addSubscriber(opcSessionId: string, handler: (event: OpencodeEvent) => void): () => void {
    this.subscribers.set(opcSessionId, handler);

    return () => {
      this.subscribers.delete(opcSessionId);
    };
  }
}
