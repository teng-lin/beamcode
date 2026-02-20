import { describe, expect, it } from "vitest";
import { RingBuffer } from "./ring-buffer.js";

describe("RingBuffer", () => {
  it("starts empty", () => {
    const buf = new RingBuffer<number>(5);
    expect(buf.size).toBe(0);
    expect(buf.toArray()).toEqual([]);
  });

  it("pushes below capacity", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    expect(buf.size).toBe(2);
    expect(buf.toArray()).toEqual([1, 2]);
  });

  it("pushes exactly at capacity", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.size).toBe(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
  });

  it("overwrites oldest when beyond capacity", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    expect(buf.size).toBe(3);
    expect(buf.toArray()).toEqual([2, 3, 4]);
  });

  it("maintains insertion order after multiple wrap-arounds", () => {
    const buf = new RingBuffer<number>(3);
    for (let i = 1; i <= 10; i++) buf.push(i);
    expect(buf.toArray()).toEqual([8, 9, 10]);
  });

  it("works with capacity=1", () => {
    const buf = new RingBuffer<string>(1);
    buf.push("a");
    expect(buf.toArray()).toEqual(["a"]);
    buf.push("b");
    expect(buf.size).toBe(1);
    expect(buf.toArray()).toEqual(["b"]);
  });

  it("clear resets state", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.toArray()).toEqual([]);
    buf.push(10);
    expect(buf.toArray()).toEqual([10]);
  });

  it("throws on invalid capacity", () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(-1)).toThrow(RangeError);
    expect(() => new RingBuffer(NaN)).toThrow(RangeError);
    expect(() => new RingBuffer(1.5)).toThrow(RangeError);
    expect(() => new RingBuffer(Infinity)).toThrow(RangeError);
  });
});
