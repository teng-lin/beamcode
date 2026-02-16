import { beforeEach, describe, expect, it, vi } from "vitest";
import { TypedEventEmitter } from "./typed-emitter.js";

// ---------------------------------------------------------------------------
// Test subclass — exposes protected `emit` for testing
// ---------------------------------------------------------------------------

interface TestEvents {
  foo: { x: number };
  bar: string;
}

class TestEmitter extends TypedEventEmitter<TestEvents> {
  public testEmit<K extends keyof TestEvents & string>(event: K, payload: TestEvents[K]): boolean {
    return this.emit(event, payload);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TypedEventEmitter", () => {
  let emitter: TestEmitter;

  beforeEach(() => {
    emitter = new TestEmitter();
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  describe("constructor", () => {
    it("sets maxListeners to 100", () => {
      // Verify by adding > 10 listeners without warning (default is 10)
      const warn = vi.spyOn(process, "emitWarning");
      for (let i = 0; i < 50; i++) {
        emitter.on("foo", () => {});
      }
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // on
  // -----------------------------------------------------------------------

  describe("on", () => {
    it("receives emitted events", () => {
      const received: { x: number }[] = [];
      emitter.on("foo", (payload) => received.push(payload));

      emitter.testEmit("foo", { x: 42 });

      expect(received).toEqual([{ x: 42 }]);
    });

    it("fires on every emit", () => {
      const received: string[] = [];
      emitter.on("bar", (payload) => received.push(payload));

      emitter.testEmit("bar", "first");
      emitter.testEmit("bar", "second");

      expect(received).toEqual(["first", "second"]);
    });

    it("returns this for chaining", () => {
      const result = emitter.on("foo", () => {});
      expect(result).toBe(emitter);
    });
  });

  // -----------------------------------------------------------------------
  // once
  // -----------------------------------------------------------------------

  describe("once", () => {
    it("fires only once", () => {
      const received: string[] = [];
      emitter.once("bar", (payload) => received.push(payload));

      emitter.testEmit("bar", "first");
      emitter.testEmit("bar", "second");

      expect(received).toEqual(["first"]);
    });

    it("returns this for chaining", () => {
      const result = emitter.once("bar", () => {});
      expect(result).toBe(emitter);
    });
  });

  // -----------------------------------------------------------------------
  // off
  // -----------------------------------------------------------------------

  describe("off", () => {
    it("removes a specific listener", () => {
      const received: string[] = [];
      const listener = (payload: string) => received.push(payload);

      emitter.on("bar", listener);
      emitter.testEmit("bar", "before");

      emitter.off("bar", listener);
      emitter.testEmit("bar", "after");

      expect(received).toEqual(["before"]);
    });

    it("does not affect other listeners on the same event", () => {
      const receivedA: string[] = [];
      const receivedB: string[] = [];
      const listenerA = (payload: string) => receivedA.push(payload);
      const listenerB = (payload: string) => receivedB.push(payload);

      emitter.on("bar", listenerA);
      emitter.on("bar", listenerB);
      emitter.off("bar", listenerA);

      emitter.testEmit("bar", "hello");

      expect(receivedA).toEqual([]);
      expect(receivedB).toEqual(["hello"]);
    });

    it("returns this for chaining", () => {
      const listener = () => {};
      emitter.on("bar", listener);
      const result = emitter.off("bar", listener);
      expect(result).toBe(emitter);
    });
  });

  // -----------------------------------------------------------------------
  // removeAllListeners
  // -----------------------------------------------------------------------

  describe("removeAllListeners", () => {
    it("removes all listeners for a specific event", () => {
      const receivedFoo: { x: number }[] = [];
      const receivedBar: string[] = [];

      emitter.on("foo", (payload) => receivedFoo.push(payload));
      emitter.on("bar", (payload) => receivedBar.push(payload));

      emitter.removeAllListeners("foo");

      emitter.testEmit("foo", { x: 1 });
      emitter.testEmit("bar", "still here");

      expect(receivedFoo).toEqual([]);
      expect(receivedBar).toEqual(["still here"]);
    });

    it("removes all listeners for all events when called without arguments", () => {
      const receivedFoo: { x: number }[] = [];
      const receivedBar: string[] = [];

      emitter.on("foo", (payload) => receivedFoo.push(payload));
      emitter.on("bar", (payload) => receivedBar.push(payload));

      emitter.removeAllListeners();

      emitter.testEmit("foo", { x: 1 });
      emitter.testEmit("bar", "gone");

      expect(receivedFoo).toEqual([]);
      expect(receivedBar).toEqual([]);
    });

    it("returns this for chaining", () => {
      const result = emitter.removeAllListeners("foo");
      expect(result).toBe(emitter);
    });
  });

  // -----------------------------------------------------------------------
  // listenerCount
  // -----------------------------------------------------------------------

  describe("listenerCount", () => {
    it("returns 0 when no listeners are registered", () => {
      expect(emitter.listenerCount("foo")).toBe(0);
    });

    it("returns correct count after adding listeners", () => {
      emitter.on("foo", () => {});
      emitter.on("foo", () => {});
      emitter.on("bar", () => {});

      expect(emitter.listenerCount("foo")).toBe(2);
      expect(emitter.listenerCount("bar")).toBe(1);
    });

    it("decrements after removing a listener", () => {
      const listener = () => {};
      emitter.on("foo", listener);
      emitter.on("foo", () => {});

      expect(emitter.listenerCount("foo")).toBe(2);

      emitter.off("foo", listener);
      expect(emitter.listenerCount("foo")).toBe(1);
    });

    it("returns 0 after removeAllListeners", () => {
      emitter.on("foo", () => {});
      emitter.on("foo", () => {});
      emitter.removeAllListeners("foo");

      expect(emitter.listenerCount("foo")).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // emit
  // -----------------------------------------------------------------------

  describe("emit", () => {
    it("returns false when no listeners are registered", () => {
      expect(emitter.testEmit("foo", { x: 1 })).toBe(false);
    });

    it("returns true when at least one listener is registered", () => {
      emitter.on("foo", () => {});
      expect(emitter.testEmit("foo", { x: 1 })).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple event types
  // -----------------------------------------------------------------------

  describe("multiple event types", () => {
    it("events of different types are independent", () => {
      const fooPayloads: { x: number }[] = [];
      const barPayloads: string[] = [];

      emitter.on("foo", (payload) => fooPayloads.push(payload));
      emitter.on("bar", (payload) => barPayloads.push(payload));

      emitter.testEmit("foo", { x: 10 });
      emitter.testEmit("bar", "hello");
      emitter.testEmit("foo", { x: 20 });

      expect(fooPayloads).toEqual([{ x: 10 }, { x: 20 }]);
      expect(barPayloads).toEqual(["hello"]);
    });
  });
});
