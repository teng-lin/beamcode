import { beforeEach, describe, expect, it } from "vitest";
import type { ConsumerContentBlock } from "../../shared/consumer-types";
import { useStore } from "./store";
import { makePermission, makeSessionInfo, makeTeamState } from "./test/factories";

const SESSION_ID = "test-session-1";
const store = () => useStore.getState();

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
      expect(store().sidebarOpen).toBe(false);
      store().toggleSidebar();
      expect(store().sidebarOpen).toBe(true);
      store().toggleSidebar();
      expect(store().sidebarOpen).toBe(false);
    });

    it("toggles dark mode", () => {
      expect(store().darkMode).toBe(true);
      store().toggleDarkMode();
      expect(store().darkMode).toBe(false);
    });

    it("toggles task panel", () => {
      expect(store().taskPanelOpen).toBe(false);
      store().toggleTaskPanel();
      expect(store().taskPanelOpen).toBe(true);
    });
  });

  describe("session selection", () => {
    it("sets current session", () => {
      store().setCurrentSession(SESSION_ID);
      expect(store().currentSessionId).toBe(SESSION_ID);
    });
  });

  describe("session data", () => {
    it("ensureSessionData creates empty data for new session", () => {
      store().ensureSessionData(SESSION_ID);
      const data = store().sessionData[SESSION_ID];
      expect(data).toBeDefined();
      expect(data.messages).toEqual([]);
      expect(data.streaming).toBeNull();
      expect(data.connectionStatus).toBe("disconnected");
      expect(data.cliConnected).toBe(false);
    });

    it("ensureSessionData is idempotent", () => {
      store().ensureSessionData(SESSION_ID);
      store().addMessage(SESSION_ID, {
        type: "user_message",
        content: "hello",
        timestamp: Date.now(),
      });
      store().ensureSessionData(SESSION_ID);
      expect(store().sessionData[SESSION_ID].messages).toHaveLength(1);
    });

    it("addMessage appends to session messages", () => {
      const msg = { type: "user_message" as const, content: "hello", timestamp: Date.now() };
      store().addMessage(SESSION_ID, msg);
      store().addMessage(SESSION_ID, msg);
      expect(store().sessionData[SESSION_ID].messages).toHaveLength(2);
    });

    it("addMessage truncates at 2000 messages", () => {
      const msg = { type: "user_message" as const, content: "x", timestamp: Date.now() };
      for (let i = 0; i < 2001; i++) {
        store().addMessage(SESSION_ID, msg);
      }
      expect(store().sessionData[SESSION_ID].messages).toHaveLength(2000);
    });

    it("setMessages replaces messages", () => {
      store().addMessage(SESSION_ID, {
        type: "user_message",
        content: "old",
        timestamp: Date.now(),
      });
      store().setMessages(SESSION_ID, []);
      expect(store().sessionData[SESSION_ID].messages).toHaveLength(0);
    });
  });

  describe("streaming", () => {
    it("setStreaming and appendStreaming work together", () => {
      store().setStreaming(SESSION_ID, "Hello");
      expect(store().sessionData[SESSION_ID].streaming).toBe("Hello");

      store().appendStreaming(SESSION_ID, " world");
      expect(store().sessionData[SESSION_ID].streaming).toBe("Hello world");
    });

    it("appendStreaming initializes from null", () => {
      store().appendStreaming(SESSION_ID, "first");
      expect(store().sessionData[SESSION_ID].streaming).toBe("first");
    });

    it("clearStreaming resets all streaming fields", () => {
      store().setStreaming(SESSION_ID, "text");
      store().setStreamingStarted(SESSION_ID, Date.now());
      store().setStreamingOutputTokens(SESSION_ID, 100);
      store().setStreamingBlocks(SESSION_ID, [
        { type: "text", text: "block" } as ConsumerContentBlock,
      ]);

      store().clearStreaming(SESSION_ID);
      const data = store().sessionData[SESSION_ID];
      expect(data.streaming).toBeNull();
      expect(data.streamingStartedAt).toBeNull();
      expect(data.streamingOutputTokens).toBe(0);
      expect(data.streamingBlocks).toEqual([]);
    });
  });

  describe("connection status", () => {
    it("sets connection status", () => {
      store().setConnectionStatus(SESSION_ID, "connected");
      expect(store().sessionData[SESSION_ID].connectionStatus).toBe("connected");
    });

    it("sets CLI connected", () => {
      store().setCliConnected(SESSION_ID, true);
      expect(store().sessionData[SESSION_ID].cliConnected).toBe(true);
    });

    it("sets session status", () => {
      store().setSessionStatus(SESSION_ID, "running");
      expect(store().sessionData[SESSION_ID].sessionStatus).toBe("running");
    });
  });

  describe("permissions", () => {
    it("adds and removes permissions", () => {
      const permission = makePermission();
      store().ensureSessionData(SESSION_ID);
      store().addPermission(SESSION_ID, permission);
      expect(store().sessionData[SESSION_ID].pendingPermissions["perm-1"]).toEqual(permission);

      store().removePermission(SESSION_ID, "perm-1");
      expect(store().sessionData[SESSION_ID].pendingPermissions["perm-1"]).toBeUndefined();
    });

    it("removePermission is safe for missing session", () => {
      store().removePermission("nonexistent", "perm-1");
    });
  });

  describe("session list", () => {
    it("setSessions replaces all sessions", () => {
      store().setSessions({
        s1: makeSessionInfo({ sessionId: "s1" }),
        s2: makeSessionInfo({ sessionId: "s2", cwd: "/home", state: "running" }),
      });
      expect(Object.keys(store().sessions)).toHaveLength(2);
    });

    it("updateSession merges partial data", () => {
      store().setSessions({
        s1: makeSessionInfo({ sessionId: "s1" }),
      });
      store().updateSession("s1", { state: "exited" });
      expect(store().sessions.s1.state).toBe("exited");
    });

    it("removeSession cleans up both sessions and sessionData", () => {
      store().setSessions({
        s1: makeSessionInfo({ sessionId: "s1" }),
      });
      store().ensureSessionData("s1");
      store().removeSession("s1");
      expect(store().sessions.s1).toBeUndefined();
      expect(store().sessionData.s1).toBeUndefined();
    });
  });

  describe("tool progress", () => {
    it("tracks tool progress per tool use ID", () => {
      store().setToolProgress(SESSION_ID, "tu-1", "Bash", 5);
      store().setToolProgress(SESSION_ID, "tu-2", "Read", 2);
      const progress = store().sessionData[SESSION_ID].toolProgress;
      expect(progress["tu-1"]).toEqual({ toolName: "Bash", elapsedSeconds: 5 });
      expect(progress["tu-2"]).toEqual({ toolName: "Read", elapsedSeconds: 2 });
    });
  });

  describe("team state", () => {
    it("setSessionState stores team data", () => {
      const team = makeTeamState();
      store().setSessionState(SESSION_ID, {
        session_id: SESSION_ID,
        model: "claude-3-opus",
        cwd: "/tmp",
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        team,
      });
      expect(store().sessionData[SESSION_ID].state?.team).toEqual(team);
    });

    it("session_update merges team into existing state", () => {
      store().setSessionState(SESSION_ID, {
        session_id: SESSION_ID,
        model: "claude-3-opus",
        cwd: "/tmp",
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
      });
      expect(store().sessionData[SESSION_ID].state?.team).toBeUndefined();

      const team = makeTeamState();
      const prev = store().sessionData[SESSION_ID].state!;
      store().setSessionState(SESSION_ID, { ...prev, team });
      expect(store().sessionData[SESSION_ID].state?.team).toEqual(team);
    });

    it("session_update can clear team", () => {
      const team = makeTeamState();
      store().setSessionState(SESSION_ID, {
        session_id: SESSION_ID,
        model: "claude-3-opus",
        cwd: "/tmp",
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        team,
      });
      expect(store().sessionData[SESSION_ID].state?.team).toBeDefined();

      const prev = store().sessionData[SESSION_ID].state!;
      store().setSessionState(SESSION_ID, { ...prev, team: undefined });
      expect(store().sessionData[SESSION_ID].state?.team).toBeUndefined();
    });
  });

  describe("localStorage persistence", () => {
    beforeEach(() => {
      localStorage.removeItem("beamcode_dark_mode");
      localStorage.removeItem("beamcode_sidebar_open");
    });

    it("persists darkMode to localStorage on toggle", () => {
      useStore.getState().toggleDarkMode();
      expect(localStorage.getItem("beamcode_dark_mode")).toBe("false");
      useStore.getState().toggleDarkMode();
      expect(localStorage.getItem("beamcode_dark_mode")).toBe("true");
    });

    it("persists sidebarOpen to localStorage on toggle", () => {
      useStore.setState({ sidebarOpen: true });
      useStore.getState().toggleSidebar();
      expect(localStorage.getItem("beamcode_sidebar_open")).toBe("false");
      useStore.getState().toggleSidebar();
      expect(localStorage.getItem("beamcode_sidebar_open")).toBe("true");
    });
  });
});
