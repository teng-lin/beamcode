import { NoopLogger } from "../adapters/noop-logger.js";
import { SdkUrlLauncher } from "../adapters/sdk-url/sdk-url-launcher.js";
import type { Authenticator } from "../interfaces/auth.js";
import type { CommandRunner } from "../interfaces/command-runner.js";
import type { GitInfoResolver } from "../interfaces/git-resolver.js";
import type { Logger } from "../interfaces/logger.js";
import type { MetricsCollector } from "../interfaces/metrics.js";
import type { ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";
import type { LauncherStateStorage, SessionStorage } from "../interfaces/storage.js";
import type { WebSocketServerLike } from "../interfaces/ws-server.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
} from "../types/cli-messages.js";
import type { ProviderConfig, ResolvedConfig } from "../types/config.js";
import { resolveConfig } from "../types/config.js";
import type { SessionManagerEventMap } from "../types/events.js";
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
  readonly launcher: SdkUrlLauncher;

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
    processManager: ProcessManager;
    storage?: SessionStorage & LauncherStateStorage;
    logger?: Logger;
    gitResolver?: GitInfoResolver;
    authenticator?: Authenticator;
    beforeSpawn?: (sessionId: string, spawnOptions: SpawnOptions) => void;
    server?: WebSocketServerLike;
    metrics?: MetricsCollector;
    commandRunner?: CommandRunner;
  }) {
    super();

    this.config = resolveConfig(options.config);
    this.logger = options.logger ?? new NoopLogger();
    this.server = options.server ?? null;

    this.bridge = new SessionBridge({
      storage: options.storage,
      gitResolver: options.gitResolver,
      authenticator: options.authenticator,
      logger: options.logger,
      config: options.config,
      metrics: options.metrics,
      commandRunner: options.commandRunner,
    });

    this.launcher = new SdkUrlLauncher({
      processManager: options.processManager,
      config: options.config,
      storage: options.storage,
      logger: options.logger,
      beforeSpawn: options.beforeSpawn,
    });
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
          this.bridge.handleCLIOpen(socket, sessionId);
          socket.on("message", (data) => {
            this.bridge.handleCLIMessage(
              sessionId,
              typeof data === "string" ? data : data.toString("utf-8"),
            );
          });
          socket.on("close", () => this.bridge.handleCLIClose(sessionId));
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

  private wireEvents(): void {
    // When the backend reports its session_id, store it for --resume on relaunch
    this.bridge.on("backend:session_id", ({ sessionId, backendSessionId }) => {
      this.launcher.setCLISessionId(sessionId, backendSessionId);
    });

    // When backend connects, mark it in the launcher
    this.bridge.on("backend:connected", ({ sessionId }) => {
      this.launcher.markConnected(sessionId);
    });

    // Auto-relaunch when a consumer connects but backend is dead (with dedup — A5)
    this.bridge.on("backend:relaunch_needed", async ({ sessionId }) => {
      if (this.relaunchingSet.has(sessionId)) return;

      const info = this.launcher.getSession(sessionId);
      if (info?.archived) return;
      if (info && info.state !== "starting") {
        this.relaunchingSet.add(sessionId);
        this.logger.info(`Auto-relaunching backend for session ${sessionId}`);
        try {
          await this.launcher.relaunch(sessionId);
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
  ): Promise<{ content: string; source: "emulated" | "pty" } | null> {
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

    this.logger.info(
      `Waiting ${this.config.reconnectGracePeriodMs / 1000}s for ${starting.length} CLI process(es) to reconnect...`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      const stale = this.launcher.getStartingSessions();
      for (const info of stale) {
        if (info.archived) continue;
        this.logger.info(`CLI for session ${info.sessionId} did not reconnect, relaunching...`);
        await this.launcher.relaunch(info.sessionId);
      }
    }, this.config.reconnectGracePeriodMs);
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
