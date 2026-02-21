import { describe, expect, it } from "vitest";
import { DomainEventBus } from "./domain-event-bus.js";

describe("DomainEventBus", () => {
  it("publishes bridge events with envelope metadata", () => {
    const bus = new DomainEventBus();
    const seen: unknown[] = [];
    bus.on("backend:connected", (event) => seen.push(event));

    bus.publishBridge("backend:connected", { sessionId: "s1" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      source: "bridge",
      type: "backend:connected",
      payload: { sessionId: "s1" },
    });
    expect(typeof (seen[0] as { timestamp: unknown }).timestamp).toBe("number");
  });

  it("publishes launcher events with envelope metadata", () => {
    const bus = new DomainEventBus();
    const seen: unknown[] = [];
    bus.on("process:spawned", (event) => seen.push(event));

    bus.publishLauncher("process:spawned", { sessionId: "s2", pid: 1234 });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      source: "launcher",
      type: "process:spawned",
      payload: { sessionId: "s2", pid: 1234 },
    });
  });
});
