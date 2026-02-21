import { describe, expect, it } from "vitest";
import { createUnifiedMessage } from "../core/types/unified-message.js";
import { FailureInjectionBackendAdapter } from "./failure-injection-adapter.js";

describe("FailureInjectionBackendAdapter", () => {
  it("fails deterministic connect attempts, then succeeds", async () => {
    const adapter = new FailureInjectionBackendAdapter({ failConnectTimes: 1 });

    await expect(adapter.connect({ sessionId: "s1" })).rejects.toThrow(
      "Injected connect failure #1",
    );
    const session = await adapter.connect({ sessionId: "s1" });

    expect(adapter.connectAttempts).toBe(2);
    expect(session.sessionId).toBe("s1");
  });

  it("can inject stream failure after delivering messages", async () => {
    const adapter = new FailureInjectionBackendAdapter();
    const session = await adapter.connect({ sessionId: "s1" });
    const iterator = session.messages[Symbol.asyncIterator]();

    const msg = createUnifiedMessage({
      type: "status_change",
      role: "system",
      metadata: { status: "running" },
    });
    adapter.pushMessage("s1", msg);
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value.type).toBe("status_change");

    const nextPromise = iterator.next();
    adapter.failStream("s1", new Error("boom"));
    await expect(nextPromise).rejects.toThrow("boom");
  });
});
