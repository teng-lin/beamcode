/**
 * Tests for OpencodeSession.
 *
 * Uses mock OpencodeHttpClient and a mock subscribe function
 * to verify the full BackendSession contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { OpencodeHttpClient } from "./opencode-http-client.js";
import { OpencodeSession } from "./opencode-session.js";
import type { OpencodeEvent } from "./opencode-types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockHttpClient() {
  return {
    promptAsync: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    replyPermission: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn(),
    health: vi.fn(),
    connectSse: vi.fn(),
  } as unknown as OpencodeHttpClient & {
    promptAsync: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    replyPermission: ReturnType<typeof vi.fn>;
  };
}

/**
 * Create a mock subscribe function.
 * Returns an object with:
 *   - `subscribe`: the function to pass to OpencodeSession
 *   - `push`: call this to simulate an SSE event arriving
 *   - `unsubscribe`: spy to verify unsubscribe was called
 */
function createMockSubscribe() {
  let handler: ((event: OpencodeEvent) => void) | null = null;
  const unsubscribe = vi.fn();

  const subscribe = (h: (event: OpencodeEvent) => void) => {
    handler = h;
    return unsubscribe;
  };

  const push = (event: OpencodeEvent) => {
    if (handler) handler(event);
  };

  return { subscribe, push, unsubscribe };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("OpencodeSession", () => {
  let httpClient: ReturnType<typeof createMockHttpClient>;
  let sub: ReturnType<typeof createMockSubscribe>;
  let session: OpencodeSession;

  beforeEach(() => {
    httpClient = createMockHttpClient();
    sub = createMockSubscribe();
    session = new OpencodeSession({
      sessionId: "beamcode-session-1",
      opcSessionId: "opc-session-abc",
      httpClient,
      subscribe: sub.subscribe,
    });
  });

  afterEach(async () => {
    await session.close();
  });

  // -------------------------------------------------------------------------
  // sessionId property
  // -------------------------------------------------------------------------

  it("sessionId returns the BeamCode session ID", () => {
    expect(session.sessionId).toBe("beamcode-session-1");
  });

  // -------------------------------------------------------------------------
  // send() — user_message -> prompt
  // -------------------------------------------------------------------------

  it("send() with user_message calls httpClient.promptAsync with correct args", () => {
    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "Hello opencode" }],
      }),
    );

    expect(httpClient.promptAsync).toHaveBeenCalledOnce();
    expect(httpClient.promptAsync).toHaveBeenCalledWith("opc-session-abc", {
      parts: [{ type: "text", text: "Hello opencode" }],
      model: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // send() — permission_response -> replyPermission
  // -------------------------------------------------------------------------

  it("send() with permission_response calls httpClient.replyPermission", () => {
    session.send(
      createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { request_id: "perm-42", behavior: "allow" },
      }),
    );

    expect(httpClient.replyPermission).toHaveBeenCalledOnce();
    expect(httpClient.replyPermission).toHaveBeenCalledWith("perm-42", {
      reply: "once",
    });
  });

  // -------------------------------------------------------------------------
  // send() — interrupt -> abort
  // -------------------------------------------------------------------------

  it("send() with interrupt calls httpClient.abort", () => {
    session.send(createUnifiedMessage({ type: "interrupt", role: "user" }));

    expect(httpClient.abort).toHaveBeenCalledOnce();
    expect(httpClient.abort).toHaveBeenCalledWith("opc-session-abc");
  });

  // -------------------------------------------------------------------------
  // send() throws after close
  // -------------------------------------------------------------------------

  it("send() throws after close()", async () => {
    await session.close();

    expect(() =>
      session.send(createUnifiedMessage({ type: "user_message", role: "user" })),
    ).toThrow("Session is closed");
  });

  // -------------------------------------------------------------------------
  // sendRaw() always throws
  // -------------------------------------------------------------------------

  it("sendRaw() always throws", () => {
    expect(() => session.sendRaw("some ndjson")).toThrow(
      "opencode adapter does not support raw NDJSON",
    );
  });

  // -------------------------------------------------------------------------
  // messages — yields translated SSE events
  // -------------------------------------------------------------------------

  it("messages yields translated SSE events pushed via subscribe handler", async () => {
    const iter = session.messages[Symbol.asyncIterator]();

    sub.push({
      type: "session.status",
      properties: {
        sessionID: "opc-session-abc",
        status: { type: "idle" },
      },
    });

    const result = await iter.next();
    expect(result.done).toBe(false);
    expect(result.value.type).toBe("result");
    expect(result.value.metadata.status).toBe("completed");
  });

  // -------------------------------------------------------------------------
  // messages — filters null events (heartbeats etc.)
  // -------------------------------------------------------------------------

  it("messages only yields events where translateEvent returns non-null", async () => {
    const iter = session.messages[Symbol.asyncIterator]();

    // Push a heartbeat (returns null from translateEvent)
    sub.push({
      type: "server.heartbeat",
      properties: {} as Record<string, never>,
    });

    // Push a real event after the heartbeat
    sub.push({
      type: "server.connected",
      properties: {} as Record<string, never>,
    });

    const result = await iter.next();
    expect(result.done).toBe(false);
    // Should be the server.connected event, not the heartbeat
    expect(result.value.type).toBe("session_init");
  });

  // -------------------------------------------------------------------------
  // close() causes messages iterator to terminate
  // -------------------------------------------------------------------------

  it("close() causes messages iterator to terminate (done: true)", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const nextPromise = iter.next();

    await session.close();

    const result = await nextPromise;
    expect(result.done).toBe(true);
  });

  // -------------------------------------------------------------------------
  // close() calls unsubscribe
  // -------------------------------------------------------------------------

  it("close() calls the unsubscribe function", async () => {
    await session.close();

    expect(sub.unsubscribe).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Multiple messages queued and yielded in order
  // -------------------------------------------------------------------------

  it("multiple messages are queued and yielded in order", async () => {
    // Push three events before consuming any
    sub.push({
      type: "server.connected",
      properties: {} as Record<string, never>,
    });

    sub.push({
      type: "session.status",
      properties: {
        sessionID: "opc-session-abc",
        status: { type: "busy" },
      },
    });

    sub.push({
      type: "session.status",
      properties: {
        sessionID: "opc-session-abc",
        status: { type: "idle" },
      },
    });

    const iter = session.messages[Symbol.asyncIterator]();

    const r1 = await iter.next();
    expect(r1.value.type).toBe("session_init");

    const r2 = await iter.next();
    expect(r2.value.type).toBe("status_change");
    expect(r2.value.metadata.busy).toBe(true);

    const r3 = await iter.next();
    expect(r3.value.type).toBe("result");
    expect(r3.value.metadata.status).toBe("completed");
  });

  // -------------------------------------------------------------------------
  // close() is idempotent
  // -------------------------------------------------------------------------

  it("close() is idempotent — second call is a no-op", async () => {
    await session.close();
    await session.close();

    expect(sub.unsubscribe).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Stream event (text delta) flows through
  // -------------------------------------------------------------------------

  it("messages yields stream_event for text part updates", async () => {
    const iter = session.messages[Symbol.asyncIterator]();

    sub.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          id: "p-1",
          messageID: "m-1",
          sessionID: "opc-session-abc",
          text: "Hello",
          time: { created: 0, updated: 0 },
        },
        delta: "Hello",
      },
    });

    const result = await iter.next();
    expect(result.done).toBe(false);
    expect(result.value.type).toBe("stream_event");
    expect(result.value.metadata.delta).toBe("Hello");
  });

  // -------------------------------------------------------------------------
  // Permission event flows through
  // -------------------------------------------------------------------------

  it("messages yields permission_request for permission.updated events", async () => {
    const iter = session.messages[Symbol.asyncIterator]();

    sub.push({
      type: "permission.updated",
      properties: {
        id: "perm-99",
        sessionID: "opc-session-abc",
        permission: "file_edit",
        title: "Edit file.txt",
      },
    });

    const result = await iter.next();
    expect(result.done).toBe(false);
    expect(result.value.type).toBe("permission_request");
    expect(result.value.metadata.request_id).toBe("perm-99");
    expect(result.value.metadata.permission).toBe("file_edit");
  });

  // -------------------------------------------------------------------------
  // Non-user-facing events are filtered
  // -------------------------------------------------------------------------

  it("session.created events are filtered out (non-user-facing)", async () => {
    const iter = session.messages[Symbol.asyncIterator]();

    // Push a session.created (returns null from translateEvent)
    sub.push({
      type: "session.created",
      properties: {
        session: {
          id: "opc-session-abc",
          slug: "test",
          projectID: "proj-1",
          directory: "/tmp",
          title: "Test",
          version: "1",
          time: { created: 0, updated: 0 },
        },
      },
    });

    // Push a real event to verify the above was skipped
    sub.push({
      type: "server.connected",
      properties: {} as Record<string, never>,
    });

    const result = await iter.next();
    expect(result.value.type).toBe("session_init");
  });

  // -------------------------------------------------------------------------
  // Messages arriving after close are ignored
  // -------------------------------------------------------------------------

  it("events arriving after close do not enqueue messages", async () => {
    await session.close();

    // Simulate event arriving after close (should be no-op since unsubscribed)
    // But if the handler were somehow still called, finish() has already run
    const iter = session.messages[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  // -------------------------------------------------------------------------
  // send() surfaces HTTP errors as error messages in the queue
  // -------------------------------------------------------------------------

  it("send() surfaces HTTP errors as error messages in the queue", async () => {
    httpClient.promptAsync.mockRejectedValueOnce(new Error("Network failure"));

    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "will fail" }],
      }),
    );

    // Wait for the rejected promise to be caught
    await new Promise((r) => setTimeout(r, 10));

    const iter = session.messages[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(false);
    expect(result.value.type).toBe("result");
    expect(result.value.metadata.is_error).toBe(true);
    expect(result.value.metadata.error_message).toBe("Network failure");
  });

  // -------------------------------------------------------------------------
  // send() with session_init is a no-op (no HTTP call)
  // -------------------------------------------------------------------------

  it("send() with session_init does not call any HTTP method", () => {
    session.send(
      createUnifiedMessage({
        type: "session_init",
        role: "system",
        metadata: {},
      }),
    );

    expect(httpClient.promptAsync).not.toHaveBeenCalled();
    expect(httpClient.abort).not.toHaveBeenCalled();
    expect(httpClient.replyPermission).not.toHaveBeenCalled();
  });
});
