import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, isLockStale, releaseLock } from "./lock-file.js";

describe("lock-file", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "beamcode-lock-test-"));
    lockPath = join(dir, "daemon.lock");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("acquires a lock and writes PID", async () => {
    await acquireLock(lockPath);
    const content = await readFile(lockPath, "utf-8");
    expect(parseInt(content, 10)).toBe(process.pid);
  });

  it("double-acquire throws with PID message", async () => {
    await acquireLock(lockPath);
    await expect(acquireLock(lockPath)).rejects.toThrow(
      `Daemon already running (PID: ${process.pid})`,
    );
  });

  it("detects stale lock from dead PID", async () => {
    // Write a lock file with a PID that almost certainly doesn't exist
    const { writeFile } = await import("node:fs/promises");
    await writeFile(lockPath, "999999999", "utf-8");

    expect(await isLockStale(lockPath)).toBe(true);
  });

  it("detects non-stale lock from alive PID", async () => {
    await acquireLock(lockPath);
    expect(await isLockStale(lockPath)).toBe(false);
  });

  it("re-acquires after stale lock", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(lockPath, "999999999", "utf-8");

    // Should succeed because the stale lock is removed
    await acquireLock(lockPath);
    const content = await readFile(lockPath, "utf-8");
    expect(parseInt(content, 10)).toBe(process.pid);
  });

  it("releases a lock", async () => {
    await acquireLock(lockPath);
    await releaseLock(lockPath);

    // Should be able to acquire again
    await acquireLock(lockPath);
    const content = await readFile(lockPath, "utf-8");
    expect(parseInt(content, 10)).toBe(process.pid);
  });

  it("release is idempotent", async () => {
    await releaseLock(lockPath);
    // No throw
  });

  // -----------------------------------------------------------------------
  // Non-EEXIST error rethrown
  // -----------------------------------------------------------------------

  it("rethrows non-EEXIST errors (e.g. ENOENT)", async () => {
    // Use a path whose parent directory does not exist → triggers ENOENT (not EEXIST)
    const badPath = "/nonexistent-dir-abc123/daemon.lock";
    await expect(acquireLock(badPath)).rejects.toThrow();
    // The error should NOT be about "already running"
    try {
      await acquireLock(badPath);
    } catch (err) {
      expect((err as Error).message).not.toContain("already running");
    }
  });

  // -----------------------------------------------------------------------
  // Second attempt EEXIST after stale removal → "Daemon already running"
  // -----------------------------------------------------------------------

  it("reports 'Daemon already running' when second attempt hits EEXIST", async () => {
    // Create a lock file with a dead PID so isLockStale returns true
    const { writeFile } = await import("node:fs/promises");
    await writeFile(lockPath, "999999999", "utf-8");

    // First acquire should succeed because the stale lock is removed and retried
    await acquireLock(lockPath);
    const content = await readFile(lockPath, "utf-8");
    expect(parseInt(content, 10)).toBe(process.pid);

    // Now the lock is held by us (alive PID). Second acquire should fail
    // with "Daemon already running" because isLockStale returns false
    await expect(acquireLock(lockPath)).rejects.toThrow(
      `Daemon already running (PID: ${process.pid})`,
    );
  });

  // -----------------------------------------------------------------------
  // isLockStale returns true when file doesn't exist
  // -----------------------------------------------------------------------

  it("isLockStale returns true when lock file does not exist", async () => {
    // lockPath doesn't exist yet (no lock acquired)
    const stale = await isLockStale(lockPath);
    expect(stale).toBe(true);
  });

  // -----------------------------------------------------------------------
  // isLockStale with non-numeric content
  // -----------------------------------------------------------------------

  it("isLockStale returns true for non-numeric content", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(lockPath, "not-a-number", "utf-8");

    const stale = await isLockStale(lockPath);
    expect(stale).toBe(true);
  });
});
