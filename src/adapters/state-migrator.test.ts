import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, migrateSession } from "./state-migrator.js";

describe("state-migrator", () => {
  it("returns null for null input", () => {
    expect(migrateSession(null)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(migrateSession("string")).toBeNull();
    expect(migrateSession(42)).toBeNull();
  });

  it("returns null when id is not a string", () => {
    expect(migrateSession({ state: {} })).toBeNull();
    expect(migrateSession({ id: 123, state: {} })).toBeNull();
  });

  it("returns null when state is not an object", () => {
    expect(migrateSession({ id: "test", state: "corrupt" })).toBeNull();
    expect(migrateSession({ id: "test" })).toBeNull();
  });

  it("adds schemaVersion to v0 (unversioned) sessions", () => {
    const v0 = { id: "test-id", state: { session_id: "test-id" }, messageHistory: [] };
    const result = migrateSession(v0);
    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("passes through current-version sessions unchanged", () => {
    const current = {
      id: "test-id",
      state: { session_id: "test-id" },
      messageHistory: [],
      pendingMessages: [],
      pendingPermissions: [],
      schemaVersion: CURRENT_SCHEMA_VERSION,
    };
    const result = migrateSession(current);
    expect(result).toEqual(current);
  });

  it("returns null for future versions it cannot handle", () => {
    const future = {
      id: "test-id",
      state: { session_id: "test-id" },
      messageHistory: [],
      schemaVersion: 999,
    };
    expect(migrateSession(future)).toBeNull();
  });

  it("adds default fields missing in v0 sessions", () => {
    const v0 = { id: "test-id", state: { session_id: "test-id" } };
    const result = migrateSession(v0);
    expect(result!.messageHistory).toEqual([]);
    expect(result!.pendingMessages).toEqual([]);
    expect(result!.pendingPermissions).toEqual([]);
  });
});
