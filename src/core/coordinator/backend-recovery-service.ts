import type { Logger } from "../../interfaces/logger.js";
import type { SessionLauncher } from "../interfaces/session-launcher.js";
import type { SessionRegistry } from "../interfaces/session-registry.js";

/**
 * Subset of SessionBridge methods needed by BackendRecoveryService.
 * Defined locally to keep the dependency surface minimal.
 */
export interface RecoveryBridge {
  isBackendConnected(sessionId: string): boolean;
  connectBackend(
    sessionId: string,
    options?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
  ): Promise<void>;
}

export interface BackendRecoveryServiceOptions {
  launcher: SessionLauncher;
  registry: SessionRegistry;
  bridge: RecoveryBridge;
  logger: Logger;
  relaunchDedupMs: number;
  initializeTimeoutMs: number;
  killGracePeriodMs: number;
}

/**
 * Manages backend recovery (relaunch / reconnect) with deduplication.
 *
 * Extracted from SessionCoordinator to keep the coordinator thin.
 * Owns:
 *  - relaunchingSet (dedup guard)
 *  - relaunchDedupTimers (cooldown timers)
 *  - handleRelaunchNeeded() — the core relaunch/reconnect logic
 *  - clearDedupState() — per-session cleanup (called on deleteSession)
 *  - stop() — bulk timer cleanup (called on coordinator.stop())
 */
export class BackendRecoveryService {
  private relaunchingSet = new Set<string>();
  private relaunchDedupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  private readonly launcher: SessionLauncher;
  private readonly registry: SessionRegistry;
  private readonly bridge: RecoveryBridge;
  private readonly logger: Logger;
  private readonly relaunchDedupMs: number;
  private readonly initializeTimeoutMs: number;
  private readonly killGracePeriodMs: number;

  constructor(options: BackendRecoveryServiceOptions) {
    this.launcher = options.launcher;
    this.registry = options.registry;
    this.bridge = options.bridge;
    this.logger = options.logger;
    this.relaunchDedupMs = options.relaunchDedupMs;
    this.initializeTimeoutMs = options.initializeTimeoutMs;
    this.killGracePeriodMs = options.killGracePeriodMs;
  }

  async handleRelaunchNeeded(sessionId: string): Promise<void> {
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
        this.scheduleDedupClear(sessionId);
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
          adapterOptions: {
            cwd: info.cwd,
            initializeTimeoutMs: this.initializeTimeoutMs,
            killGracePeriodMs: this.killGracePeriodMs,
          },
        });
        this.registry.markConnected(sessionId);
      } catch (err) {
        this.logger.error(`Failed to reconnect backend for session ${sessionId}: ${err}`);
      } finally {
        this.scheduleDedupClear(sessionId);
      }
    }
  }

  clearDedupState(sessionId: string): void {
    const timer = this.relaunchDedupTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.relaunchDedupTimers.delete(sessionId);
    }
    this.relaunchingSet.delete(sessionId);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.relaunchDedupTimers.values()) {
      clearTimeout(timer);
    }
    this.relaunchDedupTimers.clear();
    this.relaunchingSet.clear();
  }

  /** Reset stopped flag (called when coordinator restarts). */
  reset(): void {
    this.stopped = false;
  }

  private scheduleDedupClear(sessionId: string): void {
    const timer = setTimeout(() => {
      if (this.stopped) return;
      this.relaunchingSet.delete(sessionId);
      this.relaunchDedupTimers.delete(sessionId);
    }, this.relaunchDedupMs);
    this.relaunchDedupTimers.set(sessionId, timer);
  }
}
