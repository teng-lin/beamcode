import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "./store";
import { resetStore } from "./test/factories";
import { _resetForTesting, connectToSession, disconnect, disconnectSession, send } from "./ws";

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
