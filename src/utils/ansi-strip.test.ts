import { describe, expect, it } from "vitest";
import { stripAnsi } from "./ansi-strip.js";

describe("stripAnsi", () => {
  it("passes plain text through unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("strips SGR color codes", () => {
    expect(stripAnsi("\x1B[31mred text\x1B[0m")).toBe("red text");
  });

  it("strips bold/dim/underline SGR codes", () => {
    expect(stripAnsi("\x1B[1mbold\x1B[22m \x1B[4munderline\x1B[24m")).toBe("bold underline");
  });

  it("strips 256-color codes", () => {
    expect(stripAnsi("\x1B[38;5;196mred\x1B[0m")).toBe("red");
  });

  it("strips 24-bit true color codes", () => {
    expect(stripAnsi("\x1B[38;2;255;0;0mred\x1B[0m")).toBe("red");
  });

  it("strips cursor movement codes", () => {
    expect(stripAnsi("\x1B[2Amove up\x1B[3Bmove down")).toBe("move upmove down");
  });

  it("strips erase codes", () => {
    expect(stripAnsi("\x1B[2Jclear screen\x1B[K")).toBe("clear screen");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("handles string with only ANSI codes", () => {
    expect(stripAnsi("\x1B[31m\x1B[0m")).toBe("");
  });

  it("handles multiple ANSI codes interleaved with text", () => {
    const input = "\x1B[32m> \x1B[0mType a message\x1B[36m...\x1B[0m";
    expect(stripAnsi(input)).toBe("> Type a message...");
  });
});
