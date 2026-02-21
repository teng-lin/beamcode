import { describe, expect, it } from "vitest";
import { SessionRuntimeShadow } from "./runtime-shadow.js";
import { createUnifiedMessage } from "./types/unified-message.js";

function waitTick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("SessionRuntimeShadow", () => {
  it("tracks lifecycle transitions from signals", async () => {
    const runtime = new SessionRuntimeShadow("s1");
    runtime.handleSignal("session_created");
    runtime.handleSignal("backend_connected");
    runtime.handleSignal("backend_disconnected");
    await waitTick();

    const snapshot = runtime.snapshot();
    expect(snapshot.lifecycle).toBe("degraded");
    expect(snapshot.processedSignalCount).toBe(3);
    expect(snapshot.lastSignal).toBe("backend_disconnected");
  });

  it("serializes inbound/backend accounting", async () => {
    const runtime = new SessionRuntimeShadow("s1");
    runtime.handleSignal("session_created");
    runtime.handleInbound("user_message");
    runtime.handleInbound("interrupt");
    runtime.handleBackendMessage(
      createUnifiedMessage({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      }),
    );
    runtime.handleBackendMessage(
      createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { status: "idle" },
      }),
    );
    await waitTick();

    const snapshot = runtime.snapshot();
    expect(snapshot.processedInboundCount).toBe(2);
    expect(snapshot.processedBackendCount).toBe(2);
    expect(snapshot.lastInboundType).toBe("interrupt");
    expect(snapshot.lastBackendType).toBe("status_change");
    expect(snapshot.lifecycle).toBe("idle");
  });

  it("maps result to idle and message_start to active", () => {
    const runtime = new SessionRuntimeShadow("s2");
    runtime.handleSignal("session_created");
    runtime.handleSignal("backend_connected");
    runtime.handleBackendMessage(
      createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: { is_error: false },
      }),
    );
    expect(runtime.snapshot().lifecycle).toBe("idle");

    runtime.handleBackendMessage(
      createUnifiedMessage({
        type: "stream_event",
        role: "system",
        metadata: { event: { type: "message_start" }, parent_tool_use_id: null },
      }),
    );
    expect(runtime.snapshot().lifecycle).toBe("active");
  });
});
