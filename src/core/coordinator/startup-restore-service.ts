/**
 * StartupRestoreService — restores sessions from persistent storage on startup.
 *
 * Extracted from SessionCoordinator to keep the coordinator focused on
 * orchestration. Enforces restore ordering (launcher → registry → bridge — I6)
 * and marks direct-connection sessions as "exited" for reconnection.
 */

import type { Logger } from "../../interfaces/logger.js";
import type { SessionInfo } from "../../types/session-state.js";

export interface RestoreSummary {
  launcher: number;
  registry: number;
  bridge: number;
  directConnectionsMarked: number;
}

export class StartupRestoreService {
  private launcher: { restoreFromStorage(): number };
  private registry: { restoreFromStorage?(): number; listSessions(): SessionInfo[] };
  private bridge: { restoreFromStorage(): number };
  private logger: Logger;

  constructor(deps: {
    launcher: { restoreFromStorage(): number };
    registry: { restoreFromStorage?(): number; listSessions(): SessionInfo[] };
    bridge: { restoreFromStorage(): number };
    logger: Logger;
  }) {
    this.launcher = deps.launcher;
    this.registry = deps.registry;
    this.bridge = deps.bridge;
    this.logger = deps.logger;
  }

  /** Restore sessions from storage. Launcher MUST restore before bridge (I6). */
  restore(): RestoreSummary {
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
    let directConnectionsMarked = 0;
    for (const info of this.registry.listSessions()) {
      if (!info.pid && !info.archived && info.adapterName) {
        info.state = "exited";
        directConnectionsMarked++;
        this.logger.info(
          `Restored direct-connection session ${info.sessionId} (${info.adapterName}) — marked for reconnect`,
        );
      }
    }

    return {
      launcher: launcherCount,
      registry: registryCount,
      bridge: bridgeCount,
      directConnectionsMarked,
    };
  }
}
