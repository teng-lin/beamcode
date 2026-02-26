import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsumerMessage, InboundMessage } from "../../../shared/consumer-types";
import { MAX_FLOW_MESSAGES, useMessageFlow } from "./useMessageFlow";

// Capture the listener callbacks registered via ws.ts exports
type InboundCb = (sessionId: string, msg: ConsumerMessage) => void;
type OutboundCb = (sessionId: string, msg: InboundMessage) => void;

const { inboundListeners, outboundListeners } = vi.hoisted(() => ({
  inboundListeners: new Set<InboundCb>(),
  outboundListeners: new Set<OutboundCb>(),
}));

vi.mock("../ws", () => ({
  addFlowInboundListener: (cb: InboundCb) => {
    inboundListeners.add(cb);
    return () => inboundListeners.delete(cb);
  },
  addFlowOutboundListener: (cb: OutboundCb) => {
    outboundListeners.add(cb);
    return () => outboundListeners.delete(cb);
  },
}));

const SESSION = "test-session";

function fireInbound(msg: Partial<ConsumerMessage> & { type: string }) {
  for (const cb of inboundListeners) cb(SESSION, msg as ConsumerMessage);
}

function fireOutbound(msg: Partial<InboundMessage> & { type: string }) {
  for (const cb of outboundListeners) cb(SESSION, msg as InboundMessage);
}

describe("useMessageFlow", () => {
  beforeEach(() => {
    inboundListeners.clear();
    outboundListeners.clear();
    vi.stubGlobal("crypto", { randomUUID: () => `uuid-${++uuidCounter}` });
    uuidCounter = 0;
  });

  let uuidCounter = 0;

  it("captures inbound and outbound messages", () => {
    const { result } = renderHook(() => useMessageFlow(SESSION));
    expect(result.current.messages).toHaveLength(0);

    act(() => fireInbound({ type: "assistant" }));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].direction).toBe("in");

    act(() => fireOutbound({ type: "user_message" }));
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].direction).toBe("out");
  });

  it("ring buffer caps at MAX_FLOW_MESSAGES", () => {
    const { result } = renderHook(() => useMessageFlow(SESSION));

    act(() => {
      for (let i = 0; i < MAX_FLOW_MESSAGES + 1; i++) {
        fireInbound({ type: "assistant" });
      }
    });

    expect(result.current.messages).toHaveLength(MAX_FLOW_MESSAGES);
    // First message should have been evicted; second message should be first
    expect(result.current.messages[0].id).toBe("uuid-2");
  });

  it("pause/resume: messages during pause appear on resume", () => {
    const { result } = renderHook(() => useMessageFlow(SESSION));

    act(() => fireInbound({ type: "assistant" }));
    expect(result.current.messages).toHaveLength(1);

    // Pause
    act(() => result.current.setPaused(true));
    expect(result.current.paused).toBe(true);

    // Messages during pause go to pending
    act(() => {
      fireInbound({ type: "stream_event" });
      fireInbound({ type: "result" });
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.pendingCount).toBe(2);

    // Resume flushes pending
    act(() => result.current.setPaused(false));
    expect(result.current.paused).toBe(false);
    expect(result.current.messages).toHaveLength(3);
    expect(result.current.pendingCount).toBe(0);
  });

  it("permission_request/permission_response pairing sets pairedId", () => {
    const { result } = renderHook(() => useMessageFlow(SESSION));

    // Inbound permission_request
    act(() =>
      fireInbound({
        type: "permission_request",
        request: { id: "req-1", tool: "Bash", input: {} },
      } as unknown as ConsumerMessage),
    );

    const reqMsg = result.current.messages[0];
    expect(reqMsg.type).toBe("permission_request");

    // Outbound permission_response
    act(() =>
      fireOutbound({
        type: "permission_response",
        request_id: "req-1",
        allowed: true,
      } as unknown as InboundMessage),
    );

    const resMsg = result.current.messages[1];
    expect(resMsg.type).toBe("permission_response");

    // Both should be paired
    expect(resMsg.pairedId).toBe(reqMsg.id);
    expect(reqMsg.pairedId).toBe(resMsg.id);
  });

  it("ignores messages for other sessions", () => {
    const { result } = renderHook(() => useMessageFlow(SESSION));

    act(() => {
      for (const cb of inboundListeners)
        cb("other-session", { type: "assistant" } as ConsumerMessage);
    });

    expect(result.current.messages).toHaveLength(0);
  });

  it("clear() resets all state", () => {
    const { result } = renderHook(() => useMessageFlow(SESSION));

    act(() => {
      fireInbound({ type: "assistant" });
      fireInbound({ type: "result" });
    });
    expect(result.current.messages).toHaveLength(2);

    act(() => result.current.clear());
    expect(result.current.messages).toHaveLength(0);
  });

  it("cleans up listeners on unmount", () => {
    const { unmount } = renderHook(() => useMessageFlow(SESSION));
    expect(inboundListeners.size).toBe(1);
    expect(outboundListeners.size).toBe(1);

    unmount();
    expect(inboundListeners.size).toBe(0);
    expect(outboundListeners.size).toBe(0);
  });
});
