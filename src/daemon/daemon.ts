import { randomBytes } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startHealthCheck } from "./health-check.js";
import { acquireLock, releaseLock } from "./lock-file.js";
import { registerSignalHandlers } from "./signal-handler.js";
import type { DaemonState } from "./state-file.js";
import { writeState } from "./state-file.js";

export interface DaemonOptions {
  /** Base directory for runtime files. Default: ~/.beamcode/ */
  dataDir?: string;
  /** Port for the control API. Default: 0 (random). */
  port?: number;
}

const DEFAULT_DATA_DIR = join(homedir(), ".beamcode");
const LOCK_FILE = "daemon.lock";
const STATE_FILE = "daemon.json";

export interface Stoppable {
  stopAll(): Promise<void>;
}

export class Daemon {
  private lockPath = "";
  private statePath = "";
  private healthTimer: NodeJS.Timeout | null = null;
  private running = false;
  private supervisor: Stoppable | null = null;

  /** Register a supervisor whose processes should be stopped on shutdown. */
  setSupervisor(supervisor: Stoppable): void {
    this.supervisor = supervisor;
  }

  async start(options?: DaemonOptions): Promise<{ port: number; controlApiToken: string }> {
    const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    const port = options?.port ?? 0;

    await mkdir(dataDir, { recursive: true });

    this.lockPath = join(dataDir, LOCK_FILE);
    this.statePath = join(dataDir, STATE_FILE);

    await acquireLock(this.lockPath);

    try {
      const controlApiToken = randomBytes(32).toString("hex");

      const state: DaemonState = {
        pid: process.pid,
        port,
        heartbeat: Date.now(),
        version: "0.1.0",
        controlApiToken,
      };

      await writeState(this.statePath, state);

      this.healthTimer = startHealthCheck(this.statePath);
      this.running = true;

      registerSignalHandlers(() => this.stop());

      return { port, controlApiToken };
    } catch (err) {
      await releaseLock(this.lockPath);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    if (this.supervisor) {
      await this.supervisor.stopAll();
    }

    await releaseLock(this.lockPath);

    try {
      await unlink(this.statePath);
    } catch {
      // State file may already be gone.
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
