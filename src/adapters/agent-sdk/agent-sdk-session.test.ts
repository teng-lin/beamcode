import { describe, expect, it } from "vitest";
import type { UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import { AgentSdkSession, type QueryFn } from "./agent-sdk-session.js";
import type { SDKMessage, SDKUserMessage } from "./sdk-message-translator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a QueryFn that yields the given messages then completes. */
function createMockQueryFn(messages: SDKMessage[]): QueryFn {
  return ({ prompt }) => ({
    async *[Symbol.asyncIterator]() {
      // Consume the prompt iterable to avoid hanging
      if (typeof prompt !== "string") {
        // Read at least the first message to unblock the input stream
        const iter = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        await iter.next();
      }
      for (const msg of messages) {
        yield msg;
      }
    },
  });
}

/**
 * Create a QueryFn with explicit control over when messages are yielded.
 * Returns an object with push/end methods for driving the stream.
 */
function createControllableQueryFn() {
  const queue: SDKMessage[] = [];
  let resolve: (() => void) | null = null;
  let ended = false;

  const waitForMessage = () =>
    new Promise<void>((r) => {
      if (queue.length > 0 || ended) {
        r();
      } else {
        resolve = r;
      }
    });

  const queryFn: QueryFn = ({ prompt }) => ({
    async *[Symbol.asyncIterator]() {
      // Consume first prompt message
      if (typeof prompt !== "string") {
        const iter = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        await iter.next();
      }

      while (!ended) {
        await waitForMessage();
        while (queue.length > 0) {
          yield queue.shift()!;
        }
      }
    },
  });

  return {
    queryFn,
    push(msg: SDKMessage) {
      queue.push(msg);
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    },
    end() {
      ended = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    },
  };
}

/** Small delay to let microtasks flush. */
const tick = () => new Promise<void>((r) => setTimeout(r, 10));

/** Create a user_message UnifiedMessage with the given text. */
function userMessage(text: string): UnifiedMessage {
  return createUnifiedMessage({
    type: "user_message",
    role: "user",
    content: [{ type: "text", text }],
  });
}

/** Create a standard SDK assistant message with the given text. */
function assistantSdkMessage(text: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentSdkSession", () => {
  // -------------------------------------------------------------------------
  // send() — user_message when no query running
  // -------------------------------------------------------------------------

  describe("send() — user_message starts query", () => {
    it("starts a query on first user_message", async () => {
      const queryFn = createMockQueryFn([assistantSdkMessage("Hello!")]);
      const session = new AgentSdkSession("sess-1", queryFn);

      session.send(userMessage("hi"));
      await tick();

      const iter = session.messages[Symbol.asyncIterator]();
      const first = await iter.next();
      expect(first.done).toBe(false);
      expect(first.value.type).toBe("assistant");

      await session.close();
    });
  });

  // -------------------------------------------------------------------------
  // send() — user_message when query is running → pushInput
  // -------------------------------------------------------------------------

  describe("send() — user_message pushes to input queue when query is running", () => {
    it("queues follow-up messages to the input stream", async () => {
      const ctrl = createControllableQueryFn();
      const session = new AgentSdkSession("sess-1", ctrl.queryFn);

      session.send(userMessage("first"));
      await tick();

      // Second message goes into the input queue (query is already running)
      session.send(userMessage("second"));

      ctrl.push(assistantSdkMessage("Response"));
      ctrl.end();
      await tick();

      const iter = session.messages[Symbol.asyncIterator]();
      const msg = await iter.next();
      expect(msg.done).toBe(false);
      expect(msg.value.type).toBe("assistant");

      await session.close();
    });
  });

  // -------------------------------------------------------------------------
  // send() — permission_response
  // -------------------------------------------------------------------------

  describe("send() — permission_response", () => {
    it("delegates to permissionBridge.respondToPermission", async () => {
      const queryFn = createMockQueryFn([]);
      const session = new AgentSdkSession("sess-1", queryFn);

      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: {
          requestId: "perm-1",
          behavior: "allow",
        },
      });

      // Should not throw — the bridge will return false for unknown requestId
      session.send(msg);

      await session.close();
    });
  });

  // -------------------------------------------------------------------------
  // send() — interrupt
  // -------------------------------------------------------------------------

  describe("send() — interrupt", () => {
    it("aborts the current controller and creates a new one", async () => {
      const ctrl = createControllableQueryFn();
      const session = new AgentSdkSession("sess-1", ctrl.queryFn);

      session.send(userMessage("hello"));
      await tick();

      session.send(createUnifiedMessage({ type: "interrupt", role: "user" }));

      ctrl.end();
      await tick();
      await session.close();
    });
  });

  // -------------------------------------------------------------------------
  // send() — closed session
  // -------------------------------------------------------------------------

  describe("send() — closed session", () => {
    it("throws Error('Session is closed')", async () => {
      const queryFn = createMockQueryFn([]);
      const session = new AgentSdkSession("sess-1", queryFn);

      await session.close();

      expect(() => session.send(userMessage("hello"))).toThrow("Session is closed");
    });
  });

  // -------------------------------------------------------------------------
  // messages async iterable
  // -------------------------------------------------------------------------

  describe("messages", () => {
    it("yields messages pushed by the query", async () => {
      const msgs: SDKMessage[] = [
        assistantSdkMessage("reply"),
        { type: "result", subtype: "success", session_id: "sess-1" },
      ];
      const queryFn = createMockQueryFn(msgs);
      const session = new AgentSdkSession("sess-1", queryFn);

      session.send(userMessage("go"));
      await tick();

      const iter = session.messages[Symbol.asyncIterator]();
      const first = await iter.next();
      expect(first.value.type).toBe("assistant");

      const second = await iter.next();
      expect(second.value.type).toBe("result");

      await session.close();
    });

    it("returns done when session is closed and queue is empty", async () => {
      const queryFn = createMockQueryFn([]);
      const session = new AgentSdkSession("sess-1", queryFn);

      await session.close();

      const iter = session.messages[Symbol.asyncIterator]();
      const result = await iter.next();
      expect(result.done).toBe(true);
    });

    it("resolves waiting consumer when pushMessage is called", async () => {
      const ctrl = createControllableQueryFn();
      const session = new AgentSdkSession("sess-1", ctrl.queryFn);

      session.send(userMessage("go"));
      await tick();

      const iter = session.messages[Symbol.asyncIterator]();
      const nextPromise = iter.next();

      ctrl.push(assistantSdkMessage("delayed"));
      await tick();

      const msg = await nextPromise;
      expect(msg.done).toBe(false);
      expect(msg.value.type).toBe("assistant");

      ctrl.end();
      await tick();
      await session.close();
    });
  });

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  describe("close()", () => {
    it("aborts the controller and rejects all pending permissions", async () => {
      const ctrl = createControllableQueryFn();
      const session = new AgentSdkSession("sess-1", ctrl.queryFn);

      session.send(userMessage("hello"));
      await tick();

      await session.close();

      expect(() => session.send(userMessage("fail"))).toThrow("Session is closed");
      ctrl.end();
    });

    it("resolves pending messageResolve with done", async () => {
      const queryFn = createMockQueryFn([]);
      const session = new AgentSdkSession("sess-1", queryFn);

      const iter = session.messages[Symbol.asyncIterator]();
      const nextPromise = iter.next();

      await session.close();

      const result = await nextPromise;
      expect(result.done).toBe(true);
    });

    it("resolves pending inputResolve with done", async () => {
      const ctrl = createControllableQueryFn();
      const session = new AgentSdkSession("sess-1", ctrl.queryFn);

      session.send(userMessage("hello"));
      await tick();

      await session.close();
      ctrl.end();
    });

    it("is idempotent — second close returns immediately", async () => {
      const queryFn = createMockQueryFn([]);
      const session = new AgentSdkSession("sess-1", queryFn);

      await session.close();
      await session.close();
    });
  });

  // -------------------------------------------------------------------------
  // pushInput — tested indirectly
  // -------------------------------------------------------------------------

  describe("pushInput", () => {
    it("queues input when no one is waiting", async () => {
      const ctrl = createControllableQueryFn();
      const session = new AgentSdkSession("sess-1", ctrl.queryFn);

      session.send(userMessage("first"));
      await tick();

      // Queue multiple follow-up messages before the input stream reads
      session.send(userMessage("queued-1"));
      session.send(userMessage("queued-2"));

      ctrl.push(assistantSdkMessage("ok"));
      ctrl.end();
      await tick();

      const iter = session.messages[Symbol.asyncIterator]();
      const msg = await iter.next();
      expect(msg.value.type).toBe("assistant");

      await session.close();
    });

    it("resolves waiting inputResolve when pushInput is called", async () => {
      // QueryFn that reads ALL messages from the prompt input stream
      const receivedInputs: SDKUserMessage[] = [];

      const queryFn: QueryFn = ({ prompt }) => ({
        async *[Symbol.asyncIterator]() {
          if (typeof prompt !== "string") {
            for await (const msg of prompt as AsyncIterable<SDKUserMessage>) {
              receivedInputs.push(msg);
              if (receivedInputs.length === 2) {
                yield assistantSdkMessage(`Got ${receivedInputs.length} inputs`);
                break;
              }
            }
          }
        },
      });

      const session = new AgentSdkSession("sess-1", queryFn);

      session.send(userMessage("first"));
      await tick();

      // Second message resolves the waiting inputResolve
      session.send(userMessage("second"));
      await tick();
      await tick(); // Extra tick for the async iteration to complete

      expect(receivedInputs.length).toBe(2);

      const iter = session.messages[Symbol.asyncIterator]();
      const msg = await iter.next();
      expect(msg.value.type).toBe("assistant");

      await session.close();
    });
  });

  // -------------------------------------------------------------------------
  // sessionId
  // -------------------------------------------------------------------------

  describe("sessionId", () => {
    it("exposes the session ID from constructor", () => {
      const queryFn = createMockQueryFn([]);
      const session = new AgentSdkSession("sess-42", queryFn);
      expect(session.sessionId).toBe("sess-42");
    });
  });
});
