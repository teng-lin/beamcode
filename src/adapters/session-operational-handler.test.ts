import { describe, expect, it } from "vitest";
import { SessionOperationalHandler } from "./session-operational-handler.js";

// Mock bridge for testing
function createMockBridge() {
  return {
    getAllSessions: () => [
      {
        session_id: "session-1",
        model: "claude-opus",
        cwd: "/tmp",
        tools: [],
        permissionMode: "unrestricted",
        claude_code_version: "0.1.1",
        mcp_servers: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0.1,
        num_turns: 5,
        context_used_percent: 45,
        is_compacting: false,
        git_branch: "main",
        is_worktree: false,
        repo_root: "/tmp/repo",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      {
        session_id: "session-2",
        model: "claude-sonnet",
        cwd: "/tmp",
        tools: [],
        permissionMode: "restricted",
        claude_code_version: "0.1.1",
        mcp_servers: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0.05,
        num_turns: 3,
        context_used_percent: 30,
        is_compacting: false,
        git_branch: "main",
        is_worktree: false,
        repo_root: "/tmp/repo",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
    ],
    getSession: (id: string) => {
      const sessions: Record<string, any> = {
        "session-1": {
          id: "session-1",
          state: { session_id: "session-1" },
          cliConnected: true,
          consumerCount: 2,
          messageHistoryLength: 2,
          pendingPermissions: [],
          consumers: [],
        },
        "session-2": {
          id: "session-2",
          state: { session_id: "session-2" },
          cliConnected: false,
          consumerCount: 1,
          messageHistoryLength: 1,
          pendingPermissions: [{ request_id: "p-1" }],
          consumers: [],
          queuedMessages: 3, // For testing
        },
      };
      return sessions[id];
    },
    isCliConnected: (id: string) => {
      return id === "session-1";
    },
    closeSession: (_id: string) => {
      // Successful close
    },
    storage: {
      setArchived: (_id: string, _archived: boolean) => {
        return true;
      },
    },
  };
}

describe("SessionOperationalHandler", () => {
  // -----------------------------------------------------------------------
  // list_sessions
  // -----------------------------------------------------------------------

  describe("list_sessions command", () => {
    it("lists all active sessions", async () => {
      const bridge = createMockBridge();
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "list_sessions",
      })) as any[];

      expect(response).toHaveLength(2);
      expect(response[0].sessionId).toBe("session-1");
      expect(response[0].cliConnected).toBe(true);
      expect(response[0].consumerCount).toBe(2);
      expect(response[1].sessionId).toBe("session-2");
      expect(response[1].cliConnected).toBe(false);
    });

    it("includes uptime for each session", async () => {
      const bridge = createMockBridge();
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "list_sessions",
      })) as any[];

      // uptime is 0 since SessionState doesn't include creation timestamp
      expect(response[0].uptime).toBe(0);
      expect(response[1].uptime).toBe(0);
    });

    it("returns empty array when no sessions exist", async () => {
      const bridge = { getAllSessions: () => [] };
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "list_sessions",
      })) as any[];

      expect(response).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // get_session_stats
  // -----------------------------------------------------------------------

  describe("get_session_stats command", () => {
    it("returns detailed stats for a session", async () => {
      const bridge = createMockBridge();
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "get_session_stats",
        sessionId: "session-1",
      })) as any;

      expect(response.sessionId).toBe("session-1");
      expect(response.consumers).toBe(2);
      expect(response.messageCount).toBe(2);
      expect(response.cliConnected).toBe(true);
    });

    it("throws when session not found", async () => {
      const bridge = {
        getSession: () => null,
      };
      const handler = new SessionOperationalHandler(bridge);

      await expect(
        handler.handle({
          type: "get_session_stats",
          sessionId: "nonexistent",
        }),
      ).rejects.toThrow("Session not found");
    });

    it("includes pending permissions and queued messages", async () => {
      const bridge = createMockBridge();
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "get_session_stats",
        sessionId: "session-2",
      })) as any;

      expect(response.pendingPermissions).toBe(1);
      expect(response.queuedMessages).toBe(0); // No queued messages info in SessionSnapshot
    });
  });

  // -----------------------------------------------------------------------
  // close_session
  // -----------------------------------------------------------------------

  describe("close_session command", () => {
    it("successfully closes a session", async () => {
      const bridge = createMockBridge();
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "close_session",
        sessionId: "session-1",
      })) as any;

      expect(response.success).toBe(true);
      expect(response.sessionId).toBe("session-1");
    });

    it("includes reason in response message", async () => {
      const bridge = createMockBridge();
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "close_session",
        sessionId: "session-1",
        reason: "Maintenance restart",
      })) as any;

      expect(response.success).toBe(true);
      expect(response.message).toContain("Maintenance restart");
    });

    it("handles close errors gracefully", async () => {
      const bridge = {
        closeSession: () => {
          throw new Error("Close failed");
        },
      };
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "close_session",
        sessionId: "session-1",
      })) as any;

      expect(response.success).toBe(false);
      expect(response.message).toContain("Close failed");
    });
  });

  // -----------------------------------------------------------------------
  // archive_session
  // -----------------------------------------------------------------------

  describe("archive_session command", () => {
    it("successfully archives a session", async () => {
      const bridge = createMockBridge();
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "archive_session",
        sessionId: "session-1",
      })) as any;

      expect(response.success).toBe(true);
      expect(response.message).toBe("Session archived");
    });

    it("returns error when session not found", async () => {
      const bridge = {
        getSession: () => null,
      };
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "archive_session",
        sessionId: "nonexistent",
      })) as any;

      expect(response.success).toBe(false);
      expect(response.message).toBe("Session not found");
    });

    it("handles storage errors gracefully", async () => {
      const bridge = {
        getSession: () => ({ id: "session-1" }),
        storage: {
          setArchived: () => {
            throw new Error("Storage error");
          },
        },
      };
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "archive_session",
        sessionId: "session-1",
      })) as any;

      expect(response.success).toBe(false);
      expect(response.message).toContain("Storage error");
    });
  });

  // -----------------------------------------------------------------------
  // unarchive_session
  // -----------------------------------------------------------------------

  describe("unarchive_session command", () => {
    it("successfully unarchives a session", async () => {
      const bridge = createMockBridge();
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "unarchive_session",
        sessionId: "session-1",
      })) as any;

      expect(response.success).toBe(true);
      expect(response.message).toBe("Session unarchived");
    });

    it("returns error when storage does not support archive", async () => {
      const bridge = {
        storage: null,
      };
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "unarchive_session",
        sessionId: "session-1",
      })) as any;

      expect(response.success).toBe(false);
      expect(response.message).toContain("does not support");
    });
  });

  // -----------------------------------------------------------------------
  // get_health
  // -----------------------------------------------------------------------

  describe("get_health command", () => {
    it("returns health status", async () => {
      const bridge = createMockBridge();
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "get_health",
      })) as any;

      expect(response.status).toMatch(/^(ok|degraded|error)$/);
      expect(response.activeSessions).toBe(2);
      expect(response.cliConnected).toBe(1); // Only session-1 has CLI connected
      expect(response.consumerConnections).toBe(3); // 2 + 1
      expect(response.uptime).toBeGreaterThan(0);
      expect(response.timestamp).toBeDefined();
    });

    it("returns ok status when sessions exist", async () => {
      const bridge = createMockBridge();
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "get_health",
      })) as any;

      expect(response.status).toBe("ok");
    });

    it("returns degraded status when no sessions exist", async () => {
      const bridge = {
        getAllSessions: () => [],
      };
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "get_health",
      })) as any;

      expect(response.status).toBe("degraded");
      expect(response.activeSessions).toBe(0);
    });

    it("handles errors and returns error status", async () => {
      const bridge = {
        getAllSessions: () => {
          throw new Error("Bridge error");
        },
      };
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "get_health",
      })) as any;

      expect(response.status).toBe("error");
      expect(response.activeSessions).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Unknown command
  // -----------------------------------------------------------------------

  describe("unknown command", () => {
    it("throws for unknown command type", async () => {
      const bridge = createMockBridge();
      const handler = new SessionOperationalHandler(bridge);

      await expect(
        handler.handle({
          type: "unknown_command" as any,
        }),
      ).rejects.toThrow("Unknown command type");
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases and fallback paths
  // -----------------------------------------------------------------------

  describe("edge cases and fallback paths", () => {
    it("listSessions handles missing getAllSessions method", async () => {
      const bridge = {} as any;
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "list_sessions",
      })) as any[];

      expect(response).toEqual([]);
    });

    it("listSessions handles session with missing fields", async () => {
      const bridge = {
        getAllSessions: () => [
          {
            session_id: "partial-session",
            // state and messageHistory might be missing
          },
        ],
        getSession: () => ({
          consumerCount: 0,
          messageHistoryLength: 0,
          cliConnected: false,
          pendingPermissions: [],
          consumers: [],
          id: "partial-session",
          state: {},
        }),
        isCliConnected: () => false,
      } as any;
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "list_sessions",
      })) as any[];

      expect(response).toHaveLength(1);
      expect(response[0].sessionId).toBe("partial-session");
      expect(response[0].consumerCount).toBe(0);
      expect(response[0].messageCount).toBe(0);
    });

    it("getSessionStats falls back to basic info when getSessionStats unavailable", async () => {
      const bridge = {
        getSession: () => ({
          id: "session-1",
          consumerCount: 2,
          messageHistoryLength: 5,
          cliConnected: true,
          pendingPermissions: ["p1", "p2"],
        }),
        // getSessionStats method not available - should use fallback
      } as any;
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "get_session_stats",
        sessionId: "session-1",
      })) as any;

      expect(response.sessionId).toBe("session-1");
      expect(response.consumers).toBe(2);
      expect(response.messageCount).toBe(5);
      expect(response.cliConnected).toBe(true);
      expect(response.pendingPermissions).toBe(2);
    });

    it("getSessionStats fallback handles null session fields", async () => {
      const bridge = {
        getSession: () => ({
          id: "sparse-session",
          // All fields are undefined/null
        }),
      } as any;
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "get_session_stats",
        sessionId: "sparse-session",
      })) as any;

      expect(response.consumers).toBe(0);
      expect(response.messageCount).toBe(0);
      expect(response.pendingPermissions).toBe(0);
      expect(response.queuedMessages).toBe(0);
    });

    it("closeSession handles missing closeSession method", async () => {
      const bridge = {
        // No closeSession method
      } as any;
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "close_session",
        sessionId: "session-1",
      })) as any;

      expect(response.success).toBe(false);
    });

    it("archiveSession handles missing storage", async () => {
      const bridge = {
        getSession: () => ({ id: "session-1" }),
        // No storage property
      } as any;
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "archive_session",
        sessionId: "session-1",
      })) as any;

      expect(response.success).toBe(true); // Still succeeds without storage
      expect(response.message).toBe("Session archived");
    });

    it("unarchiveSession handles missing storage", async () => {
      const bridge = {} as any;
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "unarchive_session",
        sessionId: "session-1",
      })) as any;

      expect(response.success).toBe(false);
      expect(response.message).toContain("does not support");
    });

    it("getHealth with no sessions returns degraded status", async () => {
      const bridge = {
        getAllSessions: () => [],
        getSession: () => undefined,
        isCliConnected: () => false,
      } as any;
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "get_health",
      })) as any;

      expect(response.status).toBe("degraded");
      expect(response.activeSessions).toBe(0);
      expect(response.cliConnected).toBe(0);
      expect(response.consumerConnections).toBe(0);
    });

    it("getHealth handles missing isCliConnected method", async () => {
      const bridge = {
        getAllSessions: () => [{ session_id: "session-1", state: { consumerCount: 2 } }],
        getSession: () => ({
          consumerCount: 2,
          messageHistoryLength: 0,
          cliConnected: false,
          pendingPermissions: [],
          consumers: [],
        }),
        // No isCliConnected method - will throw
      } as any;
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "get_health",
      })) as any;

      expect(response.status).toBe("error");
    });

    it("archiveSession with error in setArchived returns error", async () => {
      const bridge = {
        getSession: () => ({ id: "session-1" }),
        storage: {
          setArchived: () => {
            throw new Error("Disk full");
          },
        },
      };
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "archive_session",
        sessionId: "session-1",
      })) as any;

      expect(response.success).toBe(false);
      expect(response.message).toBe("Disk full");
    });

    it("unarchiveSession with error returns proper error message", async () => {
      const bridge = {
        storage: {
          setArchived: () => {
            throw new Error("Permission denied");
          },
        },
      };
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "unarchive_session",
        sessionId: "session-1",
      })) as any;

      expect(response.success).toBe(false);
      expect(response.message).toBe("Permission denied");
    });

    it("listSessions with createdAt undefined handles gracefully", async () => {
      const bridge = {
        getAllSessions: () => [
          {
            session_id: "no-timestamp-session",
            state: { consumerCount: 1 },
            messageHistory: [],
            // No createdAt field
          },
        ],
        getSession: () => ({
          consumerCount: 1,
          messageHistoryLength: 0,
          cliConnected: false,
          pendingPermissions: [],
          consumers: [],
          id: "no-timestamp-session",
          state: {},
        }),
        isCliConnected: () => false,
      } as any;
      const handler = new SessionOperationalHandler(bridge);

      const response = (await handler.handle({
        type: "list_sessions",
      })) as any[];

      expect(response[0].uptime).toBe(0); // Defaults to 0
    });
  });
});
