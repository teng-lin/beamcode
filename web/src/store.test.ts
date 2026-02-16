import { beforeEach, describe, expect, it } from "vitest";
import type {
  ConsumerContentBlock,
  ConsumerMessage,
  ConsumerPermissionRequest,
} from "../../shared/consumer-types";
import { type SdkSessionInfo, useStore } from "./store";

const SESSION_ID = "test-session-1";

function makeUserMessage(content: string): ConsumerMessage {
  return { type: "user_message", content, timestamp: Date.now() };
}

function makeSessionInfo(
  overrides: Partial<SdkSessionInfo> & { sessionId: string },
): SdkSessionInfo {
  return { cwd: "/tmp", state: "connected", createdAt: Date.now(), ...overrides };
}

function makePermission(
  overrides?: Partial<ConsumerPermissionRequest>,
): ConsumerPermissionRequest {
  return {
    request_id: "perm-1",
    tool_use_id: "tu-1",
    tool_name: "Bash",
    description: "Run ls",
    input: { command: "ls" },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("store", () => {
  beforeEach(() => {
    useStore.setState({
      sessionData: {},
      sessions: {},
      currentSessionId: null,
      darkMode: true,
      sidebarOpen: false,
      taskPanelOpen: false,
    });
  });

  describe("UI toggles", () => {
    it("toggles sidebar", () => {
      expect(useStore.getState().sidebarOpen).toBe(false);
      useStore.getState().toggleSidebar();
      expect(useStore.getState().sidebarOpen).toBe(true);
      useStore.getState().toggleSidebar();
      expect(useStore.getState().sidebarOpen).toBe(false);
    });

    it("toggles dark mode", () => {
      expect(useStore.getState().darkMode).toBe(true);
      useStore.getState().toggleDarkMode();
      expect(useStore.getState().darkMode).toBe(false);
    });

    it("toggles task panel", () => {
      expect(useStore.getState().taskPanelOpen).toBe(false);
      useStore.getState().toggleTaskPanel();
      expect(useStore.getState().taskPanelOpen).toBe(true);
    });
  });

  describe("session selection", () => {
    it("sets current session", () => {
      useStore.getState().setCurrentSession(SESSION_ID);
      expect(useStore.getState().currentSessionId).toBe(SESSION_ID);
    });
  });

  describe("session data", () => {
    it("ensureSessionData creates empty data for new session", () => {
      useStore.getState().ensureSessionData(SESSION_ID);
      const data = useStore.getState().sessionData[SESSION_ID];
      expect(data).toBeDefined();
      expect(data.messages).toEqual([]);
      expect(data.streaming).toBeNull();
      expect(data.connectionStatus).toBe("disconnected");
      expect(data.cliConnected).toBe(false);
    });

    it("ensureSessionData is idempotent", () => {
      useStore.getState().ensureSessionData(SESSION_ID);
      useStore.getState().addMessage(SESSION_ID, makeUserMessage("hello"));
      useStore.getState().ensureSessionData(SESSION_ID);
      expect(useStore.getState().sessionData[SESSION_ID].messages).toHaveLength(1);
    });

    it("addMessage appends to session messages", () => {
      const msg = makeUserMessage("hello");
      useStore.getState().addMessage(SESSION_ID, msg);
      useStore.getState().addMessage(SESSION_ID, msg);
      expect(useStore.getState().sessionData[SESSION_ID].messages).toHaveLength(2);
    });

    it("addMessage truncates at 2000 messages", () => {
      const msg = makeUserMessage("x");
      for (let i = 0; i < 2001; i++) {
        useStore.getState().addMessage(SESSION_ID, msg);
      }
      expect(useStore.getState().sessionData[SESSION_ID].messages).toHaveLength(2000);
    });

    it("setMessages replaces messages", () => {
      useStore.getState().addMessage(SESSION_ID, makeUserMessage("old"));
      useStore.getState().setMessages(SESSION_ID, []);
      expect(useStore.getState().sessionData[SESSION_ID].messages).toHaveLength(0);
    });
  });

  describe("streaming", () => {
    it("setStreaming and appendStreaming work together", () => {
      useStore.getState().setStreaming(SESSION_ID, "Hello");
      expect(useStore.getState().sessionData[SESSION_ID].streaming).toBe("Hello");

      useStore.getState().appendStreaming(SESSION_ID, " world");
      expect(useStore.getState().sessionData[SESSION_ID].streaming).toBe("Hello world");
    });

    it("appendStreaming initializes from null", () => {
      useStore.getState().appendStreaming(SESSION_ID, "first");
      expect(useStore.getState().sessionData[SESSION_ID].streaming).toBe("first");
    });

    it("clearStreaming resets all streaming fields", () => {
      useStore.getState().setStreaming(SESSION_ID, "text");
      useStore.getState().setStreamingStarted(SESSION_ID, Date.now());
      useStore.getState().setStreamingOutputTokens(SESSION_ID, 100);
      useStore.getState().setStreamingBlocks(SESSION_ID, [
        { type: "text", text: "block" } as ConsumerContentBlock,
      ]);

      useStore.getState().clearStreaming(SESSION_ID);
      const data = useStore.getState().sessionData[SESSION_ID];
      expect(data.streaming).toBeNull();
      expect(data.streamingStartedAt).toBeNull();
      expect(data.streamingOutputTokens).toBe(0);
      expect(data.streamingBlocks).toEqual([]);
    });
  });

  describe("connection status", () => {
    it("sets connection status", () => {
      useStore.getState().setConnectionStatus(SESSION_ID, "connected");
      expect(useStore.getState().sessionData[SESSION_ID].connectionStatus).toBe("connected");
    });

    it("sets CLI connected", () => {
      useStore.getState().setCliConnected(SESSION_ID, true);
      expect(useStore.getState().sessionData[SESSION_ID].cliConnected).toBe(true);
    });

    it("sets session status", () => {
      useStore.getState().setSessionStatus(SESSION_ID, "running");
      expect(useStore.getState().sessionData[SESSION_ID].sessionStatus).toBe("running");
    });
  });

  describe("permissions", () => {
    it("adds and removes permissions", () => {
      const permission = makePermission();
      useStore.getState().ensureSessionData(SESSION_ID);
      useStore.getState().addPermission(SESSION_ID, permission);
      expect(useStore.getState().sessionData[SESSION_ID].pendingPermissions["perm-1"]).toEqual(
        permission,
      );

      useStore.getState().removePermission(SESSION_ID, "perm-1");
      expect(
        useStore.getState().sessionData[SESSION_ID].pendingPermissions["perm-1"],
      ).toBeUndefined();
    });

    it("removePermission is safe for missing session", () => {
      useStore.getState().removePermission("nonexistent", "perm-1");
    });
  });

  describe("session list", () => {
    it("setSessions replaces all sessions", () => {
      useStore.getState().setSessions({
        s1: makeSessionInfo({ sessionId: "s1" }),
        s2: makeSessionInfo({ sessionId: "s2", cwd: "/home", state: "running" }),
      });
      expect(Object.keys(useStore.getState().sessions)).toHaveLength(2);
    });

    it("updateSession merges partial data", () => {
      useStore.getState().setSessions({
        s1: makeSessionInfo({ sessionId: "s1" }),
      });
      useStore.getState().updateSession("s1", { state: "exited" });
      expect(useStore.getState().sessions.s1.state).toBe("exited");
    });

    it("removeSession cleans up both sessions and sessionData", () => {
      useStore.getState().setSessions({
        s1: makeSessionInfo({ sessionId: "s1" }),
      });
      useStore.getState().ensureSessionData("s1");
      useStore.getState().removeSession("s1");
      expect(useStore.getState().sessions.s1).toBeUndefined();
      expect(useStore.getState().sessionData.s1).toBeUndefined();
    });
  });

  describe("tool progress", () => {
    it("tracks tool progress per tool use ID", () => {
      useStore.getState().setToolProgress(SESSION_ID, "tu-1", "Bash", 5);
      useStore.getState().setToolProgress(SESSION_ID, "tu-2", "Read", 2);
      const progress = useStore.getState().sessionData[SESSION_ID].toolProgress;
      expect(progress["tu-1"]).toEqual({ toolName: "Bash", elapsedSeconds: 5 });
      expect(progress["tu-2"]).toEqual({ toolName: "Read", elapsedSeconds: 2 });
    });
  });
});
