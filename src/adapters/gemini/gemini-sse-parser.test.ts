import { describe, expect, it } from "vitest";
import { MAX_SSE_BUFFER_SIZE, parseSSEData, parseSSEStream } from "./gemini-sse-parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function toChunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collectEvents(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const events = [];
  for await (const event of parseSSEStream(stream, signal)) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gemini-sse-parser", () => {
  describe("parseSSEStream", () => {
    it("parses a single SSE event", async () => {
      const sse = 'data: {"result":"ok"}\n\n';
      const events = await collectEvents(toStream(sse));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe('{"result":"ok"}');
    });

    it("parses multiple SSE events", async () => {
      const sse = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
      const events = await collectEvents(toStream(sse));
      expect(events).toHaveLength(2);
      expect(events[0].data).toBe('{"a":1}');
      expect(events[1].data).toBe('{"b":2}');
    });

    it("parses event with id and event fields", async () => {
      const sse = "id: 42\nevent: update\ndata: hello\n\n";
      const events = await collectEvents(toStream(sse));
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("42");
      expect(events[0].event).toBe("update");
      expect(events[0].data).toBe("hello");
    });

    it("handles multi-line data (joined with newlines)", async () => {
      const sse = "data: line1\ndata: line2\ndata: line3\n\n";
      const events = await collectEvents(toStream(sse));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("line1\nline2\nline3");
    });

    it("ignores comment lines", async () => {
      const sse = ": this is a comment\ndata: actual data\n\n";
      const events = await collectEvents(toStream(sse));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("actual data");
    });

    it("handles chunked delivery", async () => {
      const chunks = ['data: {"part', '":"full"}\n\n'];
      const events = await collectEvents(toChunkedStream(chunks));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe('{"part":"full"}');
    });

    it("handles empty stream", async () => {
      const events = await collectEvents(toStream(""));
      expect(events).toHaveLength(0);
    });

    it("handles trailing data without double newline", async () => {
      const sse = "data: trailing";
      const events = await collectEvents(toStream(sse));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("trailing");
    });

    it("skips blocks with no data lines", async () => {
      const sse = ": just a comment\n\ndata: real event\n\n";
      const events = await collectEvents(toStream(sse));
      expect(events).toHaveLength(1);
      expect(events[0].data).toBe("real event");
    });

    it("handles \\r\\n line endings", async () => {
      const sse = "data: event1\r\n\r\ndata: event2\r\n\r\n";
      const events = await collectEvents(toStream(sse));
      expect(events).toHaveLength(2);
      expect(events[0].data).toBe("event1");
      expect(events[1].data).toBe("event2");
    });

    it("handles standalone \\r line endings", async () => {
      const sse = "data: cronly\r\rdata: second\r\r";
      const events = await collectEvents(toStream(sse));
      expect(events).toHaveLength(2);
      expect(events[0].data).toBe("cronly");
    });

    it("respects abort signal", async () => {
      const controller = new AbortController();
      controller.abort();
      const events = await collectEvents(
        toStream("data: should not appear\n\n"),
        controller.signal,
      );
      expect(events).toHaveLength(0);
    });

    it("throws when buffer exceeds maximum size", async () => {
      // Create a stream that sends a single huge chunk without event delimiters
      const hugeChunk = "data: " + "x".repeat(MAX_SSE_BUFFER_SIZE + 1);
      await expect(collectEvents(toStream(hugeChunk))).rejects.toThrow(
        "SSE buffer exceeded maximum size",
      );
    });

    it("handles \\r\\n split across chunks", async () => {
      // \r at end of first chunk, \n at start of second
      const chunks = ["data: split\r", "\n\r\ndata: next\r\n\r\n"];
      const events = await collectEvents(toChunkedStream(chunks));
      expect(events).toHaveLength(2);
      expect(events[0].data).toBe("split");
      expect(events[1].data).toBe("next");
    });

    it("handles A2A-style JSON-RPC SSE events", async () => {
      const event1 = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { kind: "task", id: "t-1", contextId: "c-1", status: { state: "submitted" } },
      });
      const event2 = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          kind: "status-update",
          taskId: "t-1",
          contextId: "c-1",
          status: { state: "working" },
          metadata: { coderAgent: { kind: "text-content" } },
        },
      });
      const sse = `data: ${event1}\n\ndata: ${event2}\n\n`;
      const events = await collectEvents(toStream(sse));
      expect(events).toHaveLength(2);

      const parsed1 = JSON.parse(events[0].data);
      expect(parsed1.result.kind).toBe("task");

      const parsed2 = JSON.parse(events[1].data);
      expect(parsed2.result.kind).toBe("status-update");
    });
  });

  describe("parseSSEData", () => {
    it("parses valid JSON", () => {
      const result = parseSSEData<{ a: number }>('{"a": 1}');
      expect(result).toEqual({ a: 1 });
    });

    it("returns null for invalid JSON", () => {
      expect(parseSSEData("not json")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseSSEData("")).toBeNull();
    });

    it("handles nested objects", () => {
      const result = parseSSEData<{ result: { kind: string } }>('{"result":{"kind":"task"}}');
      expect(result?.result.kind).toBe("task");
    });
  });
});
