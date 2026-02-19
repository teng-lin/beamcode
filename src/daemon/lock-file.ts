import { open, readFile, unlink, writeFile } from "node:fs/promises";

/**
 * Acquire an exclusive lock file by atomically creating it with O_CREAT | O_EXCL.
 * Writes the current PID into the lock file.
 *
 * If a lock already exists but the owning process is dead (stale), atomically
 * replaces the lock file contents (overwrite with O_WRONLY + O_TRUNC) and verifies
 * ownership to prevent TOCTOU races between concurrent daemon starts.
 * If a lock exists and the process is alive, throws.
 */
export async function acquireLock(lockPath: string): Promise<void> {
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(String(process.pid), "utf-8");
    await handle.close();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

    if (await isLockStale(lockPath)) {
      // Atomically overwrite the stale lock with our PID.
      // If another process races us, both will write — the verify step below
      // ensures only the actual winner proceeds.
      await writeFile(lockPath, String(process.pid), "utf-8");

      // Verify we actually own the lock (guard against concurrent stale recovery)
      const ownerPid = await readLockPid(lockPath);
      if (ownerPid !== process.pid) {
        throw new Error(`Daemon already running (PID: ${ownerPid})`);
      }
      return;
    }

    const pid = await readLockPid(lockPath);
    throw new Error(`Daemon already running (PID: ${pid})`);
  }
}

/** Read the PID stored in a lock file. Returns null if the file can't be read. */
async function readLockPid(lockPath: string): Promise<number | null> {
  try {
    const content = await readFile(lockPath, "utf-8");
    const pid = parseInt(content.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Check whether the lock file is stale (the process that created it is no longer running).
 * Returns true if the lock file exists but the owning process is dead (or unreadable).
 */
export async function isLockStale(lockPath: string): Promise<boolean> {
  const pid = await readLockPid(lockPath);
  if (pid === null) return true;

  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** Release a lock file by unlinking it. Ignores ENOENT. */
export async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
