import type { PersistedSession } from "../types/session-state.js";

export const CURRENT_SCHEMA_VERSION = 1;

type MigrationFn = (session: Record<string, unknown>) => Record<string, unknown>;

/** Map from source version to the function that migrates to source+1. */
const migrations: Map<number, MigrationFn> = new Map([[0, migrateV0ToV1]]);

function migrateV0ToV1(session: Record<string, unknown>): Record<string, unknown> {
  return {
    ...session,
    messageHistory: Array.isArray(session.messageHistory) ? session.messageHistory : [],
    pendingMessages: Array.isArray(session.pendingMessages) ? session.pendingMessages : [],
    pendingPermissions: Array.isArray(session.pendingPermissions) ? session.pendingPermissions : [],
    schemaVersion: 1,
  };
}

/**
 * Migrate a persisted session to the current schema version.
 * Returns null if the session cannot be migrated (corrupt, missing fields, or future version).
 */
export function migrateSession(raw: unknown): PersistedSession | null {
  if (raw == null || typeof raw !== "object") return null;

  const session = raw as Record<string, unknown>;

  // Required fields
  if (typeof session.id !== "string") return null;
  if (session.state == null || typeof session.state !== "object") return null;

  let version = typeof session.schemaVersion === "number" ? session.schemaVersion : 0;

  // Cannot downgrade from future versions
  if (version > CURRENT_SCHEMA_VERSION) return null;

  // Already current
  if (version === CURRENT_SCHEMA_VERSION) return raw as PersistedSession;

  // Run migration chain
  let current = session;
  while (version < CURRENT_SCHEMA_VERSION) {
    const migrate = migrations.get(version);
    if (!migrate) return null; // Gap in migration chain
    current = migrate(current);
    version++;
  }

  return current as PersistedSession;
}
