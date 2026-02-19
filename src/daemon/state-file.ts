import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";

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
    throw err;
  }
}

/**
 * Read daemon state from disk. Returns null if the file doesn't exist or is corrupt.
 */
export async function readState(statePath: string): Promise<DaemonState | null> {
  try {
    const raw = await readFile(statePath, "utf-8");
    return JSON.parse(raw) as DaemonState;
  } catch {
    return null;
  }
}

/**
 * Update the heartbeat timestamp in the state file.
 */
export async function updateHeartbeat(statePath: string): Promise<void> {
  const state = await readState(statePath);
  if (!state) return;
  state.heartbeat = Date.now();
  await writeState(statePath, state);
}
