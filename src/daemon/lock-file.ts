import { open, readFile, unlink } from "node:fs/promises";

/**
 * Acquire an exclusive lock file by atomically creating it with O_CREAT | O_EXCL.
 * Writes the current PID into the lock file.
 *
 * If a lock already exists but the owning process is dead (stale), removes the
 * stale lock and retries with O_CREAT | O_EXCL. If the retry fails with EEXIST,
 * another process won the race and we report it as already running.
 * If a lock exists and the process is alive, throws.
 */
export async function acquireLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(String(process.pid), "utf-8");
      await handle.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      if (attempt > 0) {
        // Already retried once after stale removal — another process won the race
        const pid = await readLockPid(lockPath);
        throw new Error(`Daemon already running (PID: ${pid})`);
      }

      if (await isLockStale(lockPath)) {
        // Remove the stale lock, then retry with O_CREAT|O_EXCL.
        // If another process races us and creates the lock between our
        // unlink and open("wx"), the retry will fail with EEXIST — correct.
        try {
          await unlink(lockPath);
        } catch (unlinkErr) {
          if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkErr;
          // ENOENT means another process already removed it — retry will race fairly
        }
        continue;
      }

      const pid = await readLockPid(lockPath);
      throw new Error(`Daemon already running (PID: ${pid})`);
    }
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
