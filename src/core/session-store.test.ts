import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionStorage } from "../interfaces/storage.js";
import { createMockSession, noopLogger } from "../testing/cli-message-factories.js";
import type { PersistedSession } from "../types/session-state.js";
import {
  makeDefaultState,
  SessionStore,
  type SessionStoreFactories,
  toPresenceEntry,
} from "./session-store.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockStorage(): SessionStorage {
  return {
    save: vi.fn(),
    saveSync: vi.fn(),
    load: vi.fn(() => null),
    loadAll: vi.fn(() => []),
    remove: vi.fn(),
    setArchived: vi.fn(() => true),
  };
}

function createFactories(): SessionStoreFactories {
  return {
    createCorrelationBuffer: () => ({ queue: vi.fn(), flush: vi.fn() }) as any,
    createRegistry: () =>
      ({
        registerFromCLI: vi.fn(),
        registerSkills: vi.fn(),
        getAll: vi.fn(() => []),
      }) as any,
  };
}

function createStore(storage?: SessionStorage | null) {
  return new SessionStore(storage ?? createMockStorage(), createFactories());
}

// ─── Pure functions ─────────────────────────────────────────────────────────

describe("makeDefaultState", () => {
  it("sets session_id to the given id", () => {
    const state = makeDefaultState("my-session");
    expect(state.session_id).toBe("my-session");
  });

  it("initializes cost and counters to zero", () => {
    const state = makeDefaultState("s1");
    expect(state.total_cost_usd).toBe(0);
    expect(state.num_turns).toBe(0);
    expect(state.context_used_percent).toBe(0);
  });

  it("initializes arrays as empty", () => {
    const state = makeDefaultState("s1");
    expect(state.tools).toEqual([]);
    expect(state.mcp_servers).toEqual([]);
    expect(state.agents).toEqual([]);
    expect(state.slash_commands).toEqual([]);
    expect(state.skills).toEqual([]);
  });
});

describe("toPresenceEntry", () => {
  it("extracts only userId, displayName, and role", () => {
    const identity = {
      userId: "u1",
      displayName: "Alice",
      role: "participant" as const,
    };
    expect(toPresenceEntry(identity)).toEqual({
      userId: "u1",
      displayName: "Alice",
      role: "participant",
    });
  });

  it("drops extra fields from the identity", () => {
    const identity = {
      userId: "u1",
      displayName: "Bob",
      role: "observer" as const,
      extraField: "should-not-appear",
    } as any;
    const entry = toPresenceEntry(identity);
    expect(entry).not.toHaveProperty("extraField");
    expect(Object.keys(entry)).toEqual(["userId", "displayName", "role"]);
  });
});

// ─── SessionStore CRUD ──────────────────────────────────────────────────────

describe("SessionStore", () => {
  let store: SessionStore;
  let storage: SessionStorage;

  beforeEach(() => {
    storage = createMockStorage();
    store = new SessionStore(storage, createFactories());
  });

  describe("getOrCreate", () => {
    it("creates a new session with correct defaults", () => {
      const session = store.getOrCreate("s1");
      expect(session.id).toBe("s1");
      expect(session.cliSocket).toBeNull();
      expect(session.state.session_id).toBe("s1");
      expect(session.consumerSockets.size).toBe(0);
      expect(session.messageHistory).toEqual([]);
      expect(session.pendingMessages).toEqual([]);
    });

    it("returns same session on repeated calls (reference equality)", () => {
      const a = store.getOrCreate("s1");
      const b = store.getOrCreate("s1");
      expect(a).toBe(b);
    });
  });

  describe("get", () => {
    it("returns undefined for missing session", () => {
      expect(store.get("nonexistent")).toBeUndefined();
    });

    it("returns existing session", () => {
      store.getOrCreate("s1");
      expect(store.get("s1")).toBeDefined();
    });
  });

  describe("has", () => {
    it("returns false when session does not exist", () => {
      expect(store.has("s1")).toBe(false);
    });

    it("returns true when session exists", () => {
      store.getOrCreate("s1");
      expect(store.has("s1")).toBe(true);
    });
  });

  describe("keys", () => {
    it("returns all session IDs", () => {
      store.getOrCreate("a");
      store.getOrCreate("b");
      store.getOrCreate("c");
      expect(Array.from(store.keys())).toEqual(["a", "b", "c"]);
    });
  });

  describe("remove", () => {
    it("deletes from map and calls storage.remove()", () => {
      store.getOrCreate("s1");
      store.remove("s1");
      expect(store.has("s1")).toBe(false);
      expect(storage.remove).toHaveBeenCalledWith("s1");
    });
  });

  describe("isCliConnected", () => {
    it("returns false when cliSocket is null", () => {
      store.getOrCreate("s1");
      expect(store.isCliConnected("s1")).toBe(false);
    });

    it("returns true when cliSocket is set", () => {
      const session = store.getOrCreate("s1");
      session.cliSocket = { send: vi.fn(), close: vi.fn() };
      expect(store.isCliConnected("s1")).toBe(true);
    });
  });

  describe("getAllStates", () => {
    it("returns array of session states", () => {
      store.getOrCreate("a");
      store.getOrCreate("b");
      const states = store.getAllStates();
      expect(states).toHaveLength(2);
      expect(states[0].session_id).toBe("a");
      expect(states[1].session_id).toBe("b");
    });
  });

  // ─── Snapshots ────────────────────────────────────────────────────────────

  describe("getSnapshot", () => {
    it("returns correct shape", () => {
      const session = store.getOrCreate("s1");
      session.messageHistory.push({ type: "status_change", status: "idle" });
      const snap = store.getSnapshot("s1");
      expect(snap).toMatchObject({
        id: "s1",
        cliConnected: false,
        consumerCount: 0,
        consumers: [],
        pendingPermissions: [],
        messageHistoryLength: 1,
      });
      expect(snap!.state.session_id).toBe("s1");
      expect(typeof snap!.lastActivity).toBe("number");
    });

    it("returns undefined for missing session", () => {
      expect(store.getSnapshot("missing")).toBeUndefined();
    });
  });

  // ─── Persistence ──────────────────────────────────────────────────────────

  describe("persist", () => {
    it("calls storage.save() with serialized pendingPermissions Map", () => {
      const session = store.getOrCreate("s1");
      session.pendingPermissions.set("p1", {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "tu-1",
      } as any);
      store.persist(session);
      expect(storage.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "s1",
          pendingPermissions: [["p1", expect.any(Object)]],
        }),
      );
    });

    it("is a no-op when storage is null", () => {
      const nullStore = new SessionStore(null, createFactories());
      const session = nullStore.getOrCreate("s1");
      // Should not throw
      nullStore.persist(session);
    });
  });

  describe("restoreAll", () => {
    it("creates sessions from persisted data", () => {
      const persisted: PersistedSession = {
        id: "restored-1",
        state: makeDefaultState("restored-1"),
        messageHistory: [{ type: "status_change", status: "idle" }],
        pendingMessages: ["queued"],
        pendingPermissions: [
          [
            "p1",
            {
              subtype: "can_use_tool",
              tool_name: "Bash",
              input: {},
              tool_use_id: "tu-1",
            } as any,
          ],
        ],
      };
      (storage.loadAll as ReturnType<typeof vi.fn>).mockReturnValue([persisted]);
      const count = store.restoreAll();
      expect(count).toBe(1);
      expect(store.has("restored-1")).toBe(true);
      const session = store.get("restored-1")!;
      expect(session.messageHistory).toHaveLength(1);
      expect(session.pendingMessages).toEqual(["queued"]);
      expect(session.pendingPermissions.get("p1")).toBeDefined();
    });

    it("skips sessions that already exist (no overwrite)", () => {
      const existing = store.getOrCreate("s1");
      existing.messageHistory.push({
        type: "status_change",
        status: "running",
      });

      const persisted: PersistedSession = {
        id: "s1",
        state: makeDefaultState("s1"),
        messageHistory: [],
        pendingMessages: [],
        pendingPermissions: [],
      };
      (storage.loadAll as ReturnType<typeof vi.fn>).mockReturnValue([persisted]);
      store.restoreAll();
      // Existing session should not be overwritten
      expect(store.get("s1")!.messageHistory).toHaveLength(1);
    });

    it("populates slash command registry from persisted state", () => {
      const persisted: PersistedSession = {
        id: "s2",
        state: {
          ...makeDefaultState("s2"),
          slash_commands: ["/help", "/clear"],
        },
        messageHistory: [],
        pendingMessages: [],
        pendingPermissions: [],
      };
      (storage.loadAll as ReturnType<typeof vi.fn>).mockReturnValue([persisted]);
      store.restoreAll();
      const session = store.get("s2")!;
      expect(session.registry.registerFromCLI).toHaveBeenCalledWith([
        { name: "/help", description: "" },
        { name: "/clear", description: "" },
      ]);
    });

    it("populates skill registry from persisted state", () => {
      const persisted: PersistedSession = {
        id: "s3",
        state: {
          ...makeDefaultState("s3"),
          skills: ["tdd-guide", "code-review"],
        },
        messageHistory: [],
        pendingMessages: [],
        pendingPermissions: [],
      };
      (storage.loadAll as ReturnType<typeof vi.fn>).mockReturnValue([persisted]);
      store.restoreAll();
      const session = store.get("s3")!;
      expect(session.registry.registerSkills).toHaveBeenCalledWith(["tdd-guide", "code-review"]);
    });

    it("falls back to empty Map when pendingPermissions is missing", () => {
      const persisted = {
        id: "s4",
        state: makeDefaultState("s4"),
        messageHistory: [],
        pendingMessages: [],
        // pendingPermissions deliberately omitted
      } as any;
      (storage.loadAll as ReturnType<typeof vi.fn>).mockReturnValue([persisted]);
      store.restoreAll();
      expect(store.get("s4")!.pendingPermissions.size).toBe(0);
    });
  });
});
