import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRuntime } from "../session-runtime.js";
import { RuntimeManager } from "./runtime-manager.js";

function stubSession(id: string) {
  return { id } as any;
}

function stubRuntime(overrides?: Partial<SessionRuntime>): SessionRuntime {
  return {
    getLifecycleState: vi.fn().mockReturnValue("awaiting_backend"),
    handleSignal: vi.fn(),
    ...overrides,
  } as unknown as SessionRuntime;
}

describe("RuntimeManager", () => {
  let manager: RuntimeManager;
  let factory: ReturnType<typeof vi.fn>;
  let runtime: SessionRuntime;

  beforeEach(() => {
    runtime = stubRuntime();
    factory = vi.fn().mockReturnValue(runtime);
    manager = new RuntimeManager(factory);
  });

  // ── getOrCreate ──────────────────────────────────────────────────────────

  it("creates runtime via factory on first call", () => {
    const session = stubSession("s1");
    const result = manager.getOrCreate(session);

    expect(factory).toHaveBeenCalledWith(session);
    expect(result).toBe(runtime);
  });

  it("returns same instance on subsequent calls", () => {
    const session = stubSession("s1");
    const first = manager.getOrCreate(session);
    const second = manager.getOrCreate(session);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  // ── get ──────────────────────────────────────────────────────────────────

  it("get() returns undefined for unknown sessionId", () => {
    expect(manager.get("unknown")).toBeUndefined();
  });

  it("get() returns runtime after getOrCreate", () => {
    manager.getOrCreate(stubSession("s1"));
    expect(manager.get("s1")).toBe(runtime);
  });

  // ── has / delete / clear / keys ──────────────────────────────────────────

  it("has() reflects runtime presence", () => {
    expect(manager.has("s1")).toBe(false);
    manager.getOrCreate(stubSession("s1"));
    expect(manager.has("s1")).toBe(true);
  });

  it("delete() removes entry", () => {
    manager.getOrCreate(stubSession("s1"));
    expect(manager.delete("s1")).toBe(true);
    expect(manager.has("s1")).toBe(false);
  });

  it("clear() removes all entries", () => {
    manager.getOrCreate(stubSession("s1"));
    manager.getOrCreate(stubSession("s2"));
    manager.clear();
    expect(manager.has("s1")).toBe(false);
    expect(manager.has("s2")).toBe(false);
  });

  it("keys() yields all session IDs", () => {
    manager.getOrCreate(stubSession("a"));
    manager.getOrCreate(stubSession("b"));
    expect([...manager.keys()]).toEqual(["a", "b"]);
  });

  // ── getLifecycleState ────────────────────────────────────────────────────

  it("getLifecycleState() returns lifecycle from runtime", () => {
    manager.getOrCreate(stubSession("s1"));
    expect(manager.getLifecycleState("s1")).toBe("awaiting_backend");
  });

  it("getLifecycleState() returns undefined for unknown session", () => {
    expect(manager.getLifecycleState("nope")).toBeUndefined();
  });

  // ── handleLifecycleSignal ────────────────────────────────────────────────

  it("handleLifecycleSignal calls runtime.handleSignal with correct signal", () => {
    manager.getOrCreate(stubSession("s1"));
    manager.handleLifecycleSignal("s1", "backend:connected");
    expect(runtime.handleSignal).toHaveBeenCalledWith("backend:connected");
  });

  it("handleLifecycleSignal is a no-op for unknown sessionId", () => {
    expect(() => manager.handleLifecycleSignal("ghost", "session:closed")).not.toThrow();
  });
});
