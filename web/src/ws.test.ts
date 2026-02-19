import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "./store";
import { makeAssistantContent, makeTeamState, resetStore } from "./test/factories";
import {
  _resetForTesting,
  connectToSession,
  disconnect,
  disconnectSession,
  flushDeltas,
  send,
} from "./ws";

vi.mock("./utils/audio", () => ({
  playCompletionSound: vi.fn(),
}));

// ── Mock WebSocket ────────────────────────────────────────────────────────────

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  /** Simulate server opening the connection. */
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  /** Simulate server closing the connection. */
  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }

  /** Simulate a message from the server. */
  simulateMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

beforeEach(() => {
  resetStore();
  MockWebSocket.instances = [];
  _resetForTesting();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ws multi-connection manager", () => {
  // ── Multiple concurrent connections ──────────────────────────────────────

  it("creates separate WebSocket instances for different sessions", () => {
    connectToSession("s1");
    connectToSession("s2");

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[0].url).toContain("/ws/consumer/s1");
    expect(MockWebSocket.instances[1].url).toContain("/ws/consumer/s2");
  });

  // ── Idempotent connect ───────────────────────────────────────────────────

  it("does not create a second socket if session is already CONNECTING", () => {
    connectToSession("s1");
    connectToSession("s1");

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("does not create a second socket if session is already OPEN", () => {
    connectToSession("s1");
    MockWebSocket.instances[0].simulateOpen();

    connectToSession("s1");

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  // ── Independent reconnection ─────────────────────────────────────────────

  it("reconnects only the closed session while others stay connected", () => {
    connectToSession("s1");
    connectToSession("s2");
    const [ws1, ws2] = MockWebSocket.instances;
    ws1.simulateOpen();
    ws2.simulateOpen();

    // Close s1 — triggers onclose → scheduleReconnect
    ws1.simulateClose();

    expect(useStore.getState().sessionData.s1?.connectionStatus).toBe("disconnected");
    expect(useStore.getState().sessionData.s2?.connectionStatus).toBe("connected");

    // Advance past reconnect delay (1000ms for first attempt)
    vi.advanceTimersByTime(1500);

    // s1 should have a new WebSocket (3rd instance total)
    expect(MockWebSocket.instances).toHaveLength(3);
    expect(MockWebSocket.instances[2].url).toContain("/ws/consumer/s1");
  });

  it("onclose clears authStatus to avoid stale banner on reconnect", () => {
    connectToSession("s1");
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    // Set authStatus as if mid-authentication
    useStore.getState().setAuthStatus("s1", {
      isAuthenticating: true,
      output: ["Opening browser..."],
    });
    expect(useStore.getState().sessionData.s1?.authStatus).not.toBeNull();

    ws.simulateClose();

    expect(useStore.getState().sessionData.s1?.authStatus).toBeNull();
  });

  // ── disconnectSession ────────────────────────────────────────────────────

  it("disconnectSession closes only the targeted connection", () => {
    connectToSession("s1");
    connectToSession("s2");
    const [ws1, ws2] = MockWebSocket.instances;
    ws1.simulateOpen();
    ws2.simulateOpen();

    disconnectSession("s1");

    expect(ws1.close).toHaveBeenCalled();
    expect(ws2.close).not.toHaveBeenCalled();
    expect(useStore.getState().sessionData.s1?.connectionStatus).toBe("disconnected");
    expect(useStore.getState().sessionData.s2?.connectionStatus).toBe("connected");
  });

  it("disconnectSession clears reconnect timer for that session", () => {
    connectToSession("s1");
    MockWebSocket.instances[0].simulateOpen();
    MockWebSocket.instances[0].simulateClose();

    // Reconnect is now scheduled for s1
    disconnectSession("s1");

    // Advance timers — no new connection should be created
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("disconnectSession is a no-op for unknown session", () => {
    expect(() => disconnectSession("nonexistent")).not.toThrow();
  });

  // ── disconnect (all) ─────────────────────────────────────────────────────

  it("disconnect closes all connections and clears all reconnect timers", () => {
    connectToSession("s1");
    connectToSession("s2");
    const [ws1, ws2] = MockWebSocket.instances;
    ws1.simulateOpen();
    ws2.simulateOpen();

    disconnect();

    expect(ws1.close).toHaveBeenCalled();
    expect(ws2.close).toHaveBeenCalled();
    expect(useStore.getState().sessionData.s1?.connectionStatus).toBe("disconnected");
    expect(useStore.getState().sessionData.s2?.connectionStatus).toBe("disconnected");

    // No reconnect should fire
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  // ── send with explicit sessionId ─────────────────────────────────────────

  it("sends message to the correct WebSocket when sessionId is explicit", () => {
    connectToSession("s1");
    connectToSession("s2");
    const [ws1, ws2] = MockWebSocket.instances;
    ws1.simulateOpen();
    ws2.simulateOpen();

    const msg = { type: "user_message" as const, content: "hello" };
    send(msg, "s2");

    expect(ws1.send).not.toHaveBeenCalled();
    expect(ws2.send).toHaveBeenCalledWith(JSON.stringify(msg));
  });

  // ── send without sessionId ───────────────────────────────────────────────

  it("sends message to currentSessionId when sessionId is omitted", () => {
    connectToSession("s1");
    connectToSession("s2");
    const [ws1, ws2] = MockWebSocket.instances;
    ws1.simulateOpen();
    ws2.simulateOpen();
    useStore.setState({ currentSessionId: "s1" });

    const msg = { type: "user_message" as const, content: "hello" };
    send(msg);

    expect(ws1.send).toHaveBeenCalledWith(JSON.stringify(msg));
    expect(ws2.send).not.toHaveBeenCalled();
  });

  // ── send on disconnected session ─────────────────────────────────────────

  it("send is a silent no-op when the target session has no connection", () => {
    useStore.setState({ currentSessionId: "s1" });
    const msg = { type: "user_message" as const, content: "hello" };

    expect(() => send(msg)).not.toThrow();
  });

  it("send is a silent no-op when there is no currentSessionId and no explicit sessionId", () => {
    useStore.setState({ currentSessionId: null });
    const msg = { type: "user_message" as const, content: "hello" };

    expect(() => send(msg)).not.toThrow();
  });

  // ── Reconnect backoff ───────────────────────────────────────────────────

  it("uses exponential backoff for reconnection attempts", () => {
    connectToSession("s1");
    MockWebSocket.instances[0].simulateOpen();

    // First close → attempt 1, delay = 1000ms (1000 * 2^0)
    MockWebSocket.instances[0].simulateClose();
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1); // total: 1000ms
    expect(MockWebSocket.instances).toHaveLength(2);

    // Reconnect opened but immediately closes again
    // The new socket's readyState is CONNECTING by default.
    // onclose fires → scheduleReconnect with attempt=1 → delay = 2000ms (1000 * 2^1)
    MockWebSocket.instances[1].simulateClose();

    vi.advanceTimersByTime(1999);
    expect(MockWebSocket.instances).toHaveLength(2);

    vi.advanceTimersByTime(1); // total: 2000ms
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  // ── onopen resets reconnect attempt counter ──────────────────────────────

  it("resets reconnect attempt to 0 on successful open", () => {
    connectToSession("s1");
    MockWebSocket.instances[0].simulateOpen();

    expect(useStore.getState().sessionData.s1?.reconnectAttempt).toBe(0);
    expect(useStore.getState().sessionData.s1?.connectionStatus).toBe("connected");
  });
});

// ── handleMessage tests ──────────────────────────────────────────────────────

describe("handleMessage", () => {
  /** Connect + open a session, return the mock socket for sending messages. */
  function openSession(id = "s1"): MockWebSocket {
    connectToSession(id);
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws.simulateOpen();
    return ws;
  }

  function getSessionData(id = "s1") {
    return useStore.getState().sessionData[id];
  }

  // ── Malformed JSON ──────────────────────────────────────────────────────

  it("malformed JSON → silently returns, no crash", () => {
    const ws = openSession();
    expect(() => ws.simulateMessage("not valid json{")).not.toThrow();
    // Store should still have session data, just no messages added
    expect(getSessionData()?.messages ?? []).toHaveLength(0);
  });

  // ── assistant ───────────────────────────────────────────────────────────

  it("assistant: adds message and clears streaming", () => {
    const ws = openSession();
    // Set up streaming state first
    useStore.getState().setStreaming("s1", "partial text");

    ws.simulateMessage(
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: makeAssistantContent([{ type: "text", text: "Hello" }]),
      }),
    );

    expect(getSessionData()?.messages).toHaveLength(1);
    expect(getSessionData()?.messages[0].type).toBe("assistant");
    expect(getSessionData()?.streaming).toBeNull();
  });

  it("assistant with parent_tool_use_id: clears agent streaming", () => {
    const ws = openSession();
    useStore.getState().initAgentStreaming("s1", "agent-1");

    ws.simulateMessage(
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: "agent-1",
        message: makeAssistantContent([{ type: "text", text: "Agent done" }]),
      }),
    );

    expect(getSessionData()?.messages).toHaveLength(1);
    // Agent streaming should be cleared
    expect(getSessionData()?.agentStreaming?.["agent-1"]).toBeUndefined();
  });

  // ── result ──────────────────────────────────────────────────────────────

  it("result: sets idle status and adds message", () => {
    const ws = openSession();
    useStore.getState().setSessionStatus("s1", "running");

    ws.simulateMessage(
      JSON.stringify({
        type: "result",
        data: { is_error: false },
      }),
    );

    expect(getSessionData()?.sessionStatus).toBe("idle");
    expect(getSessionData()?.messages).toHaveLength(1);
  });

  it("result: plays sound when document.hidden and soundEnabled", async () => {
    const { playCompletionSound } = await import("./utils/audio");
    const ws = openSession();
    useStore.setState((s) => ({ ...s, soundEnabled: true }));
    Object.defineProperty(document, "hidden", { value: true, writable: true, configurable: true });

    ws.simulateMessage(
      JSON.stringify({
        type: "result",
        data: { is_error: false },
      }),
    );

    expect(playCompletionSound).toHaveBeenCalled();

    // Restore
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("result: shows Notification when document.hidden and alertsEnabled", () => {
    const ws = openSession();
    useStore.setState((s) => ({ ...s, alertsEnabled: true }));
    Object.defineProperty(document, "hidden", { value: true, writable: true, configurable: true });
    const mockNotification = vi.fn();
    vi.stubGlobal("Notification", Object.assign(mockNotification, { permission: "granted" }));

    ws.simulateMessage(
      JSON.stringify({
        type: "result",
        data: { is_error: false },
      }),
    );

    expect(mockNotification).toHaveBeenCalledWith("Task complete", {
      body: "Completed successfully",
    });

    // Error variant
    ws.simulateMessage(
      JSON.stringify({
        type: "result",
        data: { is_error: true },
      }),
    );

    expect(mockNotification).toHaveBeenCalledWith("Task complete", {
      body: "Completed with errors",
    });

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    vi.unstubAllGlobals();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  it("result: no sound or notification when document is visible", async () => {
    const { playCompletionSound } = await import("./utils/audio");
    (playCompletionSound as ReturnType<typeof vi.fn>).mockClear();
    const ws = openSession();
    useStore.setState((s) => ({ ...s, soundEnabled: true, alertsEnabled: true }));
    Object.defineProperty(document, "hidden", { value: false, configurable: true });

    ws.simulateMessage(JSON.stringify({ type: "result", data: { is_error: false } }));

    expect(playCompletionSound).not.toHaveBeenCalled();
  });

  // ── user_message / error / slash_command_result / slash_command_error ──

  it("user_message: adds message to store", () => {
    const ws = openSession();
    ws.simulateMessage(JSON.stringify({ type: "user_message", content: "hi" }));
    expect(getSessionData()?.messages).toHaveLength(1);
    expect(getSessionData()?.messages[0].type).toBe("user_message");
  });

  it("error: adds message to store", () => {
    const ws = openSession();
    ws.simulateMessage(JSON.stringify({ type: "error", error: "something broke" }));
    expect(getSessionData()?.messages).toHaveLength(1);
  });

  it("slash_command_result: adds message to store", () => {
    const ws = openSession();
    ws.simulateMessage(JSON.stringify({ type: "slash_command_result", output: "done" }));
    expect(getSessionData()?.messages).toHaveLength(1);
  });

  it("slash_command_error: adds message to store", () => {
    const ws = openSession();
    ws.simulateMessage(JSON.stringify({ type: "slash_command_error", error: "bad cmd" }));
    expect(getSessionData()?.messages).toHaveLength(1);
  });

  // ── stream_event → message_start ────────────────────────────────────────

  it("stream_event message_start: sets streaming and status running", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "stream_event",
        event: { type: "message_start" },
        parent_tool_use_id: null,
      }),
    );

    expect(getSessionData()?.streaming).toBe("");
    expect(getSessionData()?.sessionStatus).toBe("running");
  });

  it("stream_event message_start with agent: inits agent streaming", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "stream_event",
        event: { type: "message_start" },
        parent_tool_use_id: "agent-1",
      }),
    );

    expect(getSessionData()?.agentStreaming?.["agent-1"]).toBeDefined();
    expect(getSessionData()?.sessionStatus).toBe("running");
  });

  // ── stream_event → content_block_delta ──────────────────────────────────

  it("stream_event content_block_delta: appends text to main streaming", () => {
    const ws = openSession();
    useStore.getState().setStreaming("s1", "");

    ws.simulateMessage(
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hello " },
        },
        parent_tool_use_id: null,
      }),
    );

    ws.simulateMessage(
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "world" },
        },
        parent_tool_use_id: null,
      }),
    );

    // Deltas are batched via rAF — flush to apply
    flushDeltas();
    expect(getSessionData()?.streaming).toBe("hello world");
  });

  it("stream_event content_block_delta with agent: appends to agent streaming", () => {
    const ws = openSession();
    useStore.getState().initAgentStreaming("s1", "agent-1");

    ws.simulateMessage(
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "agent text" },
        },
        parent_tool_use_id: "agent-1",
      }),
    );

    flushDeltas();
    expect(getSessionData()?.agentStreaming?.["agent-1"]?.text).toBe("agent text");
  });

  // ── stream_event → message_delta ────────────────────────────────────────

  it("stream_event message_delta: sets output tokens", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "stream_event",
        event: { type: "message_delta", usage: { output_tokens: 150 } },
        parent_tool_use_id: null,
      }),
    );

    expect(getSessionData()?.streamingOutputTokens).toBe(150);
  });

  it("stream_event message_delta with agent: sets agent output tokens", () => {
    const ws = openSession();
    useStore.getState().initAgentStreaming("s1", "agent-1");

    ws.simulateMessage(
      JSON.stringify({
        type: "stream_event",
        event: { type: "message_delta", usage: { output_tokens: 75 } },
        parent_tool_use_id: "agent-1",
      }),
    );

    expect(getSessionData()?.agentStreaming?.["agent-1"]?.outputTokens).toBe(75);
  });

  // ── stream_event with unknown inner event ───────────────────────────────

  it("stream_event with unknown inner event type: no crash", () => {
    const ws = openSession();
    expect(() =>
      ws.simulateMessage(
        JSON.stringify({
          type: "stream_event",
          event: { type: "unknown_future_event" },
          parent_tool_use_id: null,
        }),
      ),
    ).not.toThrow();
  });

  // ── message_history ─────────────────────────────────────────────────────

  it("message_history: sets messages and clears streaming", () => {
    const ws = openSession();
    useStore.getState().setStreaming("s1", "partial");

    const messages = [
      { type: "user_message", content: "hi" },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: makeAssistantContent([{ type: "text", text: "hey" }]),
      },
    ];

    ws.simulateMessage(JSON.stringify({ type: "message_history", messages }));

    expect(getSessionData()?.messages).toHaveLength(2);
    expect(getSessionData()?.streaming).toBeNull();
  });

  // ── capabilities_ready ──────────────────────────────────────────────────

  it("capabilities_ready: sets capabilities with commands, models, skills", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "capabilities_ready",
        commands: [{ name: "/help", description: "Show help" }],
        models: ["opus", "sonnet"],
        skills: ["skill-1"],
      }),
    );

    const caps = getSessionData()?.capabilities;
    expect(caps?.commands).toEqual([{ name: "/help", description: "Show help" }]);
    expect(caps?.models).toEqual(["opus", "sonnet"]);
    expect(caps?.skills).toEqual(["skill-1"]);
  });

  // ── session_init ────────────────────────────────────────────────────────

  it("session_init: sets state with safe defaults", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "session_init",
        session: {
          session_id: "s1",
          model: "opus",
          cwd: "/tmp",
          total_cost_usd: 1.5,
          num_turns: 3,
          context_used_percent: 25,
          is_compacting: false,
        },
      }),
    );

    const state = getSessionData()?.state;
    expect(state?.session_id).toBe("s1");
    expect(state?.model).toBe("opus");
    expect(state?.cwd).toBe("/tmp");
  });

  it("session_init: populates capabilities fallback from slash_commands", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "session_init",
        session: {
          session_id: "s1",
          model: "opus",
          cwd: "/tmp",
          slash_commands: ["/help", "/commit"],
          skills: ["my-skill"],
        },
      }),
    );

    const caps = getSessionData()?.capabilities;
    expect(caps?.commands).toEqual([
      { name: "/help", description: "" },
      { name: "/commit", description: "" },
    ]);
    expect(caps?.skills).toEqual(["my-skill"]);
  });

  it("session_init: fills missing fields with defaults", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "session_init",
        session: {},
      }),
    );

    const state = getSessionData()?.state;
    expect(state?.session_id).toBe("s1"); // falls back to sessionId
    expect(state?.model).toBe("");
    expect(state?.total_cost_usd).toBe(0);
    expect(state?.num_turns).toBe(0);
    expect(state?.is_compacting).toBe(false);
  });

  it("session_init: populates sessions store for sidebar display", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "session_init",
        session: {
          session_id: "s1",
          model: "opus",
          cwd: "/home/user/project",
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
        },
      }),
    );

    const entry = useStore.getState().sessions["s1"];
    expect(entry).toBeDefined();
    expect(entry.sessionId).toBe("s1");
    expect(entry.cwd).toBe("/home/user/project");
    expect(typeof entry.createdAt).toBe("number");
    expect(entry.state).toBe("connected");
  });

  it("session_init: does not overwrite existing sessions entry with correct createdAt", () => {
    // Pre-populate sessions (as listSessions() would do)
    useStore.getState().updateSession("s1", {
      sessionId: "s1",
      cwd: "/correct/path",
      createdAt: 12345,
      state: "connected",
    });

    const ws = openSession();
    ws.simulateMessage(
      JSON.stringify({
        type: "session_init",
        session: {
          session_id: "s1",
          model: "opus",
          cwd: "/different/path",
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
        },
      }),
    );

    // Pre-existing authoritative entry should be preserved
    const entry = useStore.getState().sessions["s1"];
    expect(entry.cwd).toBe("/correct/path");
    expect(entry.createdAt).toBe(12345);
  });

  // ── session_update ──────────────────────────────────────────────────────

  it("session_update: merges into existing state", () => {
    const ws = openSession();
    // First init a session
    ws.simulateMessage(
      JSON.stringify({
        type: "session_init",
        session: {
          session_id: "s1",
          model: "opus",
          cwd: "/tmp",
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
        },
      }),
    );

    ws.simulateMessage(
      JSON.stringify({
        type: "session_update",
        session: { total_cost_usd: 2.5, num_turns: 5 },
      }),
    );

    const state = getSessionData()?.state;
    expect(state?.model).toBe("opus"); // preserved
    expect(state?.total_cost_usd).toBe(2.5); // updated
    expect(state?.num_turns).toBe(5); // updated
  });

  it("session_update: auto-opens task panel when team first appears", () => {
    const ws = openSession();
    // Init session without team
    ws.simulateMessage(
      JSON.stringify({
        type: "session_init",
        session: {
          session_id: "s1",
          model: "opus",
          cwd: "/tmp",
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
        },
      }),
    );

    expect(useStore.getState().taskPanelOpen).toBe(false);

    ws.simulateMessage(
      JSON.stringify({
        type: "session_update",
        session: { team: makeTeamState() },
      }),
    );

    expect(useStore.getState().taskPanelOpen).toBe(true);
  });

  it("session_update without prior session_init: no crash, accepts state", () => {
    const ws = openSession();
    // No session_init first — send update directly
    expect(() =>
      ws.simulateMessage(
        JSON.stringify({
          type: "session_update",
          session: { model: "sonnet", cwd: "/home" },
        }),
      ),
    ).not.toThrow();

    const state = getSessionData()?.state;
    expect(state?.model).toBe("sonnet");
  });

  // ── status_change ───────────────────────────────────────────────────────

  it("status_change: sets session status", () => {
    const ws = openSession();

    ws.simulateMessage(JSON.stringify({ type: "status_change", status: "running" }));
    expect(getSessionData()?.sessionStatus).toBe("running");

    ws.simulateMessage(JSON.stringify({ type: "status_change", status: "idle" }));
    expect(getSessionData()?.sessionStatus).toBe("idle");
  });

  // ── permission_request / permission_cancelled ───────────────────────────

  it("permission_request: adds to pending permissions", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "permission_request",
        request: {
          request_id: "perm-1",
          tool_use_id: "tu-1",
          tool_name: "Bash",
          description: "Run ls",
          input: { command: "ls" },
          timestamp: Date.now(),
        },
      }),
    );

    const perms = getSessionData()?.pendingPermissions;
    expect(perms?.["perm-1"]).toBeDefined();
    expect(perms?.["perm-1"].tool_name).toBe("Bash");
  });

  it("permission_cancelled: removes from pending permissions", () => {
    const ws = openSession();
    // First add one
    ws.simulateMessage(
      JSON.stringify({
        type: "permission_request",
        request: {
          request_id: "perm-1",
          tool_use_id: "tu-1",
          tool_name: "Bash",
          description: "Run ls",
          input: {},
          timestamp: Date.now(),
        },
      }),
    );
    expect(getSessionData()?.pendingPermissions?.["perm-1"]).toBeDefined();

    ws.simulateMessage(JSON.stringify({ type: "permission_cancelled", request_id: "perm-1" }));
    expect(getSessionData()?.pendingPermissions?.["perm-1"]).toBeUndefined();
  });

  // ── cli_connected / cli_disconnected ────────────────────────────────────

  it("cli_connected: sets cliConnected true", () => {
    const ws = openSession();
    ws.simulateMessage(JSON.stringify({ type: "cli_connected" }));
    expect(getSessionData()?.cliConnected).toBe(true);
  });

  it("cli_disconnected: sets cliConnected false", () => {
    const ws = openSession();
    ws.simulateMessage(JSON.stringify({ type: "cli_connected" }));
    ws.simulateMessage(JSON.stringify({ type: "cli_disconnected" }));
    expect(getSessionData()?.cliConnected).toBe(false);
  });

  // ── tool_progress ───────────────────────────────────────────────────────

  it("tool_progress: sets tool progress in store", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "tool_progress",
        tool_use_id: "tu-1",
        tool_name: "Bash",
        elapsed_time_seconds: 5,
      }),
    );

    expect(getSessionData()?.toolProgress?.["tu-1"]).toEqual({
      toolName: "Bash",
      elapsedSeconds: 5,
    });
  });

  // ── session_name_update ─────────────────────────────────────────────────

  it("session_name_update: updates session name", () => {
    const ws = openSession();

    ws.simulateMessage(JSON.stringify({ type: "session_name_update", name: "My Session" }));

    const sessions = useStore.getState().sessions;
    expect(sessions.s1?.name).toBe("My Session");
  });

  // ── identity ────────────────────────────────────────────────────────────

  it("identity: sets identity in store", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "identity",
        userId: "user-1",
        displayName: "Alice",
        role: "participant",
      }),
    );

    expect(getSessionData()?.identity).toEqual({
      userId: "user-1",
      displayName: "Alice",
      role: "participant",
    });
  });

  // ── presence_update ─────────────────────────────────────────────────────

  it("presence_update: sets presence list", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "presence_update",
        consumers: [
          { userId: "u1", displayName: "Alice", role: "participant" },
          { userId: "u2", displayName: "Bob", role: "observer" },
        ],
      }),
    );

    expect(getSessionData()?.presence).toHaveLength(2);
    expect(getSessionData()?.presence[0].userId).toBe("u1");
  });

  // ── auth_status ────────────────────────────────────────────────────────

  it("auth_status: sets authStatus in session data", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "auth_status",
        isAuthenticating: true,
        output: ["Opening browser for authentication..."],
      }),
    );

    expect(getSessionData()?.authStatus).toEqual({
      isAuthenticating: true,
      output: ["Opening browser for authentication..."],
      error: undefined,
    });
  });

  it("auth_status with error: sets error in authStatus", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "auth_status",
        isAuthenticating: false,
        output: [],
        error: "Token expired",
      }),
    );

    expect(getSessionData()?.authStatus).toEqual({
      isAuthenticating: false,
      output: [],
      error: "Token expired",
    });
  });

  // ── resume_failed ───────────────────────────────────────────────────────

  it("resume_failed: shows error toast", () => {
    const ws = openSession();

    ws.simulateMessage(JSON.stringify({ type: "resume_failed", sessionId: "old-sess" }));

    const toasts = useStore.getState().toasts;
    expect(toasts.length).toBeGreaterThanOrEqual(1);
    const toast = toasts[toasts.length - 1];
    expect(toast.message).toContain("Could not resume");
    expect(toast.type).toBe("error");
  });

  // ── process_output ──────────────────────────────────────────────────────

  it("process_output: strips ANSI and appends to process log", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "process_output",
        data: "\x1b[32mGreen text\x1b[0m",
      }),
    );

    const logs = useStore.getState().processLogs["s1"];
    expect(logs).toBeDefined();
    expect(logs[logs.length - 1]).toBe("Green text");
  });

  // ── Queue message helpers & cleanup ─────────────────────────────────

  afterEach(() => {
    for (const el of document.querySelectorAll("[data-queued-message]")) {
      el.remove();
    }
  });

  /** Seed a queued message into the store for session "s1". */
  function seedQueuedMessage(content = "queued") {
    useStore.getState().setQueuedMessage("s1", {
      consumerId: "c-1",
      displayName: "Alice",
      content,
      queuedAt: 1700000000,
    });
  }

  /** Mount a mock DOM element with `data-queued-message` and a fake bounding rect. */
  function mountQueuedMessageElement(rect = { top: 100, left: 50, width: 300 }): HTMLDivElement {
    const el = document.createElement("div");
    el.setAttribute("data-queued-message", "");
    el.getBoundingClientRect = () => rect as DOMRect;
    document.body.appendChild(el);
    return el;
  }

  // ── message_queued ──────────────────────────────────────────────────────

  it("message_queued: sets queued message in store", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "message_queued",
        consumer_id: "c-1",
        display_name: "Alice",
        content: "Fix the bug",
        images: [{ media_type: "image/png", data: "base64..." }],
        queued_at: 1700000000,
      }),
    );

    expect(getSessionData()?.queuedMessage).toEqual({
      consumerId: "c-1",
      displayName: "Alice",
      content: "Fix the bug",
      images: [{ media_type: "image/png", data: "base64..." }],
      queuedAt: 1700000000,
    });
  });

  it("message_queued: works without images field", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({
        type: "message_queued",
        consumer_id: "c-1",
        display_name: "Alice",
        content: "no images",
        queued_at: 1700000000,
      }),
    );

    const qm = getSessionData()?.queuedMessage;
    expect(qm?.content).toBe("no images");
    expect(qm?.images).toBeUndefined();
  });

  // ── queued_message_updated ────────────────────────────────────────────

  it("queued_message_updated: updates content and images of existing queued message", () => {
    const ws = openSession();
    seedQueuedMessage("original");

    ws.simulateMessage(
      JSON.stringify({
        type: "queued_message_updated",
        content: "updated content",
        images: [{ media_type: "image/jpeg", data: "new-base64" }],
      }),
    );

    const qm = getSessionData()?.queuedMessage;
    expect(qm?.content).toBe("updated content");
    expect(qm?.images).toEqual([{ media_type: "image/jpeg", data: "new-base64" }]);
    expect(qm?.consumerId).toBe("c-1");
    expect(qm?.displayName).toBe("Alice");
  });

  it("queued_message_updated: preserves isEditingQueue state", () => {
    const ws = openSession();
    seedQueuedMessage("original");
    useStore.getState().setEditingQueue("s1", true);

    ws.simulateMessage(JSON.stringify({ type: "queued_message_updated", content: "edited" }));

    expect(getSessionData()?.queuedMessage?.content).toBe("edited");
    expect(getSessionData()?.isEditingQueue).toBe(true);
  });

  it("queued_message_updated: no-op when no prior queued message exists", () => {
    const ws = openSession();

    ws.simulateMessage(
      JSON.stringify({ type: "queued_message_updated", content: "orphan update" }),
    );

    expect(getSessionData()?.queuedMessage).toBeNull();
  });

  // ── queued_message_cancelled ──────────────────────────────────────────

  it("queued_message_cancelled: clears queued message and editing state", () => {
    const ws = openSession();
    seedQueuedMessage();
    useStore.getState().setEditingQueue("s1", true);

    ws.simulateMessage(JSON.stringify({ type: "queued_message_cancelled" }));

    expect(getSessionData()?.queuedMessage).toBeNull();
    expect(getSessionData()?.isEditingQueue).toBe(false);
  });

  // ── queued_message_sent ───────────────────────────────────────────────

  it("queued_message_sent: clears queued message and editing state", () => {
    const ws = openSession();
    seedQueuedMessage();
    useStore.getState().setEditingQueue("s1", true);

    ws.simulateMessage(JSON.stringify({ type: "queued_message_sent" }));

    expect(getSessionData()?.queuedMessage).toBeNull();
    expect(getSessionData()?.isEditingQueue).toBe(false);
  });

  it("queued_message_sent: captures FLIP origin from DOM element", () => {
    const ws = openSession();
    seedQueuedMessage();

    mountQueuedMessageElement();

    ws.simulateMessage(JSON.stringify({ type: "queued_message_sent" }));

    expect(getSessionData()?.flipOrigin).toEqual({ top: 100, left: 50, width: 300 });
  });

  it("queued_message_sent: clears flipOrigin after 2s safety timeout", () => {
    const ws = openSession();
    seedQueuedMessage();

    mountQueuedMessageElement();

    ws.simulateMessage(JSON.stringify({ type: "queued_message_sent" }));
    expect(getSessionData()?.flipOrigin).not.toBeNull();

    // 2000ms matches the safety timeout in ws.ts queued_message_sent handler
    vi.advanceTimersByTime(2001);
    expect(getSessionData()?.flipOrigin).toBeNull();
  });

  it("queued_message_sent: no flipOrigin when no DOM element exists", () => {
    const ws = openSession();
    seedQueuedMessage();

    ws.simulateMessage(JSON.stringify({ type: "queued_message_sent" }));

    expect(getSessionData()?.flipOrigin).toBeNull();
  });

  // ── Unhandled message type ──────────────────────────────────────────────

  it("unhandled message type: silent drop, no crash", () => {
    const ws = openSession();
    expect(() =>
      ws.simulateMessage(JSON.stringify({ type: "some_future_type", data: "whatever" })),
    ).not.toThrow();
  });

  // ── configuration_change ────────────────────────────────────────────────

  it("configuration_change: updates model in session state", () => {
    const ws = openSession();
    ws.simulateMessage(
      JSON.stringify({
        type: "session_init",
        session: {
          session_id: "s1",
          model: "claude-sonnet-4-6",
          cwd: "/tmp",
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
        },
      }),
    );

    ws.simulateMessage(
      JSON.stringify({
        type: "configuration_change",
        subtype: "model_update",
        metadata: { model: "claude-opus-4-6" },
      }),
    );

    expect(getSessionData()?.state?.model).toBe("claude-opus-4-6");
  });

  it("configuration_change: no crash when no prior session_init", () => {
    const ws = openSession();
    expect(() =>
      ws.simulateMessage(
        JSON.stringify({
          type: "configuration_change",
          subtype: "model_update",
          metadata: { model: "claude-opus-4-6" },
        }),
      ),
    ).not.toThrow();
  });

  it("configuration_change: updates permissionMode for known values", () => {
    const ws = openSession();
    ws.simulateMessage(
      JSON.stringify({
        type: "session_init",
        session: {
          session_id: "s1",
          model: "claude-sonnet-4-6",
          cwd: "/tmp",
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
        },
      }),
    );

    ws.simulateMessage(
      JSON.stringify({
        type: "configuration_change",
        subtype: "permission_update",
        metadata: { permissionMode: "bypassPermissions" },
      }),
    );

    expect(getSessionData()?.state?.permissionMode).toBe("bypassPermissions");
  });

  it("configuration_change: ignores unknown permissionMode values", () => {
    const ws = openSession();
    ws.simulateMessage(
      JSON.stringify({
        type: "session_init",
        session: {
          session_id: "s1",
          model: "claude-sonnet-4-6",
          cwd: "/tmp",
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
          permissionMode: "default",
        },
      }),
    );

    ws.simulateMessage(
      JSON.stringify({
        type: "configuration_change",
        subtype: "permission_update",
        metadata: { permissionMode: "admin" },
      }),
    );

    // Unknown value should be ignored — permissionMode stays unchanged
    expect(getSessionData()?.state?.permissionMode).toBe("default");
  });

  it("configuration_change: empty metadata is a no-op", () => {
    const ws = openSession();
    ws.simulateMessage(
      JSON.stringify({
        type: "session_init",
        session: {
          session_id: "s1",
          model: "claude-sonnet-4-6",
          cwd: "/tmp",
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
        },
      }),
    );

    ws.simulateMessage(
      JSON.stringify({
        type: "configuration_change",
        subtype: "some_change",
        metadata: {},
      }),
    );

    // Model should be unchanged
    expect(getSessionData()?.state?.model).toBe("claude-sonnet-4-6");
  });

  // ── session_lifecycle ───────────────────────────────────────────────────

  it("session_lifecycle: no crash, no state change", () => {
    const ws = openSession();
    expect(() =>
      ws.simulateMessage(
        JSON.stringify({
          type: "session_lifecycle",
          subtype: "started",
          metadata: {},
        }),
      ),
    ).not.toThrow();
  });
});
