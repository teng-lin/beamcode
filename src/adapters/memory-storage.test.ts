import { beforeEach, describe, expect, it } from "vitest";
import type { PersistedSession } from "../types/session-state.js";
import { MemoryStorage } from "./memory-storage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(id: string, overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id,
    state: {
      session_id: id,
      model: "claude-sonnet-4-5-20250929",
      cwd: "/test",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
      git_branch: "",
      is_worktree: false,
      repo_root: "",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    },
    messageHistory: [],
    pendingMessages: [],
    pendingPermissions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryStorage", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  // -----------------------------------------------------------------------
  // save / load round-trip
  // -----------------------------------------------------------------------

  describe("save / load round-trip", () => {
    it("saves and loads a session correctly", () => {
      const session = makeSession("sess-1");
      storage.save(session);

      const loaded = storage.load("sess-1");
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe("sess-1");
      expect(loaded!.state.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("deep-clones on save (mutation safety)", () => {
      const session = makeSession("sess-1", {
        messageHistory: [{ type: "user_message", content: "original", timestamp: 1 }],
      });
      storage.save(session);

      // Mutate the original object after saving
      session.messageHistory.push({ type: "user_message", content: "mutated", timestamp: 2 });

      const loaded = storage.load("sess-1");
      expect(loaded!.messageHistory).toHaveLength(1);
      expect((loaded!.messageHistory[0] as any).content).toBe("original");
    });

    it("deep-clones on load (mutation safety)", () => {
      storage.save(
        makeSession("sess-1", {
          messageHistory: [{ type: "user_message", content: "hello", timestamp: 1 }],
        }),
      );

      const loaded1 = storage.load("sess-1");
      (loaded1!.messageHistory[0] as any).content = "mutated";

      const loaded2 = storage.load("sess-1");
      expect((loaded2!.messageHistory[0] as any).content).toBe("hello");
    });
  });

  // -----------------------------------------------------------------------
  // load — unknown session
  // -----------------------------------------------------------------------

  describe("load", () => {
    it("returns null for unknown sessionId", () => {
      expect(storage.load("nonexistent")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // loadAll
  // -----------------------------------------------------------------------

  describe("loadAll", () => {
    it("returns empty array when no sessions exist", () => {
      expect(storage.loadAll()).toEqual([]);
    });

    it("returns all stored sessions", () => {
      storage.save(makeSession("sess-1"));
      storage.save(makeSession("sess-2"));
      storage.save(makeSession("sess-3"));

      const all = storage.loadAll();
      expect(all).toHaveLength(3);

      const ids = all.map((s) => s.id).sort();
      expect(ids).toEqual(["sess-1", "sess-2", "sess-3"]);
    });
  });

  // -----------------------------------------------------------------------
  // remove
  // -----------------------------------------------------------------------

  describe("remove", () => {
    it("deletes a session", () => {
      storage.save(makeSession("sess-1"));
      expect(storage.load("sess-1")).not.toBeNull();

      storage.remove("sess-1");
      expect(storage.load("sess-1")).toBeNull();
    });

    it("does not throw when removing non-existent session", () => {
      expect(() => storage.remove("nonexistent")).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // setArchived
  // -----------------------------------------------------------------------

  describe("setArchived", () => {
    it("sets archived flag and returns true", () => {
      storage.save(makeSession("sess-1"));
      const result = storage.setArchived("sess-1", true);

      expect(result).toBe(true);
      expect(storage.load("sess-1")!.archived).toBe(true);
    });

    it("unarchives a session", () => {
      storage.save(makeSession("sess-1", { archived: true }));
      const result = storage.setArchived("sess-1", false);

      expect(result).toBe(true);
      expect(storage.load("sess-1")!.archived).toBe(false);
    });

    it("returns false for unknown session", () => {
      expect(storage.setArchived("nonexistent", true)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Launcher state
  // -----------------------------------------------------------------------

  describe("saveLauncherState / loadLauncherState", () => {
    it("round-trips launcher state", () => {
      const state = { sessions: [{ id: "sess-1", pid: 1234 }] };
      storage.saveLauncherState(state);

      const loaded = storage.loadLauncherState<typeof state>();
      expect(loaded).not.toBeNull();
      expect(loaded!.sessions[0].pid).toBe(1234);
    });

    it("returns null when no launcher state has been saved", () => {
      expect(storage.loadLauncherState()).toBeNull();
    });

    it("deep-clones launcher state on save", () => {
      const state = { value: "original" };
      storage.saveLauncherState(state);

      state.value = "mutated";

      const loaded = storage.loadLauncherState<typeof state>();
      expect(loaded!.value).toBe("original");
    });
  });

  // -----------------------------------------------------------------------
  // size getter
  // -----------------------------------------------------------------------

  describe("size", () => {
    it("returns 0 when empty", () => {
      expect(storage.size).toBe(0);
    });

    it("returns the number of stored sessions", () => {
      storage.save(makeSession("sess-1"));
      storage.save(makeSession("sess-2"));

      expect(storage.size).toBe(2);
    });

    it("decrements after remove", () => {
      storage.save(makeSession("sess-1"));
      storage.save(makeSession("sess-2"));
      storage.remove("sess-1");

      expect(storage.size).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // clear
  // -----------------------------------------------------------------------

  describe("clear", () => {
    it("removes all sessions and launcher state", () => {
      storage.save(makeSession("sess-1"));
      storage.save(makeSession("sess-2"));
      storage.saveLauncherState({ key: "value" });

      storage.clear();

      expect(storage.size).toBe(0);
      expect(storage.loadAll()).toEqual([]);
      expect(storage.loadLauncherState()).toBeNull();
    });
  });
});
