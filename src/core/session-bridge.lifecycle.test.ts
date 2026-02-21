import { describe, expect, it } from "vitest";
import {
  createBridgeWithAdapter,
  makeResultUnifiedMsg,
  makeStatusChangeMsg,
  makeStreamEventUnifiedMsg,
  tick,
} from "../testing/adapter-test-helpers.js";

describe("SessionBridge lifecycle tracking", () => {
  it("tracks lifecycle from backend events and routed messages", async () => {
    const { bridge, adapter } = createBridgeWithAdapter();

    bridge.getOrCreateSession("life-1");
    expect(bridge.getLifecycleState("life-1")).toBe("awaiting_backend");
    expect(bridge.getSession("life-1")?.lifecycle).toBe("awaiting_backend");

    await bridge.connectBackend("life-1");
    await tick();
    expect(bridge.getLifecycleState("life-1")).toBe("active");
    expect(bridge.getSession("life-1")?.lifecycle).toBe("active");

    const backendSession = adapter.getSession("life-1");
    expect(backendSession).toBeDefined();

    backendSession!.pushMessage(makeStatusChangeMsg({ status: "idle" }));
    await tick();
    expect(bridge.getLifecycleState("life-1")).toBe("idle");

    backendSession!.pushMessage(
      makeStreamEventUnifiedMsg({
        event: { type: "message_start" },
        parent_tool_use_id: null,
      }),
    );
    await tick();
    expect(bridge.getLifecycleState("life-1")).toBe("active");

    backendSession!.pushMessage(makeResultUnifiedMsg());
    await tick();
    expect(bridge.getLifecycleState("life-1")).toBe("idle");

    await bridge.disconnectBackend("life-1");
    await tick();
    expect(bridge.getLifecycleState("life-1")).toBe("degraded");

    await bridge.closeSession("life-1");
    expect(bridge.getLifecycleState("life-1")).toBeUndefined();
  });
});
