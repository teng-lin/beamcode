import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { Logger } from "../interfaces/logger.js";
import type { LauncherStateStorage, SessionStorage } from "../interfaces/storage.js";
import type { PersistedSession } from "../types/session-state.js";
import { noopLogger } from "../utils/noop-logger.js";
import { CURRENT_SCHEMA_VERSION, migrateSession } from "./state-migrator.js";

const SESSION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Validate sessionId to prevent path traversal. */
function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid session ID format: ${sessionId}`);
  }
}

/** Ensure the resolved path is contained within the base directory. */
function safeJoin(base: string, filename: string): string {
  const resolved = resolve(base, filename);
  const normalizedBase = normalize(base);
  // Append separator to prevent prefix false-positives (e.g. /tmp/sessions vs /tmp/sessions-evil)
  const baseWithSep = normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`;
  if (!resolved.startsWith(baseWithSep) && resolved !== normalizedBase) {
    throw new Error(`Path traversal detected: ${filename}`);
  }
  return resolved;
}

/**
 * File-based session storage. Persists sessions as JSON files in a directory.
 * Implements both SessionStorage and LauncherStateStorage.
 *
 * Uses atomic writes (write-ahead logging) to ensure crash-safety:
 * 1. Write to temporary file
 * 2. Sync to disk (fsync)
 * 3. Atomically rename to final filename
 *
 * This guarantees the file is either fully written or left in its previous state.
 */
export class FileStorage implements SessionStorage, LauncherStateStorage {
  private dir: string;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;
  private logger: Logger;

  constructor(dir: string, debounceMs = 150, logger?: Logger) {
    this.dir = dir;
    this.debounceMs = debounceMs;
    this.logger = logger ?? noopLogger;
    mkdirSync(this.dir, { recursive: true });
    this.recoverFromPartialWrites();
  }

  private filePath(sessionId: string): string {
    validateSessionId(sessionId);
    return safeJoin(this.dir, `${sessionId}.json`);
  }

  /**
   * Recover from incomplete writes by cleaning up orphaned .tmp files.
   * Called on startup to handle crashes during write operations.
   */
  private recoverFromPartialWrites(): void {
    try {
      const files = readdirSync(this.dir);
      for (const file of files) {
        if (file.endsWith(".tmp")) {
          try {
            unlinkSync(safeJoin(this.dir, file));
          } catch {
            // Ignore errors during cleanup
          }
        }
      }
    } catch {
      // Directory might not exist yet
    }
  }

  /**
   * Atomically write data to a file using write-ahead logging (WAL).
   * Ensures crash-safety: file is either fully written or left in its previous state.
   */
  private atomicWrite(filePath: string, data: string): void {
    const tmpPath = `${filePath}.tmp`;

    try {
      // Write to temporary file
      writeFileSync(tmpPath, data, "utf-8");

      // Sync to disk (ensure durability before rename)
      const fd = openSync(tmpPath, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }

      // Atomically rename temp file to final location
      // On POSIX systems, rename is atomic at the filesystem level
      renameSync(tmpPath, filePath);
    } catch (err) {
      // Clean up temp file on error
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }
  }

  save(session: PersistedSession): void {
    const existing = this.debounceTimers.get(session.id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(session.id);
      this.saveSync(session);
    }, this.debounceMs);
    this.debounceTimers.set(session.id, timer);
  }

  saveSync(session: PersistedSession): void {
    try {
      session.schemaVersion = CURRENT_SCHEMA_VERSION;
      this.atomicWrite(this.filePath(session.id), JSON.stringify(session));
    } catch (err) {
      // Log but don't crash — storage failures shouldn't kill sessions
      this.logger.error("Failed to save session", { sessionId: session.id, error: err });
    }
  }

  load(sessionId: string): PersistedSession | null {
    try {
      const raw = readFileSync(this.filePath(sessionId), "utf-8");
      return migrateSession(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  loadAll(): PersistedSession[] {
    const sessions: PersistedSession[] = [];
    try {
      const files = readdirSync(this.dir).filter(
        (f) => f.endsWith(".json") && f !== "launcher.json",
      );
      for (const file of files) {
        // Validate filename is a UUID before loading (defense-in-depth)
        const sessionId = file.replace(".json", "");
        if (!SESSION_ID_PATTERN.test(sessionId)) continue;
        try {
          const raw = readFileSync(safeJoin(this.dir, file), "utf-8");
          const migrated = migrateSession(JSON.parse(raw));
          if (migrated) sessions.push(migrated);
        } catch {
          // Skip corrupt files
        }
      }
    } catch {
      // Dir doesn't exist yet
    }
    return sessions;
  }

  remove(sessionId: string): void {
    const timer = this.debounceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(sessionId);
    }
    try {
      unlinkSync(this.filePath(sessionId));
    } catch {
      // File may not exist
    }
  }

  setArchived(sessionId: string, archived: boolean): boolean {
    const session = this.load(sessionId);
    if (!session) return false;
    session.archived = archived;
    this.saveSync(session);
    return true;
  }

  saveLauncherState(data: unknown): void {
    try {
      const launcherPath = join(this.dir, "launcher.json");
      this.atomicWrite(launcherPath, JSON.stringify(data));
    } catch (err) {
      this.logger.error("Failed to save launcher state", { error: err });
    }
  }

  loadLauncherState<T>(): T | null {
    try {
      const raw = readFileSync(join(this.dir, "launcher.json"), "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  get directory(): string {
    return this.dir;
  }
}
