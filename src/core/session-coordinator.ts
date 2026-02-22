/**
 * SessionCoordinator — top-level facade and entry point.
 *
 * Owns the session registry and wires the transport layer (ConsumerGateway,
 * BackendConnector), policy services (ReconnectPolicy, IdlePolicy), and the
 * DomainEventBus. Each accepted session gets one SessionRuntime. Consumers
 * and backends connect here; all session lifecycle events flow through this
 * class and are published to the bus for other subsystems to observe.
 */

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
import type { SessionCoordinatorEventMap } from "../types/events.js";
import { noopLogger } from "../utils/noop-logger.js";
import { redactSecrets } from "../utils/redact-secrets.js";
import type { RateLimiterFactory } from "./consumer-gatekeeper.js";
import { BackendRecoveryService } from "./coordinator/backend-recovery-service.js";
import { ProcessLogService } from "./coordinator/process-log-service.js";
import { StartupRestoreService } from "./coordinator/startup-restore-service.js";
import { DomainEventBus } from "./domain-event-bus.js";
import { IdlePolicy } from "./idle-policy.js";
import type { CliAdapterName } from "./interfaces/adapter-names.js";
import type { AdapterResolver } from "./interfaces/adapter-resolver.js";
import type { BackendAdapter } from "./interfaces/backend-adapter.js";
import type { DomainEventMap } from "./interfaces/domain-events.js";
import { isInvertedConnectionAdapter } from "./interfaces/inverted-connection-adapter.js";
import type {
  IdleSessionReaper as IIdleSessionReaper,
  ReconnectController as IReconnectController,
} from "./interfaces/session-coordinator-coordination.js";
import type { SessionLauncher } from "./interfaces/session-launcher.js";
import type { SessionRegistry } from "./interfaces/session-registry.js";
import type { MessageTracer } from "./message-tracer.js";
import { ReconnectPolicy } from "./reconnect-policy.js";
import { SessionBridge } from "./session-bridge.js";
import { SessionTransportHub } from "./session-transport-hub.js";
import { TypedEventEmitter } from "./typed-emitter.js";

/**
 * Facade wiring SessionBridge + ClaudeLauncher together.
 * Replaces the manual wiring previously in index.ts:34-68.
 *
 * Auto-wires:
 * - backend:session_id → registry.setBackendSessionId
 * - backend:relaunch_needed → launcher.relaunch (with dedup — A5)
 * - backend:connected → registry.markConnected
 * - Reconnection watchdog (I4)
 * - Restore order: launcher before bridge (I6)
 */
export interface SessionCoordinatorOptions {
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
}

export class SessionCoordinator extends TypedEventEmitter<SessionCoordinatorEventMap> {
  readonly bridge: SessionBridge;
  readonly launcher: SessionLauncher;
  readonly registry: SessionRegistry;
  readonly domainEvents: DomainEventBus;

  private adapterResolver: AdapterResolver | null;
  private _defaultAdapterName: string;
  private config: ResolvedConfig;
  private logger: Logger;
  private transportHub: SessionTransportHub;
  private reconnectController: IReconnectController;
  private idleSessionReaper: IIdleSessionReaper;
  private processLogService = new ProcessLogService();
  private startupRestoreService: StartupRestoreService;
  private recoveryService: BackendRecoveryService;
  private eventCleanups: (() => void)[] = [];
  private started = false;

  constructor(options: SessionCoordinatorOptions) {
    super();

    this.config = resolveConfig(options.config);
    this.logger = options.logger ?? noopLogger;
    this.adapterResolver = options.adapterResolver ?? null;
    this._defaultAdapterName = options.defaultAdapterName ?? "claude";
    this.domainEvents = new DomainEventBus();

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
    this.reconnectController = new ReconnectPolicy({
      launcher: this.launcher,
      bridge: this.bridge,
      logger: this.logger,
      reconnectGracePeriodMs: this.config.reconnectGracePeriodMs,
      domainEvents: this.domainEvents,
    });
    this.idleSessionReaper = new IdlePolicy({
      bridge: this.bridge,
      logger: this.logger,
      idleSessionTimeoutMs: this.config.idleSessionTimeoutMs,
      domainEvents: this.domainEvents,
    });
    this.startupRestoreService = new StartupRestoreService({
      launcher: this.launcher,
      registry: this.registry,
      bridge: this.bridge,
      logger: this.logger,
    });
    this.recoveryService = new BackendRecoveryService({
      launcher: this.launcher,
      registry: this.registry,
      bridge: this.bridge,
      logger: this.logger,
      relaunchDedupMs: this.config.relaunchDedupMs,
      initializeTimeoutMs: this.config.initializeTimeoutMs,
      killGracePeriodMs: this.config.killGracePeriodMs,
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
        adapterOptions: {
          cwd,
          initializeTimeoutMs: this.config.initializeTimeoutMs,
          killGracePeriodMs: this.config.killGracePeriodMs,
        },
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
   * Start the session coordinator:
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
    this.recoveryService.stop();

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
    this.recoveryService.clearDedupState(sessionId);

    // Close WS connections and remove per-session JSON from storage
    await this.bridge.closeSession(sessionId);

    // Remove from registry's in-memory map and re-persist
    this.registry.removeSession(sessionId);

    return true;
  }

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

  private trackDomainListener<K extends keyof DomainEventMap & string>(
    event: K,
    handler: (domainEvent: DomainEventMap[K]) => void,
  ): void {
    this.domainEvents.on(event, handler);
    this.eventCleanups.push(() => this.domainEvents.off(event, handler));
  }

  private handleProcessOutput(sessionId: string, stream: "stdout" | "stderr", data: string): void {
    const redacted = this.processLogService.append(sessionId, stream, data);
    this.bridge.broadcastProcessOutput(sessionId, stream, redacted);
  }

  private async handleBackendRelaunchNeeded(sessionId: string): Promise<void> {
    return this.recoveryService.handleRelaunchNeeded(sessionId);
  }

  private wireEvents(): void {
    // Forward all bridge events to session coordinator listeners
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
        // `message:inbound` is an input command, not a domain event.
        if (event !== "message:inbound") {
          this.domainEvents.publishBridge(event, payload);
        }
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
        this.domainEvents.publishLauncher(event, payload);
        this.emit(event, payload);
      };
      this.trackListener(this.launcher, event, handler);
    }

    // Keep bridge session state in sync for legacy launcher.launch() callers.
    // SessionCoordinator.createSession already seeds bridge state directly.
    this.trackDomainListener("process:spawned", ({ payload }) => {
      const { sessionId } = payload;
      const info = this.registry.getSession(sessionId);
      if (!info) return;
      this.bridge.seedSessionState(sessionId, {
        cwd: info.cwd,
        model: info.model,
      });
      this.bridge.setAdapterName(sessionId, info.adapterName ?? this.defaultAdapterName);
    });

    // When the backend reports its session_id, store it for --resume on relaunch.
    this.trackDomainListener("backend:session_id", ({ payload }) => {
      this.registry.setBackendSessionId(payload.sessionId, payload.backendSessionId);
    });

    // When backend connects, mark it in the registry.
    this.trackDomainListener("backend:connected", ({ payload }) => {
      this.registry.markConnected(payload.sessionId);
    });

    // Resume failure -> broadcast to consumers.
    this.trackDomainListener("process:resume_failed", ({ payload }) => {
      this.bridge.broadcastResumeFailedToConsumers(payload.sessionId);
    });

    // Process output forwarding with redaction.
    this.trackDomainListener("process:stdout", ({ payload }) => {
      this.handleProcessOutput(payload.sessionId, "stdout", payload.data);
    });
    this.trackDomainListener("process:stderr", ({ payload }) => {
      this.handleProcessOutput(payload.sessionId, "stderr", payload.data);
    });

    // Circuit breaker state from process:exited.
    this.trackDomainListener("process:exited", ({ payload }) => {
      if (payload.circuitBreaker) {
        this.bridge.broadcastCircuitBreakerState(payload.sessionId, payload.circuitBreaker);
      }
    });

    // Session auto-naming on first turn.
    this.trackDomainListener("session:first_turn_completed", ({ payload }) => {
      const { sessionId, firstUserMessage } = payload;
      const session = this.registry.getSession(sessionId);
      if (session?.name) return;

      let name = firstUserMessage.split("\n")[0].trim();
      name = redactSecrets(name);
      if (name.length > 50) name = `${name.slice(0, 47)}...`;
      if (!name) return;

      this.bridge.broadcastNameUpdate(sessionId, name);
      this.registry.setSessionName(sessionId, name);
    });

    // Clean up process log buffer when a session is closed.
    this.trackDomainListener("session:closed", ({ payload }) => {
      this.processLogService.cleanup(payload.sessionId);
    });

    // Route policy advisory through runtime ownership boundary.
    this.trackDomainListener("capabilities:timeout", ({ payload }) => {
      this.bridge.applyPolicyCommand(payload.sessionId, { type: "capabilities_timeout" });
    });

    // Auto-relaunch when a consumer connects but backend is dead (with dedup).
    this.trackDomainListener("backend:relaunch_needed", ({ payload }) => {
      void this.handleBackendRelaunchNeeded(payload.sessionId);
    });
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
    this.startupRestoreService.restore();
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
