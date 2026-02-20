import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { noopLogger } from "../utils/noop-logger.js";
import type { Logger } from "../interfaces/logger.js";

export interface DaemonState {
  pid: number;
  port: number;
  heartbeat: number;
  version: string;
  controlApiToken: string;
}

/**
 * Atomically write daemon state to disk (temp file + rename).
 */
export async function writeState(statePath: string, state: DaemonState): Promise<void> {
  const tmpPath = `${statePath}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(state), { encoding: "utf-8", mode: 0o600 });
    await rename(tmpPath, statePath);
    // Ensure owner-only permissions survive regardless of umask at creation time.
    await chmod(statePath, 0o600);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw new Error(
      `Failed to write daemon state to ${statePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Read daemon state from disk. Returns null if the file doesn't exist or is corrupt.
 */
export async function readState(
  statePath: string,
  logger: Logger = noopLogger,
): Promise<DaemonState | null> {
  try {
    const raw = await readFile(statePath, "utf-8");
    return JSON.parse(raw) as DaemonState;
  } catch (err: unknown) {
    // File not found is expected (first run / after cleanup)
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    // Log unexpected errors (permission denied, corrupt JSON, etc.)
    // but still return null to avoid crashing the daemon
    logger.error("Failed to read state file", { component: "daemon", statePath, error: err });
    return null;
  }
}

/**
 * Update the heartbeat timestamp in the state file.
 */
export async function updateHeartbeat(statePath: string, logger?: Logger): Promise<void> {
  const state = await readState(statePath, logger);
  if (!state) return;
  state.heartbeat = Date.now();
  await writeState(statePath, state);
}
