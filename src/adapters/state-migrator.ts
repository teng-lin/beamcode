import type { PersistedSession } from "../types/session-state.js";

export const CURRENT_SCHEMA_VERSION = 2;

type MigrationFn = (session: Record<string, unknown>) => Record<string, unknown>;

/** Map from source version to the function that migrates to source+1. */
const migrations: Map<number, MigrationFn> = new Map([
  [0, migrateV0ToV1],
  [1, migrateV1ToV2],
]);

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
 * V1→V2: pendingMessages changed from string[] (NDJSON) to UnifiedMessage[].
 * Drop any old string entries — they can't be replayed through the new send() path.
 */
function migrateV1ToV2(session: Record<string, unknown>): Record<string, unknown> {
  const pending = Array.isArray(session.pendingMessages) ? session.pendingMessages : [];
  // Keep only object entries (UnifiedMessage); drop string entries (old NDJSON)
  const migrated = pending.filter(
    (item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item),
  );
  return {
    ...session,
    pendingMessages: migrated,
    schemaVersion: 2,
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
  if (version === CURRENT_SCHEMA_VERSION) return raw as unknown as PersistedSession;

  // Run migration chain
  let current = session;
  while (version < CURRENT_SCHEMA_VERSION) {
    const migrate = migrations.get(version);
    if (!migrate) return null; // Gap in migration chain
    current = migrate(current);
    version++;
  }

  return current as unknown as PersistedSession;
}
