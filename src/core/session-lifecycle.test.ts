import { describe, expect, it } from "vitest";
import { isLifecycleTransitionAllowed } from "./session-lifecycle.js";

describe("session lifecycle transitions", () => {
  it("allows expected forward transitions", () => {
    expect(isLifecycleTransitionAllowed("starting", "awaiting_backend")).toBe(true);
    expect(isLifecycleTransitionAllowed("awaiting_backend", "active")).toBe(true);
    expect(isLifecycleTransitionAllowed("active", "idle")).toBe(true);
    expect(isLifecycleTransitionAllowed("idle", "active")).toBe(true);
    expect(isLifecycleTransitionAllowed("degraded", "awaiting_backend")).toBe(true);
    expect(isLifecycleTransitionAllowed("closing", "closed")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(isLifecycleTransitionAllowed("starting", "idle")).toBe(false);
    expect(isLifecycleTransitionAllowed("closed", "active")).toBe(false);
    expect(isLifecycleTransitionAllowed("closing", "active")).toBe(false);
  });
});
