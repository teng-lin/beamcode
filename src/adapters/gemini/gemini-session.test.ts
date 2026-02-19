/**
 * Focused tests for GeminiSession branch coverage.
 *
 * Targets the send/receive flow, SSE consumption, error handling,
 * close behavior, and task ID tracking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { ProcessHandle, ProcessManager } from "../../interfaces/process-manager.js";
import { GeminiLauncher } from "./gemini-launcher.js";
import { GeminiSession } from "./gemini-session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockProcessManager(): ProcessManager {
  return {
    spawn: vi.fn().mockReturnValue({
      pid: 12345,
      exited: new Promise<number | null>(() => {}),
      kill: vi.fn(),
      stdout: null,
      stderr: null,
    } satisfies ProcessHandle),
    isAlive: vi.fn().mockReturnValue(true),
  };
}

function makeSSE(...events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

function sseResponse(body: string, contentType = "text/event-stream"): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

function makeTaskEvent(taskId = "task-1") {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "task",
      id: taskId,
      contextId: "ctx-1",
      status: { state: "submitted", timestamp: "2026-01-01T00:00:00Z" },
    },
  };
}

function makeTextEvent(text = "hello", taskId = "task-1") {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId,
      contextId: "ctx-1",
      status: {
        state: "working",
        message: {
          kind: "message",
          role: "agent",
          parts: [{ kind: "text", text }],
          messageId: "msg-1",
        },
      },
      metadata: { coderAgent: { kind: "text-content" } },
    },
  };
}

function makeInputRequiredEvent(taskId = "task-1") {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId,
      contextId: "ctx-1",
      status: { state: "input-required" },
      final: true,
      metadata: { coderAgent: { kind: "state-change" } },
    },
  };
}

function makeCompletedEvent(taskId = "task-1") {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId,
      contextId: "ctx-1",
      status: { state: "completed" },
      final: true,
      metadata: { coderAgent: { kind: "state-change" } },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — send and receive
// ---------------------------------------------------------------------------

describe("GeminiSession — send and receive", () => {
  let session: GeminiSession;
  let launcher: GeminiLauncher;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    mockFetch = vi.fn();
    session = new GeminiSession({
      sessionId: "test",
      baseUrl: "http://localhost:9999",
      launcher,
      fetchFn: mockFetch as typeof fetch,
    });
  });

  afterEach(async () => {
    await session.close();
  });

  it("sends user_message and receives streamed events", async () => {
    const sse = makeSSE(makeTaskEvent(), makeTextEvent("world"), makeInputRequiredEvent());
    mockFetch.mockResolvedValueOnce(sseResponse(sse));

    const iter = session.messages[Symbol.asyncIterator]();

    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    // 1. session_init (task submitted)
    const r1 = await iter.next();
    expect(r1.value.type).toBe("session_init");
    expect(r1.value.metadata.task_id).toBe("task-1");

    // 2. stream_event (text content)
    const r2 = await iter.next();
    expect(r2.value.type).toBe("stream_event");
    expect(r2.value.metadata.delta).toBe("world");

    // 3. result (input-required)
    const r3 = await iter.next();
    expect(r3.value.type).toBe("result");
    expect(r3.value.metadata.status).toBe("input-required");

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:9999");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.method).toBe("message/stream");
  });

  it("handles HTTP error response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }),
    );

    const iter = session.messages[Symbol.asyncIterator]();

    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    const result = await iter.next();
    expect(result.value.type).toBe("result");
    expect(result.value.metadata.is_error).toBe(true);
    expect(result.value.metadata.error).toContain("500");
  });

  it("handles fetch network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const iter = session.messages[Symbol.asyncIterator]();

    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    const result = await iter.next();
    expect(result.value.type).toBe("result");
    expect(result.value.metadata.is_error).toBe(true);
    expect(result.value.metadata.error).toBe("Network error");
  });

  it("handles response with no body", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const iter = session.messages[Symbol.asyncIterator]();

    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    const result = await iter.next();
    expect(result.value.type).toBe("result");
    expect(result.value.metadata.is_error).toBe(true);
    expect(result.value.metadata.error).toContain("No response body");
  });
});

// ---------------------------------------------------------------------------
// Tests — permission flow
// ---------------------------------------------------------------------------

describe("GeminiSession — permission flow", () => {
  it("sends tool confirmation as message_stream_resume with taskId", async () => {
    const launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    const mockFetch = vi.fn();
    const session = new GeminiSession({
      sessionId: "test",
      baseUrl: "http://localhost:9999",
      launcher,
      fetchFn: mockFetch as typeof fetch,
    });

    // First call: initial message
    const sse1 = makeSSE(makeTaskEvent(), makeInputRequiredEvent());
    mockFetch.mockResolvedValueOnce(sseResponse(sse1));

    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    const iter = session.messages[Symbol.asyncIterator]();
    await iter.next(); // session_init
    await iter.next(); // result

    // Second call: tool confirmation
    const sse2 = makeSSE(makeTextEvent("confirmed"), makeCompletedEvent());
    mockFetch.mockResolvedValueOnce(sseResponse(sse2));

    session.send(
      createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: {
          behavior: "allow",
          tool_call_id: "tc-1",
          task_id: "task-1",
        },
      }),
    );

    const r1 = await iter.next();
    expect(r1.value.type).toBe("stream_event");

    // Verify the second fetch call includes taskId
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body2.params.id).toBe("task-1");

    await session.close();
  });
});

// ---------------------------------------------------------------------------
// Tests — cancel
// ---------------------------------------------------------------------------

describe("GeminiSession — cancel", () => {
  it("sends tasks/cancel when interrupt is received", async () => {
    const launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    const mockFetch = vi.fn();
    const session = new GeminiSession({
      sessionId: "test",
      baseUrl: "http://localhost:9999",
      launcher,
      fetchFn: mockFetch as typeof fetch,
    });

    // Set up initial task to get a task ID
    const sse = makeSSE(makeTaskEvent(), makeInputRequiredEvent());
    mockFetch.mockResolvedValueOnce(sseResponse(sse));

    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    const iter = session.messages[Symbol.asyncIterator]();
    await iter.next(); // session_init
    await iter.next(); // result

    // Cancel
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    session.send(
      createUnifiedMessage({
        type: "interrupt",
        role: "user",
        metadata: { task_id: "task-1" },
      }),
    );

    // Wait for the cancel fetch to be called
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    const cancelBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(cancelBody.method).toBe("tasks/cancel");
    expect(cancelBody.params.id).toBe("task-1");

    await session.close();
  });
});

// ---------------------------------------------------------------------------
// Tests — close behavior
// ---------------------------------------------------------------------------

describe("GeminiSession — close behavior", () => {
  it("terminates message stream on close", async () => {
    const launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    const session = new GeminiSession({
      sessionId: "test",
      baseUrl: "http://localhost:9999",
      launcher,
      fetchFn: vi.fn() as typeof fetch,
    });

    await session.close();

    const iter = session.messages[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it("throws on send after close", async () => {
    const launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    const session = new GeminiSession({
      sessionId: "test",
      baseUrl: "http://localhost:9999",
      launcher,
      fetchFn: vi.fn() as typeof fetch,
    });

    await session.close();

    expect(() =>
      session.send(createUnifiedMessage({ type: "user_message", role: "user" })),
    ).toThrow("Session is closed");
  });

  it("sendRaw throws", () => {
    const launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    const session = new GeminiSession({
      sessionId: "test",
      baseUrl: "http://localhost:9999",
      launcher,
      fetchFn: vi.fn() as typeof fetch,
    });

    expect(() => session.sendRaw("ndjson")).toThrow("does not support raw NDJSON");
  });

  it("double close is safe", async () => {
    const launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    const session = new GeminiSession({
      sessionId: "test",
      baseUrl: "http://localhost:9999",
      launcher,
      fetchFn: vi.fn() as typeof fetch,
    });

    await session.close();
    await session.close(); // Should not throw
  });
});

// ---------------------------------------------------------------------------
// Tests — noop handling
// ---------------------------------------------------------------------------

describe("GeminiSession — noop messages", () => {
  it("silently accepts session_init", () => {
    const launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    const mockFetch = vi.fn();
    const session = new GeminiSession({
      sessionId: "test",
      baseUrl: "http://localhost:9999",
      launcher,
      fetchFn: mockFetch as typeof fetch,
    });

    expect(() =>
      session.send(createUnifiedMessage({ type: "session_init", role: "system" })),
    ).not.toThrow();

    // fetch should not be called for noop
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — baseUrl validation
// ---------------------------------------------------------------------------

describe("GeminiSession — baseUrl validation", () => {
  it("accepts localhost", () => {
    const launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    expect(
      () =>
        new GeminiSession({
          sessionId: "test",
          baseUrl: "http://localhost:9999",
          launcher,
          fetchFn: vi.fn() as typeof fetch,
        }),
    ).not.toThrow();
  });

  it("accepts 127.0.0.1", () => {
    const launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    expect(
      () =>
        new GeminiSession({
          sessionId: "test",
          baseUrl: "http://127.0.0.1:9999",
          launcher,
          fetchFn: vi.fn() as typeof fetch,
        }),
    ).not.toThrow();
  });

  it("rejects non-localhost URLs", () => {
    const launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    expect(
      () =>
        new GeminiSession({
          sessionId: "test",
          baseUrl: "http://evil.example.com:9999",
          launcher,
          fetchFn: vi.fn() as typeof fetch,
        }),
    ).toThrow("baseUrl must point to localhost");
  });
});

// ---------------------------------------------------------------------------
// Tests — content-type validation
// ---------------------------------------------------------------------------

describe("GeminiSession — content-type check", () => {
  it("rejects non-SSE responses with 200 status", async () => {
    const launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    const mockFetch = vi.fn();
    const session = new GeminiSession({
      sessionId: "test",
      baseUrl: "http://localhost:9999",
      launcher,
      fetchFn: mockFetch as typeof fetch,
    });

    mockFetch.mockResolvedValueOnce(sseResponse("<html>Not SSE</html>", "text/html"));

    const iter = session.messages[Symbol.asyncIterator]();

    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    const result = await iter.next();
    expect(result.value.type).toBe("result");
    expect(result.value.metadata.is_error).toBe(true);
    expect(result.value.metadata.error).toContain("text/event-stream");

    await session.close();
  });
});

// ---------------------------------------------------------------------------
// Tests — process exit detection
// ---------------------------------------------------------------------------

describe("GeminiSession — process exit detection", () => {
  it("enqueues error when server exits unexpectedly", async () => {
    const launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    const session = new GeminiSession({
      sessionId: "test",
      baseUrl: "http://localhost:9999",
      launcher,
      fetchFn: vi.fn() as typeof fetch,
    });

    const iter = session.messages[Symbol.asyncIterator]();

    // Simulate server process exiting
    launcher.emit("process:exited", {
      sessionId: "test",
      exitCode: 1,
      uptimeMs: 5000,
    });

    const result = await iter.next();
    expect(result.value.type).toBe("result");
    expect(result.value.metadata.is_error).toBe(true);
    expect(result.value.metadata.error).toContain("exited unexpectedly");
    expect(result.value.metadata.error).toContain("code=1");

    // Stream should be done after process exit
    const end = await iter.next();
    expect(end.done).toBe(true);
  });

  it("ignores exit events for other sessions", async () => {
    const launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    const mockFetch = vi.fn();
    const session = new GeminiSession({
      sessionId: "test",
      baseUrl: "http://localhost:9999",
      launcher,
      fetchFn: mockFetch as typeof fetch,
    });

    // Simulate exit for a DIFFERENT session
    launcher.emit("process:exited", {
      sessionId: "other-session",
      exitCode: 1,
      uptimeMs: 5000,
    });

    // Session should still be operational — verify by sending a message
    const sse = makeSSE(makeTaskEvent(), makeCompletedEvent());
    mockFetch.mockResolvedValueOnce(sseResponse(sse));

    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    const iter = session.messages[Symbol.asyncIterator]();
    const r1 = await iter.next();
    expect(r1.value.type).toBe("session_init");

    await session.close();
  });

  it("does not fire after close", async () => {
    const launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    const session = new GeminiSession({
      sessionId: "test",
      baseUrl: "http://localhost:9999",
      launcher,
      fetchFn: vi.fn() as typeof fetch,
    });

    await session.close();

    // Emit exit after close — should not enqueue anything
    launcher.emit("process:exited", {
      sessionId: "test",
      exitCode: 0,
      uptimeMs: 1000,
    });

    const iter = session.messages[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — unknown coderAgent kind logging
// ---------------------------------------------------------------------------

describe("GeminiSession — unknown event kind logging", () => {
  it("logs debug message for unrecognized coderAgent kind", async () => {
    const launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    const mockFetch = vi.fn();
    const debugFn = vi.fn();
    const session = new GeminiSession({
      sessionId: "test",
      baseUrl: "http://localhost:9999",
      launcher,
      logger: { debug: debugFn, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fetchFn: mockFetch as typeof fetch,
    });

    const unknownKindEvent = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        kind: "status-update",
        taskId: "task-1",
        contextId: "ctx-1",
        status: { state: "working" },
        metadata: { coderAgent: { kind: "future-unknown-kind" } },
      },
    };

    const sse = makeSSE(makeTaskEvent(), unknownKindEvent, makeCompletedEvent());
    mockFetch.mockResolvedValueOnce(sseResponse(sse));

    const iter = session.messages[Symbol.asyncIterator]();

    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    await iter.next(); // session_init
    await iter.next(); // result (completed)

    expect(debugFn).toHaveBeenCalledWith(expect.stringContaining("future-unknown-kind"));

    await session.close();
  });
});
