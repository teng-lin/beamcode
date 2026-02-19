import { describe, expect, it } from "vitest";
import { parseSseStream, type SseEvent } from "./sse-parser.js";

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("parseSseStream", () => {
  it("parses a single data event", async () => {
    const stream = textStream('data: {"type":"test"}\n\n');
    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events).toEqual([{ data: '{"type":"test"}' }]);
  });

  it("parses multiple events", async () => {
    const stream = textStream("data: first\n\ndata: second\n\n");
    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe("first");
    expect(events[1].data).toBe("second");
  });

  it("concatenates multi-line data fields", async () => {
    const stream = textStream("data: line1\ndata: line2\n\n");
    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events[0].data).toBe("line1\nline2");
  });

  it("ignores comment lines (starting with colon)", async () => {
    const stream = textStream(": this is a comment\ndata: real\n\n");
    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("real");
  });

  it("handles chunked delivery across data boundaries", async () => {
    const chunks = ["data: hel", "lo\n\ndata: world\n\n"];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });
    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe("hello");
    expect(events[1].data).toBe("world");
  });

  it("skips events with no data field", async () => {
    const stream = textStream("event: ping\n\ndata: real\n\n");
    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("real");
  });

  it("returns empty async iterable for empty stream", async () => {
    const stream = textStream("");
    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(0);
  });
});
