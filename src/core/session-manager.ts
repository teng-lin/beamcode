import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { AdapterResolver } from "../adapters/adapter-resolver.js";
import type { CliAdapterName } from "../adapters/create-adapter.js";
import { LogLevel, StructuredLogger } from "../adapters/structured-logger.js";
import type { Authenticator } from "../interfaces/auth.js";
import type { GitInfoResolver } from "../interfaces/git-resolver.js";
import type { Logger } from "../interfaces/logger.js";
import type { MetricsCollector } from "../interfaces/metrics.js";
import type { SessionStorage } from "../interfaces/storage.js";
import type { WebSocketServerLike } from "../interfaces/ws-server.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
} from "../types/cli-messages.js";
import type { ProviderConfig, ResolvedConfig } from "../types/config.js";
import { resolveConfig } from "../types/config.js";
import type { SessionManagerEventMap } from "../types/events.js";
import { redactSecrets } from "../utils/redact-secrets.js";
import type { BackendAdapter } from "./interfaces/backend-adapter.js";
import { isInvertedConnectionAdapter } from "./interfaces/inverted-connection-adapter.js";
import type { SessionLauncher } from "./interfaces/session-launcher.js";
import { SessionBridge } from "./session-bridge.js";
import { TypedEventEmitter } from "./typed-emitter.js";

/**
 * Facade wiring SessionBridge + SdkUrlLauncher together.
 * Replaces the manual wiring in the Vibe Companion's index.ts:34-68.
 *
 * Auto-wires:
 * - backend:session_id → launcher.setCLISessionId
 * - backend:relaunch_needed → launcher.relaunch (with dedup — A5)
 * - backend:connected → launcher.markConnected
 * - Reconnection watchdog (I4)
 * - Restore order: launcher before bridge (I6)
 */
export class SessionManager extends TypedEventEmitter<SessionManagerEventMap> {
  readonly bridge: SessionBridge;
  readonly launcher: SessionLauncher;

  private adapter: BackendAdapter | null;
  private adapterResolver: AdapterResolver | null;
  private config: ResolvedConfig;
  private logger: Logger;
  private server: WebSocketServerLike | null;
  private relaunchingSet = new Set<string>();
  private relaunchDedupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleReaperTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(options: {
    config: ProviderConfig;
    storage?: SessionStorage;
    logger?: Logger;
    gitResolver?: GitInfoResolver;
    authenticator?: Authenticator;
    server?: WebSocketServerLike;
    metrics?: MetricsCollector;
    adapter?: BackendAdapter;
    adapterResolver?: AdapterResolver;
    launcher: SessionLauncher;
  }) {
    super();

    this.config = resolveConfig(options.config);
    this.logger =
      options.logger ??
      new StructuredLogger({ component: "session-manager", level: LogLevel.WARN });
    this.server = options.server ?? null;
    this.adapter = options.adapter ?? null;
    this.adapterResolver = options.adapterResolver ?? null;

    this.bridge = new SessionBridge({
      storage: options.storage,
      gitResolver: options.gitResolver,
      authenticator: options.authenticator,
      logger: options.logger,
      config: options.config,
      metrics: options.metrics,
      adapter: options.adapter,
      adapterResolver: options.adapterResolver,
    });

    this.launcher = options.launcher;
  }

  get defaultAdapterName(): CliAdapterName {
    return this.adapterResolver?.defaultName ?? "sdk-url";
  }

  /** Create a new session, routing to the correct adapter. */
  async createSession(options: {
    cwd?: string;
    model?: string;
    adapterName?: CliAdapterName;
  }): Promise<{
    sessionId: string;
    cwd: string;
    adapterName: CliAdapterName;
    state: string;
    createdAt: number;
  }> {
    const adapterName = options.adapterName ?? this.defaultAdapterName;
    const cwd = options.cwd ?? process.cwd();

    if (adapterName === "sdk-url") {
      const launchResult = this.launcher.launch({ cwd, model: options.model });
      this.bridge.seedSessionState(launchResult.sessionId, {
        cwd: launchResult.cwd,
        model: options.model,
      });
      this.bridge.setAdapterName(launchResult.sessionId, adapterName);
      return {
        sessionId: launchResult.sessionId,
        cwd: launchResult.cwd,
        adapterName,
        state: launchResult.state,
        createdAt: launchResult.createdAt,
      };
    }

    // Direct-connection path (Codex, ACP)
    const sessionId = randomUUID();
    const createdAt = Date.now();

    this.launcher.registerExternalSession({
      sessionId,
      cwd,
      createdAt,
      model: options.model,
      adapterName,
    });

    this.bridge.seedSessionState(sessionId, { cwd, model: options.model });
    this.bridge.setAdapterName(sessionId, adapterName);

    try {
      await this.bridge.connectBackend(sessionId, {
        adapterOptions: { cwd },
      });
      this.launcher.markConnected(sessionId);
    } catch (err) {
      this.launcher.removeSession(sessionId);
      this.bridge.closeSession(sessionId);
      throw err;
    }

    return { sessionId, cwd, adapterName, state: "connected", createdAt };
  }

  /** Set the WebSocket server (allows deferred wiring after HTTP server is created). */
  setServer(server: WebSocketServerLike): void {
    this.server = server;
  }

  /**
   * Start the session manager:
   * 1. Wire bridge + launcher events
   * 2. Restore from storage (launcher first, then bridge — I6)
   * 3. Start reconnection watchdog (I4)
   * 4. Start WebSocket server if provided
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.wireEvents();
    this.restoreFromStorage();
    this.startReconnectWatchdog();
    this.startIdleReaper();

    if (this.server) {
      await this.server.listen(
        (socket, sessionId) => {
          // Use the resolver's eagerly-created SdkUrlAdapter for inverted connections.
          // This ensures SdkUrl sessions work even when the default adapter is non-inverted (e.g., Codex).
          const invertedAdapter =
            this.adapterResolver?.sdkUrlAdapter ??
            (this.adapter && isInvertedConnectionAdapter(this.adapter) ? this.adapter : null);
          if (invertedAdapter && isInvertedConnectionAdapter(invertedAdapter)) {
            const adapter = invertedAdapter;
            // Buffer messages that arrive before the adapter socket is wired.
            // connectBackend() is async — without buffering, messages the CLI
            // sends immediately on connect (system.init, hooks) would be lost.
            const buffered: unknown[] = [];
            let buffering = true;
            let replayed = false;
            socket.on("message", (data: unknown) => {
              if (buffering) buffered.push(data);
            });

            const socketForAdapter = {
              send: (data: string) => socket.send(data),
              close: (code?: number, reason?: string) => socket.close(code, reason),
              get bufferedAmount() {
                return socket.bufferedAmount;
              },
              on: ((event: string, handler: (...args: unknown[]) => void) => {
                if (event === "message") {
                  socket.on("message", handler as (data: string | Buffer) => void);
                } else if (event === "close") {
                  socket.on("close", handler as () => void);
                } else if (event === "error") {
                  socket.on("error", handler as (err: Error) => void);
                } else {
                  return;
                }
                if (event === "message" && !replayed) {
                  replayed = true;
                  for (const msg of buffered) {
                    handler(msg);
                  }
                  buffered.length = 0;
                  buffering = false;
                }
              }) as typeof socket.on,
            };

            // Tag the session as sdk-url since it arrived via the inverted connection path.
            // This ensures resolveAdapter() finds the correct adapter via the resolver.
            this.bridge.setAdapterName(sessionId, "sdk-url");
            this.bridge
              .connectBackend(sessionId)
              .then(() => {
                const ok = adapter.deliverSocket(
                  sessionId,
                  socketForAdapter as unknown as WebSocket,
                );
                if (!ok) {
                  adapter.cancelPending(sessionId);
                  this.logger.warn(`Failed to deliver socket for session ${sessionId}, closing`);
                  socket.close();
                }
              })
              .catch((err) => {
                adapter.cancelPending(sessionId);
                this.logger.warn(`Failed to connect backend for session ${sessionId}: ${err}`);
                socket.close();
              });
          } else {
            this.logger.warn(
              `No adapter configured, cannot handle CLI connection for session ${sessionId}`,
            );
            socket.close();
          }
        },
        (socket, context) => {
          this.bridge.handleConsumerOpen(socket, context);
          socket.on("message", (data) => {
            this.bridge.handleConsumerMessage(
              socket,
              context.sessionId,
              typeof data === "string" ? data : data.toString("utf-8"),
            );
          });
          socket.on("close", () => this.bridge.handleConsumerClose(socket, context.sessionId));
        },
      );
      this.logger.info(`WebSocket server listening on port ${this.config.port}`);
    }
  }

  /**
   * Graceful shutdown:
   * 1. Kill all CLI processes
   * 2. Close all sessions (sockets)
   * 3. Clear timers
   */
  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.idleReaperTimer) {
      clearTimeout(this.idleReaperTimer);
      this.idleReaperTimer = null;
    }

    // Clear dedup timers and state to prevent stale callbacks after shutdown
    for (const timer of this.relaunchDedupTimers.values()) {
      clearTimeout(timer);
    }
    this.relaunchDedupTimers.clear();
    this.relaunchingSet.clear();

    if (this.server) {
      await this.server.close();
    }

    await this.launcher.killAll();
    this.bridge.close();
    this.started = false;
  }

  /**
   * Fully delete a session: kill CLI process, clean up dedup state,
   * close WS connections + remove persisted JSON, remove from launcher map.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const info = this.launcher.getSession(sessionId);
    if (!info) return false;

    // Kill process if one exists (SdkUrl sessions have PIDs, external sessions don't)
    if (info.pid) {
      await this.launcher.kill(sessionId);
    }

    // Clear relaunch dedup state
    const dedupTimer = this.relaunchDedupTimers.get(sessionId);
    if (dedupTimer) {
      clearTimeout(dedupTimer);
      this.relaunchDedupTimers.delete(sessionId);
    }
    this.relaunchingSet.delete(sessionId);

    // Close WS connections and remove per-session JSON from storage
    this.bridge.closeSession(sessionId);

    // Remove from launcher's in-memory map and re-persist launcher.json
    this.launcher.removeSession(sessionId);

    return true;
  }

  /** Ring buffer for process output per session. */
  private processLogBuffers = new Map<string, string[]>();
  private static readonly MAX_LOG_LINES = 500;

  private wireEvents(): void {
    // When the backend reports its session_id, store it for --resume on relaunch
    this.bridge.on("backend:session_id", ({ sessionId, backendSessionId }) => {
      this.launcher.setBackendSessionId(sessionId, backendSessionId);
    });

    // When backend connects, mark it in the launcher
    this.bridge.on("backend:connected", ({ sessionId }) => {
      this.launcher.markConnected(sessionId);
    });

    // ── Resume failure → broadcast to consumers (Step 3) ──
    this.launcher.on("process:resume_failed", ({ sessionId }) => {
      this.bridge.broadcastResumeFailedToConsumers(sessionId);
    });

    // ── Process output forwarding with redaction (Step 11) ──
    for (const stream of ["process:stdout", "process:stderr"] as const) {
      this.launcher.on(stream, ({ sessionId, data }) => {
        const redacted = redactSecrets(data);
        // Ring buffer
        const buffer = this.processLogBuffers.get(sessionId) ?? [];
        const lines = redacted.split("\n").filter((l) => l.trim());
        buffer.push(...lines);
        if (buffer.length > SessionManager.MAX_LOG_LINES) {
          buffer.splice(0, buffer.length - SessionManager.MAX_LOG_LINES);
        }
        this.processLogBuffers.set(sessionId, buffer);
        // Forward to consumers (participant-only is enforced in bridge)
        this.bridge.broadcastProcessOutput(
          sessionId,
          stream === "process:stdout" ? "stdout" : "stderr",
          redacted,
        );
      });
    }

    // ── Circuit breaker state from process:exited (Step 9) ──
    this.launcher.on("process:exited", ({ sessionId, circuitBreaker }) => {
      if (circuitBreaker) {
        this.bridge.broadcastCircuitBreakerState(sessionId, circuitBreaker);
      }
    });

    // ── Session auto-naming on first turn (Step 4) ──
    this.bridge.on("session:first_turn_completed", ({ sessionId, firstUserMessage }) => {
      const session = this.launcher.getSession(sessionId);
      if (session?.name) return; // Already named

      // Derive name: first line, truncated, redacted
      let name = firstUserMessage.split("\n")[0].trim();
      name = redactSecrets(name);
      if (name.length > 50) name = `${name.slice(0, 47)}...`;
      if (!name) return;

      this.bridge.broadcastNameUpdate(sessionId, name);
      this.launcher.setSessionName(sessionId, name);
    });

    // Clean up process log buffer when a session is closed
    this.bridge.on("session:closed", ({ sessionId }) => {
      this.processLogBuffers.delete(sessionId);
    });

    // Auto-relaunch when a consumer connects but backend is dead (with dedup — A5)
    this.bridge.on("backend:relaunch_needed", async ({ sessionId }) => {
      if (this.relaunchingSet.has(sessionId)) return;

      const info = this.launcher.getSession(sessionId);
      if (!info || info.archived) return;

      // SdkUrl sessions with a PID use the inverted connection model:
      // the spawned CLI connects back to us via WebSocket.
      if (info.pid) {
        if (info.state === "starting") {
          // Process just launched — waiting for CLI to connect back. Don't relaunch.
          return;
        }
        this.relaunchingSet.add(sessionId);
        this.logger.info(`Auto-relaunching SdkUrl backend for session ${sessionId}`);
        try {
          await this.launcher.relaunch(sessionId);
        } finally {
          const timer = setTimeout(() => {
            this.relaunchingSet.delete(sessionId);
            this.relaunchDedupTimers.delete(sessionId);
          }, this.config.relaunchDedupMs);
          this.relaunchDedupTimers.set(sessionId, timer);
        }
        return;
      }

      // Non-SdkUrl sessions (no PID) — reconnect via bridge
      if (!this.bridge.isBackendConnected(sessionId)) {
        this.relaunchingSet.add(sessionId);
        this.logger.info(
          `Auto-reconnecting ${info.adapterName ?? "unknown"} backend for session ${sessionId}`,
        );
        try {
          await this.bridge.connectBackend(sessionId, {
            adapterOptions: { cwd: info.cwd },
          });
          this.launcher.markConnected(sessionId);
        } catch (err) {
          this.logger.error(`Failed to reconnect backend for session ${sessionId}: ${err}`);
        } finally {
          const timer = setTimeout(() => {
            this.relaunchingSet.delete(sessionId);
            this.relaunchDedupTimers.delete(sessionId);
          }, this.config.relaunchDedupMs);
          this.relaunchDedupTimers.set(sessionId, timer);
        }
      }
    });

    // Forward all bridge events (both legacy cli:* and new backend:* for transition)
    for (const event of [
      "cli:session_id",
      "cli:connected",
      "cli:disconnected",
      "cli:relaunch_needed",
      "backend:connected",
      "backend:disconnected",
      "backend:session_id",
      "backend:relaunch_needed",
      "backend:message",
      "consumer:connected",
      "consumer:disconnected",
      "consumer:authenticated",
      "consumer:auth_failed",
      "message:outbound",
      "message:inbound",
      "permission:requested",
      "permission:resolved",
      "session:first_turn_completed",
      "session:closed",
      "slash_command:executed",
      "slash_command:failed",
      "capabilities:ready",
      "capabilities:timeout",
      "auth_status",
      "error",
    ] as const) {
      // biome-ignore lint/suspicious/noExplicitAny: event forwarding — TypeScript cannot narrow dynamic event names
      this.bridge.on(event, (payload: any) => {
        this.emit(event, payload);
      });
    }

    // Forward all launcher events
    for (const event of [
      "process:spawned",
      "process:exited",
      "process:connected",
      "process:resume_failed",
      "process:stdout",
      "process:stderr",
      "error",
    ] as const) {
      // biome-ignore lint/suspicious/noExplicitAny: event forwarding — TypeScript cannot narrow dynamic event names
      this.launcher.on(event, (payload: any) => {
        this.emit(event, payload);
      });
    }
  }

  /** Execute a slash command programmatically. */
  async executeSlashCommand(
    sessionId: string,
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null> {
    return this.bridge.executeSlashCommand(sessionId, command);
  }

  /** Get models reported by the CLI's initialize response. */
  getSupportedModels(sessionId: string): InitializeModel[] {
    return this.bridge.getSupportedModels(sessionId);
  }

  /** Get commands reported by the CLI's initialize response. */
  getSupportedCommands(sessionId: string): InitializeCommand[] {
    return this.bridge.getSupportedCommands(sessionId);
  }

  /** Get account info reported by the CLI's initialize response. */
  getAccountInfo(sessionId: string): InitializeAccount | null {
    return this.bridge.getAccountInfo(sessionId);
  }

  private restoreFromStorage(): void {
    // Launcher must restore BEFORE bridge (I6)
    const launcherCount = this.launcher.restoreFromStorage();
    const bridgeCount = this.bridge.restoreFromStorage();

    if (launcherCount > 0 || bridgeCount > 0) {
      this.logger.info(
        `Restored ${launcherCount} launcher session(s) and ${bridgeCount} bridge session(s) from storage`,
      );
    }

    // Mark non-SdkUrl sessions as "exited" so the reconnect watchdog / relaunch
    // handler will re-establish their backend connection when a consumer connects.
    for (const info of this.launcher.listSessions()) {
      if (!info.pid && !info.archived && info.adapterName && info.adapterName !== "sdk-url") {
        info.state = "exited";
        this.logger.info(
          `Restored non-SdkUrl session ${info.sessionId} (${info.adapterName}) — marked for reconnect`,
        );
      }
    }
  }

  /**
   * Reconnection watchdog (I4):
   * After restore, check if any CLI processes are in "starting" state
   * (alive but no WebSocket connection). Give them a grace period,
   * then kill + relaunch any that are still not connected.
   */
  private startReconnectWatchdog(): void {
    const starting = this.launcher.getStartingSessions();
    if (starting.length === 0) return;

    const gracePeriodMs = this.config.reconnectGracePeriodMs;
    this.logger.info(
      `Waiting ${gracePeriodMs / 1000}s for ${starting.length} CLI process(es) to reconnect...`,
    );

    // Broadcast watchdog:active to all sessions
    for (const info of starting) {
      this.bridge.broadcastWatchdogState(info.sessionId, { gracePeriodMs, startedAt: Date.now() });
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      const stale = this.launcher.getStartingSessions();
      for (const info of stale) {
        // Clear watchdog state
        this.bridge.broadcastWatchdogState(info.sessionId, null);
        if (info.archived) continue;
        this.logger.info(`CLI for session ${info.sessionId} did not reconnect, relaunching...`);
        await this.launcher.relaunch(info.sessionId);
      }
    }, gracePeriodMs);
  }

  /** Periodically reap idle sessions (no CLI or consumer connections). */
  private startIdleReaper(): void {
    // Skip if idle timeout is disabled
    if (!this.config.idleSessionTimeoutMs || this.config.idleSessionTimeoutMs <= 0) {
      return;
    }

    const checkInterval = Math.max(1000, this.config.idleSessionTimeoutMs / 10);

    const check = () => {
      const now = Date.now();
      const allSessions = this.bridge.getAllSessions();

      for (const sessionState of allSessions) {
        const sessionId = sessionState.session_id;
        const snapshot = this.bridge.getSession(sessionId);

        if (!snapshot) continue;

        // Skip sessions with active CLI or consumer connections
        if (snapshot.cliConnected || snapshot.consumerCount > 0) {
          continue;
        }

        // Check if session is idle (no activity for longer than timeout)
        const lastActivity = snapshot.lastActivity ?? 0;
        const idleMs = now - lastActivity;

        if (idleMs >= this.config.idleSessionTimeoutMs) {
          this.logger.info(
            `Closing idle session ${sessionId} (idle for ${(idleMs / 1000).toFixed(1)}s)`,
          );
          this.bridge.closeSession(sessionId);
        }
      }

      // Schedule next check
      this.idleReaperTimer = setTimeout(check, checkInterval);
    };

    this.idleReaperTimer = setTimeout(check, checkInterval);
  }
}
