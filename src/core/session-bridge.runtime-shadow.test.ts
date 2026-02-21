import { describe, expect, it, vi } from "vitest";
import {
  createBridgeWithAdapter,
  makeStatusChangeMsg,
  tick,
} from "../testing/adapter-test-helpers.js";
import type { MessageTracer } from "./message-tracer.js";

describe("SessionBridge runtime shadow mode", () => {
  it("tracks backend lifecycle and message flow in vnext_shadow mode", async () => {
    const { bridge, adapter } = createBridgeWithAdapter({ runtimeMode: "vnext_shadow" });

    bridge.getOrCreateSession("shadow-1");
    await tick();
    expect(bridge.getRuntimeShadowSnapshot("shadow-1")?.lifecycle).toBe("awaiting_backend");

    await bridge.connectBackend("shadow-1");
    await tick();
    expect(bridge.getRuntimeShadowSnapshot("shadow-1")?.lifecycle).toBe("active");

    const backendSession = adapter.getSession("shadow-1");
    expect(backendSession).toBeDefined();
    backendSession!.pushMessage(makeStatusChangeMsg({ status: "idle" }));
    await tick();

    const afterMessage = bridge.getRuntimeShadowSnapshot("shadow-1");
    expect(afterMessage?.processedBackendCount).toBeGreaterThan(0);
    expect(afterMessage?.lastBackendType).toBe("status_change");
    expect(afterMessage?.lifecycle).toBe("idle");

    await bridge.disconnectBackend("shadow-1");
    await tick();
    expect(bridge.getRuntimeShadowSnapshot("shadow-1")?.lifecycle).toBe("degraded");

    await bridge.closeSession("shadow-1");
    expect(bridge.getRuntimeShadowSnapshot("shadow-1")).toBeUndefined();
  });

  it("tracks inbound consumer commands without changing legacy behavior", async () => {
    const { bridge, adapter } = createBridgeWithAdapter({ runtimeMode: "vnext_shadow" });
    const session = bridge.getOrCreateSession("shadow-2");

    await bridge.connectBackend("shadow-2");
    const backendSession = adapter.getSession("shadow-2");
    expect(backendSession).toBeDefined();

    const ws = { send: vi.fn(), close: vi.fn(), bufferedAmount: 0 } as any;
    session.consumerSockets.set(ws, {
      userId: "u1",
      displayName: "User One",
      role: "participant",
    });

    bridge.handleConsumerMessage(ws, "shadow-2", JSON.stringify({ type: "interrupt" }));
    await tick();

    const snapshot = bridge.getRuntimeShadowSnapshot("shadow-2");
    expect(snapshot?.processedInboundCount).toBe(1);
    expect(snapshot?.lastInboundType).toBe("interrupt");
    expect(backendSession!.sentMessages.some((msg) => msg.type === "interrupt")).toBe(true);
  });

  it("does not report parity mismatch on normal lifecycle transitions", async () => {
    const tracer: MessageTracer = {
      send: vi.fn(),
      recv: vi.fn(),
      translate: vi.fn(),
      error: vi.fn(),
      summary: vi.fn(() => ({
        totalTraces: 0,
        complete: 0,
        stale: 0,
        errors: 0,
        avgRoundTripMs: 0,
      })),
      destroy: vi.fn(),
    };
    const { bridge, adapter } = createBridgeWithAdapter({
      runtimeMode: "vnext_shadow",
      tracer,
    });

    bridge.getOrCreateSession("shadow-3");
    await bridge.connectBackend("shadow-3");
    const backendSession = adapter.getSession("shadow-3");
    expect(backendSession).toBeDefined();

    backendSession!.pushMessage(makeStatusChangeMsg({ status: "idle" }));
    await tick();

    expect(tracer.error).not.toHaveBeenCalledWith(
      "bridge",
      "runtime_shadow_parity",
      expect.any(String),
      expect.anything(),
    );
  });

  it("reports parity mismatch when shadow lifecycle diverges", () => {
    const tracer: MessageTracer = {
      send: vi.fn(),
      recv: vi.fn(),
      translate: vi.fn(),
      error: vi.fn(),
      summary: vi.fn(() => ({
        totalTraces: 0,
        complete: 0,
        stale: 0,
        errors: 0,
        avgRoundTripMs: 0,
      })),
      destroy: vi.fn(),
    };
    const { bridge } = createBridgeWithAdapter({
      runtimeMode: "vnext_shadow",
      tracer,
    });

    bridge.getOrCreateSession("shadow-4");
    (bridge as any).forwardEvent("session:closed", { sessionId: "shadow-4" });

    expect(tracer.error).toHaveBeenCalledWith(
      "bridge",
      "runtime_shadow_parity",
      "shadow lifecycle mismatch",
      expect.objectContaining({
        sessionId: "shadow-4",
      }),
    );
  });
});
