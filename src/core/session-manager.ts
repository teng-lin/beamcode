import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
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
import { noopLogger } from "../utils/noop-logger.js";
import { redactSecrets } from "../utils/redact-secrets.js";
import type { RateLimiterFactory } from "./consumer-gatekeeper.js";
import { IdleSessionReaper } from "./idle-session-reaper.js";
import type { CliAdapterName } from "./interfaces/adapter-names.js";
import type { AdapterResolver } from "./interfaces/adapter-resolver.js";
import type { BackendAdapter } from "./interfaces/backend-adapter.js";
import { isInvertedConnectionAdapter } from "./interfaces/inverted-connection-adapter.js";
import type { SessionLauncher } from "./interfaces/session-launcher.js";
import type {
  IdleSessionReaper as IIdleSessionReaper,
  ReconnectController as IReconnectController,
} from "./interfaces/session-manager-coordination.js";
import type { SessionRegistry } from "./interfaces/session-registry.js";
import type { MessageTracer } from "./message-tracer.js";
import { ReconnectController } from "./reconnect-controller.js";
import { SessionBridge } from "./session-bridge.js";
import { SessionTransportHub } from "./session-transport-hub.js";
import { TypedEventEmitter } from "./typed-emitter.js";

/**
 * Facade wiring SessionBridge + ClaudeLauncher together.
 * Replaces the manual wiring in the Vibe Companion's index.ts:34-68.
 *
 * Auto-wires:
 * - backend:session_id → registry.setBackendSessionId
 * - backend:relaunch_needed → launcher.relaunch (with dedup — A5)
 * - backend:connected → registry.markConnected
 * - Reconnection watchdog (I4)
 * - Restore order: launcher before bridge (I6)
 */
export class SessionManager extends TypedEventEmitter<SessionManagerEventMap> {
  readonly bridge: SessionBridge;
  readonly launcher: SessionLauncher;
  readonly registry: SessionRegistry;

  private adapterResolver: AdapterResolver | null;
  private _defaultAdapterName: string;
  private config: ResolvedConfig;
  private logger: Logger;
  private transportHub: SessionTransportHub;
  private reconnectController: IReconnectController;
  private idleSessionReaper: IIdleSessionReaper;
  private relaunchingSet = new Set<string>();
  private relaunchDedupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private eventCleanups: (() => void)[] = [];
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
    registry?: SessionRegistry;
    rateLimiterFactory?: RateLimiterFactory;
    tracer?: MessageTracer;
    defaultAdapterName?: string;
  }) {
    super();

    this.config = resolveConfig(options.config);
    this.logger = options.logger ?? noopLogger;
    this.adapterResolver = options.adapterResolver ?? null;
    this._defaultAdapterName = options.defaultAdapterName ?? "claude";

    this.bridge = new SessionBridge({
      storage: options.storage,
      gitResolver: options.gitResolver,
      authenticator: options.authenticator,
      logger: options.logger,
      config: options.config,
      metrics: options.metrics,
      adapter: options.adapter,
      adapterResolver: options.adapterResolver,
      rateLimiterFactory: options.rateLimiterFactory,
      tracer: options.tracer,
    });

    this.launcher = options.launcher;
    this.registry = options.registry ?? options.launcher;
    this.transportHub = new SessionTransportHub({
      bridge: this.bridge,
      launcher: this.launcher,
      adapter: options.adapter ?? null,
      adapterResolver: options.adapterResolver ?? null,
      logger: this.logger,
      server: options.server ?? null,
      port: this.config.port,
      toAdapterSocket: (socket) => socket as unknown as WebSocket,
    });
    this.reconnectController = new ReconnectController({
      launcher: this.launcher,
      bridge: this.bridge,
      logger: this.logger,
      reconnectGracePeriodMs: this.config.reconnectGracePeriodMs,
    });
    this.idleSessionReaper = new IdleSessionReaper({
      bridge: this.bridge,
      logger: this.logger,
      idleSessionTimeoutMs: this.config.idleSessionTimeoutMs,
    });
  }

  get defaultAdapterName(): string {
    return this.adapterResolver?.defaultName ?? this._defaultAdapterName;
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
    const adapterName = options.adapterName ?? (this.defaultAdapterName as CliAdapterName);
    const cwd = options.cwd ?? process.cwd();

    // Inverted connection (e.g. Claude --sdk-url) or no resolver (legacy mode):
    // launcher spawns process, CLI connects back via WebSocket.
    const adapter = this.adapterResolver?.resolve(adapterName);
    if (!adapter || isInvertedConnectionAdapter(adapter)) {
      const launchResult = this.launcher.launch({ cwd, model: options.model });
      launchResult.adapterName = adapterName;
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

    // Direct connection: connect via adapter
    const sessionId = randomUUID();
    const createdAt = Date.now();

    this.registry.register({
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
      this.registry.markConnected(sessionId);
    } catch (err) {
      this.registry.removeSession(sessionId);
      void this.bridge.closeSession(sessionId);
      throw err;
    }

    return { sessionId, cwd, adapterName, state: "connected", createdAt };
  }

  /** Set the WebSocket server (allows deferred wiring after HTTP server is created). */
  setServer(server: WebSocketServerLike): void {
    this.transportHub.setServer(server);
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
    await this.transportHub.start();
  }

  /**
   * Graceful shutdown:
   * 1. Kill all CLI processes
   * 2. Close all sessions (sockets)
   * 3. Clear timers
   */
  async stop(): Promise<void> {
    // Remove all wired event listeners to prevent leaks on restart
    for (const cleanup of this.eventCleanups) cleanup();
    this.eventCleanups = [];

    this.reconnectController.stop();
    this.idleSessionReaper.stop();

    // Clear dedup timers and state to prevent stale callbacks after shutdown
    for (const timer of this.relaunchDedupTimers.values()) {
      clearTimeout(timer);
    }
    this.relaunchDedupTimers.clear();
    this.relaunchingSet.clear();

    await this.transportHub.stop();

    await this.launcher.killAll();
    await this.bridge.close();
    await this.adapterResolver?.stopAll?.();
    this.started = false;
  }

  /**
   * Fully delete a session: kill CLI process, clean up dedup state,
   * close WS connections + remove persisted JSON, remove from registry.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const info = this.registry.getSession(sessionId);
    if (!info) return false;

    // Kill process if one exists (Claude sessions have PIDs, external sessions don't)
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
    await this.bridge.closeSession(sessionId);

    // Remove from registry's in-memory map and re-persist
    this.registry.removeSession(sessionId);

    return true;
  }

  /** Ring buffer for process output per session. */
  private processLogBuffers = new Map<string, string[]>();
  private static readonly MAX_LOG_LINES = 500;

  /**
   * Register an event listener and record a cleanup function so it can be
   * removed later (e.g. on stop()).  This prevents listener leaks when the
   * manager is restarted.
   */
  // biome-ignore lint/suspicious/noExplicitAny: must accept any TypedEventEmitter variant
  private trackListener<E extends TypedEventEmitter<any>>(
    emitter: E,
    event: string,
    // biome-ignore lint/suspicious/noExplicitAny: generic event handler signature
    handler: (...args: any[]) => void,
  ): void {
    emitter.on(event, handler);
    this.eventCleanups.push(() => emitter.off(event, handler));
  }

  private wireEvents(): void {
    // Keep bridge session state in sync for legacy launcher.launch() callers.
    // SessionManager.createSession already seeds bridge state directly.
    this.trackListener(this.launcher, "process:spawned", ({ sessionId }) => {
      const info = this.registry.getSession(sessionId);
      if (!info) return;
      this.bridge.seedSessionState(sessionId, {
        cwd: info.cwd,
        model: info.model,
      });
      this.bridge.setAdapterName(sessionId, info.adapterName ?? this.defaultAdapterName);
    });

    // When the backend reports its session_id, store it for --resume on relaunch
    this.trackListener(this.bridge, "backend:session_id", ({ sessionId, backendSessionId }) => {
      this.registry.setBackendSessionId(sessionId, backendSessionId);
    });

    // When backend connects, mark it in the registry
    this.trackListener(this.bridge, "backend:connected", ({ sessionId }) => {
      this.registry.markConnected(sessionId);
    });

    // ── Resume failure → broadcast to consumers (Step 3) ──
    this.trackListener(this.launcher, "process:resume_failed", ({ sessionId }) => {
      this.bridge.broadcastResumeFailedToConsumers(sessionId);
    });

    // ── Process output forwarding with redaction (Step 11) ──
    for (const stream of ["process:stdout", "process:stderr"] as const) {
      this.trackListener(this.launcher, stream, ({ sessionId, data }) => {
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
    this.trackListener(this.launcher, "process:exited", ({ sessionId, circuitBreaker }) => {
      if (circuitBreaker) {
        this.bridge.broadcastCircuitBreakerState(sessionId, circuitBreaker);
      }
    });

    // ── Session auto-naming on first turn (Step 4) ──
    this.trackListener(
      this.bridge,
      "session:first_turn_completed",
      ({ sessionId, firstUserMessage }) => {
        const session = this.registry.getSession(sessionId);
        if (session?.name) return; // Already named

        // Derive name: first line, truncated, redacted
        let name = firstUserMessage.split("\n")[0].trim();
        name = redactSecrets(name);
        if (name.length > 50) name = `${name.slice(0, 47)}...`;
        if (!name) return;

        this.bridge.broadcastNameUpdate(sessionId, name);
        this.registry.setSessionName(sessionId, name);
      },
    );

    // Clean up process log buffer when a session is closed
    this.trackListener(this.bridge, "session:closed", ({ sessionId }) => {
      this.processLogBuffers.delete(sessionId);
    });

    // Auto-relaunch when a consumer connects but backend is dead (with dedup — A5)
    this.trackListener(this.bridge, "backend:relaunch_needed", async ({ sessionId }) => {
      if (this.relaunchingSet.has(sessionId)) return;

      const info = this.registry.getSession(sessionId);
      if (!info || info.archived) return;

      // Inverted-connection sessions have a PID (launched process connects back):
      // the spawned CLI connects back to us via WebSocket.
      if (info.pid) {
        if (info.state === "starting") {
          // Process just launched — waiting for CLI to connect back. Don't relaunch.
          return;
        }
        this.relaunchingSet.add(sessionId);
        this.logger.info(`Auto-relaunching backend for session ${sessionId}`);
        try {
          await this.launcher.relaunch(sessionId);
        } finally {
          const timer = setTimeout(() => {
            if (!this.started) return;
            this.relaunchingSet.delete(sessionId);
            this.relaunchDedupTimers.delete(sessionId);
          }, this.config.relaunchDedupMs);
          this.relaunchDedupTimers.set(sessionId, timer);
        }
        return;
      }

      // Direct-connection sessions (no PID) — reconnect via bridge
      if (!this.bridge.isBackendConnected(sessionId)) {
        this.relaunchingSet.add(sessionId);
        this.logger.info(
          `Auto-reconnecting ${info.adapterName ?? "unknown"} backend for session ${sessionId}`,
        );
        try {
          await this.bridge.connectBackend(sessionId, {
            adapterOptions: { cwd: info.cwd },
          });
          this.registry.markConnected(sessionId);
        } catch (err) {
          this.logger.error(`Failed to reconnect backend for session ${sessionId}: ${err}`);
        } finally {
          const timer = setTimeout(() => {
            if (!this.started) return;
            this.relaunchingSet.delete(sessionId);
            this.relaunchDedupTimers.delete(sessionId);
          }, this.config.relaunchDedupMs);
          this.relaunchDedupTimers.set(sessionId, timer);
        }
      }
    });

    // Forward all bridge events to session manager listeners
    for (const event of [
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
      const handler = (payload: any) => {
        this.emit(event, payload);
      };
      this.trackListener(this.bridge, event, handler);
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
      const handler = (payload: any) => {
        this.emit(event, payload);
      };
      this.trackListener(this.launcher, event, handler);
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

    // If registry is separate from launcher, restore it too
    let registryCount = 0;
    if (this.registry !== this.launcher) {
      registryCount = this.registry.restoreFromStorage?.() ?? 0;
    }

    const bridgeCount = this.bridge.restoreFromStorage();

    const totalRestored = launcherCount + registryCount + bridgeCount;
    if (totalRestored > 0) {
      this.logger.info(
        `Restored ${launcherCount} launcher, ${registryCount} registry, and ${bridgeCount} bridge session(s) from storage`,
      );
    }

    // Mark direct-connection sessions (no PID) as "exited" so the reconnect
    // watchdog / relaunch handler will re-establish their backend connection
    // when a consumer connects.
    for (const info of this.registry.listSessions()) {
      if (!info.pid && !info.archived && info.adapterName) {
        info.state = "exited";
        this.logger.info(
          `Restored direct-connection session ${info.sessionId} (${info.adapterName}) — marked for reconnect`,
        );
      }
    }
  }

  /**
   * Backward-compatible shim retained for tests and legacy internal callers.
   * Delegates to ReconnectController after extraction.
   */
  private startReconnectWatchdog(): void {
    this.reconnectController.start();
  }

  /**
   * Backward-compatible shim retained for tests and legacy internal callers.
   * Delegates to IdleSessionReaper after extraction.
   */
  private startIdleReaper(): void {
    this.idleSessionReaper.start();
  }
}
