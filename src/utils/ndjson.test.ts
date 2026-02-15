import { describe, expect, it } from "vitest";
import { NDJSONLineBuffer, parseNDJSON, serializeNDJSON } from "./ndjson.js";

// ─── parseNDJSON ──────────────────────────────────────────────────────────────

describe("parseNDJSON", () => {
  it("parses a single JSON line", () => {
    const { messages, errors } = parseNDJSON('{"type":"keep_alive"}');
    expect(messages).toEqual([{ type: "keep_alive" }]);
    expect(errors).toEqual([]);
  });

  it("parses multiple NDJSON lines", () => {
    const data = '{"type":"a"}\n{"type":"b"}\n{"type":"c"}';
    const { messages } = parseNDJSON(data);
    expect(messages).toHaveLength(3);
    expect(messages.map((m: any) => m.type)).toEqual(["a", "b", "c"]);
  });

  it("skips empty lines", () => {
    const data = '\n\n{"type":"a"}\n\n\n{"type":"b"}\n\n';
    const { messages, errors } = parseNDJSON(data);
    expect(messages).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it("skips whitespace-only lines", () => {
    const data = '   \n\t\n{"type":"a"}\n   \t  \n';
    const { messages } = parseNDJSON(data);
    expect(messages).toHaveLength(1);
  });

  it("collects malformed JSON in errors", () => {
    const data = '{"type":"a"}\nnot-json\n{"type":"b"}';
    const { messages, errors } = parseNDJSON(data);
    expect(messages).toHaveLength(2);
    expect(errors).toEqual(["not-json"]);
  });

  it("handles empty input", () => {
    const { messages, errors } = parseNDJSON("");
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("handles only whitespace/newlines", () => {
    const { messages, errors } = parseNDJSON("\n\n   \n\t\n");
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("handles \\r\\n line endings", () => {
    const data = '{"type":"a"}\r\n{"type":"b"}\r\n';
    const { messages } = parseNDJSON(data);
    expect(messages).toHaveLength(2);
  });

  it("handles truncated JSON in errors", () => {
    const { messages, errors } = parseNDJSON('{"type":"user_message","con');
    expect(messages).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

// ─── serializeNDJSON ──────────────────────────────────────────────────────────

describe("serializeNDJSON", () => {
  it("serializes to JSON + newline", () => {
    expect(serializeNDJSON({ type: "keep_alive" })).toBe('{"type":"keep_alive"}\n');
  });

  it("serializes nested objects", () => {
    const result = serializeNDJSON({ type: "user", message: { role: "user", content: "hi" } });
    expect(result.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(result.trim());
    expect(parsed.message.content).toBe("hi");
  });
});

// ─── NDJSONLineBuffer ─────────────────────────────────────────────────────────

describe("NDJSONLineBuffer", () => {
  it("yields complete lines from a single chunk", () => {
    const buf = new NDJSONLineBuffer();
    const lines = buf.feed('{"type":"a"}\n{"type":"b"}\n');
    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}']);
  });

  it("buffers partial lines across chunks", () => {
    const buf = new NDJSONLineBuffer();

    const lines1 = buf.feed('{"type":"par');
    expect(lines1).toEqual([]);

    const lines2 = buf.feed('tial"}\n');
    expect(lines2).toEqual(['{"type":"partial"}']);
  });

  it("handles data split mid-line across multiple chunks", () => {
    const buf = new NDJSONLineBuffer();

    expect(buf.feed("{")).toEqual([]);
    expect(buf.feed('"type"')).toEqual([]);
    expect(buf.feed(':"a"}\n')).toEqual(['{"type":"a"}']);
  });

  it("skips empty lines", () => {
    const buf = new NDJSONLineBuffer();
    const lines = buf.feed('\n\n{"type":"a"}\n\n');
    expect(lines).toEqual(['{"type":"a"}']);
  });

  it("handles \\r\\n line endings", () => {
    const buf = new NDJSONLineBuffer();
    const lines = buf.feed('{"type":"a"}\r\n{"type":"b"}\r\n');
    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}']);
  });

  it("handles \\r\\n split across chunks (\\r at end of chunk, \\n at start of next)", () => {
    const buf = new NDJSONLineBuffer();

    const lines1 = buf.feed('{"type":"a"}\r');
    // The \r is still in the buffer waiting for \n
    expect(lines1).toEqual([]);

    const lines2 = buf.feed('\n{"type":"b"}\n');
    expect(lines2).toEqual(['{"type":"a"}', '{"type":"b"}']);
  });

  it("handles Uint8Array input", () => {
    const buf = new NDJSONLineBuffer();
    const encoder = new TextEncoder();
    const lines = buf.feed(encoder.encode('{"type":"a"}\n'));
    expect(lines).toEqual(['{"type":"a"}']);
  });

  it("handles UTF-8 multi-byte split across chunks", () => {
    const buf = new NDJSONLineBuffer();
    const encoder = new TextEncoder();

    // "emoji: 😀" → the emoji is 4 bytes in UTF-8
    const fullLine = '{"text":"emoji: 😀"}\n';
    const bytes = encoder.encode(fullLine);

    // Split in the middle of the emoji (at various byte boundaries)
    const splitPoint = bytes.indexOf(0xf0); // Start of 4-byte emoji sequence
    const part1 = bytes.slice(0, splitPoint + 2); // Split mid-emoji
    const part2 = bytes.slice(splitPoint + 2);

    const lines1 = buf.feed(part1);
    expect(lines1).toEqual([]);

    const lines2 = buf.feed(part2);
    expect(lines2).toHaveLength(1);
    const parsed = JSON.parse(lines2[0]);
    expect(parsed.text).toBe("emoji: 😀");
  });

  it("flush() returns remaining buffered data", () => {
    const buf = new NDJSONLineBuffer();
    buf.feed('{"type":"incomplete"}');
    // No newline yet

    const remaining = buf.flush();
    expect(remaining).toBe('{"type":"incomplete"}');
    expect(buf.size).toBe(0);
  });

  it("flush() returns null when buffer is empty", () => {
    const buf = new NDJSONLineBuffer();
    expect(buf.flush()).toBeNull();
  });

  it("flush() returns null when buffer is only whitespace", () => {
    const buf = new NDJSONLineBuffer();
    buf.feed("   ");
    expect(buf.flush()).toBeNull();
  });

  it("reset() clears the buffer", () => {
    const buf = new NDJSONLineBuffer();
    buf.feed('{"type":"partial');
    expect(buf.size).toBeGreaterThan(0);

    buf.reset();
    expect(buf.size).toBe(0);
    expect(buf.flush()).toBeNull();
  });

  it("size reports current buffer length", () => {
    const buf = new NDJSONLineBuffer();
    expect(buf.size).toBe(0);

    buf.feed('{"type":"a"}');
    expect(buf.size).toBe(12);

    buf.feed("\n");
    // After yielding the line, buffer should be empty
    expect(buf.size).toBe(0);
  });

  it("handles oversized single line without crashing", () => {
    const buf = new NDJSONLineBuffer();
    const bigValue = "x".repeat(100_000);
    const lines = buf.feed(`{"data":"${bigValue}"}\n`);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.data.length).toBe(100_000);
  });

  it("handles interleaved valid and empty lines", () => {
    const buf = new NDJSONLineBuffer();
    const lines = buf.feed('{"a":1}\n\n\n{"b":2}\n   \n{"c":3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});
