/**
 * OpencodeAdapter -- BackendAdapter for the opencode serve REST + SSE protocol.
 *
 * Manages one shared opencode server process and a single SSE connection,
 * creating multiple sessions against it. Incoming SSE events are demuxed
 * to the correct session by extracting the opencode session ID from each event.
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

  private readonly subscribers = new Map<string, (event: OpencodeEvent) => void>();
  private readonly broadcastSubscribers = new Set<(event: OpencodeEvent) => void>();

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
  }

  // -------------------------------------------------------------------------
  // BackendAdapter -- connect
  // -------------------------------------------------------------------------

  async connect(options: ConnectOptions): Promise<BackendSession> {
    // 1. Launch server if not already running
    if (!this.serverInfo) {
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

      // Start the SSE event loop in the background
      this.startSseLoop();
    }

    // 2. Create a session via the HTTP client
    const session = await this.httpClient!.createSession({
      title: options.sessionId,
    });

    const opcSessionId = session.id;

    // 3. Create and return the OpencodeSession
    return new OpencodeSession({
      sessionId: options.sessionId,
      opcSessionId,
      httpClient: this.httpClient!,
      subscribe: (handler) => this.addSubscriber(opcSessionId, handler),
    });
  }

  // -------------------------------------------------------------------------
  // SSE event loop
  // -------------------------------------------------------------------------

  private startSseLoop(): void {
    this.sseAbortController = new AbortController();
    const signal = this.sseAbortController.signal;

    void this.runSseLoop(signal).catch((err) => {
      if (signal.aborted) return;
      this.logger?.error?.("SSE event loop error", err);
    });
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

      const sessionId = extractSessionId(event);

      if (sessionId) {
        const handler = this.subscribers.get(sessionId);
        if (handler) {
          handler(event);
        }
      } else {
        // Broadcast event (server.connected, server.heartbeat, etc.)
        for (const handler of this.broadcastSubscribers) {
          handler(event);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Subscriber management
  // -------------------------------------------------------------------------

  private addSubscriber(opcSessionId: string, handler: (event: OpencodeEvent) => void): () => void {
    this.subscribers.set(opcSessionId, handler);
    this.broadcastSubscribers.add(handler);

    return () => {
      this.subscribers.delete(opcSessionId);
      this.broadcastSubscribers.delete(handler);
    };
  }
}
