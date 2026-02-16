import { describe, expect, it, vi } from "vitest";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import { AgentSdkAdapter } from "./agent-sdk-adapter.js";
import type { QueryFn } from "./agent-sdk-session.js";
import { AgentSdkSession } from "./agent-sdk-session.js";
import type { SDKMessage } from "./sdk-message-translator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock query function that yields controlled SDK messages. */
function createMockQueryFn(messages: SDKMessage[]): QueryFn {
  return ({ options }) => {
    const captured = { canUseTool: options?.canUseTool as CanUseToolFn | undefined };

    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next(): Promise<IteratorResult<SDKMessage>> {
            if (index < messages.length) {
              return Promise.resolve({ value: messages[index++], done: false });
            }
            return Promise.resolve({ value: undefined as unknown as SDKMessage, done: true });
          },
        };
      },
      _captured: captured,
    } as AsyncIterable<SDKMessage> & { _captured: typeof captured };
  };
}

type CanUseToolFn = (toolName: string, input: Record<string, unknown>) => Promise<unknown>;

/** Create a query function that captures canUseTool and supports permission testing. */
function createPermissionQueryFn(): {
  queryFn: QueryFn;
  getCanUseTool: () => CanUseToolFn | undefined;
  messages: SDKMessage[];
  complete: () => void;
} {
  let canUseTool: CanUseToolFn | undefined;
  let resolveComplete: () => void;
  const completePromise = new Promise<void>((r) => {
    resolveComplete = r;
  });
  const messages: SDKMessage[] = [];

  const queryFn: QueryFn = ({ options }) => {
    canUseTool = options?.canUseTool as CanUseToolFn | undefined;

    return {
      async *[Symbol.asyncIterator]() {
        for (const msg of messages) {
          yield msg;
        }
        await completePromise;
      },
    };
  };

  return {
    queryFn,
    getCanUseTool: () => canUseTool,
    messages,
    complete: () => resolveComplete!(),
  };
}

/** Create a query function that respects abort signal. */
function createAbortableQueryFn(): {
  queryFn: QueryFn;
  aborted: { value: boolean };
} {
  const aborted = { value: false };

  const queryFn: QueryFn = ({ options }) => {
    const signal = options?.abortSignal as AbortSignal | undefined;

    return {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            aborted.value = true;
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => {
            aborted.value = true;
            resolve();
          });
        });
      },
    };
  };

  return { queryFn, aborted };
}

// ---------------------------------------------------------------------------
// AgentSdkAdapter tests
// ---------------------------------------------------------------------------

describe("AgentSdkAdapter", () => {
  it("has correct name and capabilities", () => {
    const adapter = new AgentSdkAdapter();
    expect(adapter.name).toBe("agent-sdk");
    expect(adapter.capabilities).toEqual({
      streaming: true,
      permissions: true,
      slashCommands: false,
      availability: "local",
    });
  });

  it("connect without queryFn throws", async () => {
    const adapter = new AgentSdkAdapter();
    await expect(adapter.connect({ sessionId: "test" })).rejects.toThrow("queryFn is required");
  });

  it("connect returns session with correct sessionId", async () => {
    const queryFn = createMockQueryFn([]);
    const adapter = new AgentSdkAdapter(queryFn);

    const session = await adapter.connect({ sessionId: "sess-123" });
    expect(session.sessionId).toBe("sess-123");
    await session.close();
  });

  it("connect accepts queryFn via adapterOptions", async () => {
    const queryFn = createMockQueryFn([]);
    const adapter = new AgentSdkAdapter();

    const session = await adapter.connect({
      sessionId: "opts-session",
      adapterOptions: { queryFn },
    });
    expect(session.sessionId).toBe("opts-session");
    await session.close();
  });
});

// ---------------------------------------------------------------------------
// AgentSdkSession tests
// ---------------------------------------------------------------------------

describe("AgentSdkSession", () => {
  describe("send user_message", () => {
    it("starts query and yields translated SDK messages", async () => {
      const sdkMessages: SDKMessage[] = [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello!" }],
          },
        },
        {
          type: "result",
          subtype: "success",
          result: "Done",
        },
      ];

      const queryFn = createMockQueryFn(sdkMessages);
      const session = new AgentSdkSession("test-session", queryFn);

      const userMsg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "Hi" }],
      });

      session.send(userMsg);

      const iter = session.messages[Symbol.asyncIterator]();

      const r1 = await iter.next();
      expect(r1.done).toBe(false);
      expect(r1.value.type).toBe("assistant");
      expect(r1.value.content[0]).toEqual({ type: "text", text: "Hello!" });

      const r2 = await iter.next();
      expect(r2.done).toBe(false);
      expect(r2.value.type).toBe("result");
      expect(r2.value.metadata.result).toBe("Done");

      await session.close();
    });
  });

  describe("permission round-trip", () => {
    it("canUseTool → permission_request emitted → permission_response → resolved with allow", async () => {
      const { queryFn, getCanUseTool, complete } = createPermissionQueryFn();
      const session = new AgentSdkSession("perm-session", queryFn);

      // Start the query
      session.send(
        createUnifiedMessage({
          type: "user_message",
          role: "user",
          content: [{ type: "text", text: "do something" }],
        }),
      );

      // Wait for query to start
      await vi.waitFor(() => expect(getCanUseTool()).toBeDefined());

      // Trigger a tool permission request
      const canUseToolPromise = getCanUseTool()!("Bash", { command: "ls" });

      // Read the permission_request from the session's message stream
      const iter = session.messages[Symbol.asyncIterator]();
      const { value: permReq } = await iter.next();

      expect(permReq.type).toBe("permission_request");
      expect(permReq.metadata.toolName).toBe("Bash");
      expect(permReq.metadata.input).toEqual({ command: "ls" });

      // Respond with allow
      session.send(
        createUnifiedMessage({
          type: "permission_response",
          role: "user",
          metadata: {
            requestId: permReq.metadata.requestId,
            behavior: "allow",
          },
        }),
      );

      const decision = await canUseToolPromise;
      expect((decision as { behavior: string }).behavior).toBe("allow");

      complete();
      await session.close();
    });

    it("permission deny flow", async () => {
      const { queryFn, getCanUseTool, complete } = createPermissionQueryFn();
      const session = new AgentSdkSession("deny-session", queryFn);

      session.send(
        createUnifiedMessage({
          type: "user_message",
          role: "user",
          content: [{ type: "text", text: "do something" }],
        }),
      );

      await vi.waitFor(() => expect(getCanUseTool()).toBeDefined());

      const canUseToolPromise = getCanUseTool()!("Bash", { command: "rm -rf /" });

      const iter = session.messages[Symbol.asyncIterator]();
      const { value: permReq } = await iter.next();

      session.send(
        createUnifiedMessage({
          type: "permission_response",
          role: "user",
          metadata: {
            requestId: permReq.metadata.requestId,
            behavior: "deny",
          },
        }),
      );

      const decision = await canUseToolPromise;
      expect((decision as { behavior: string }).behavior).toBe("deny");
      expect((decision as { message: string }).message).toBe("User denied permission");

      complete();
      await session.close();
    });

    it("multiple concurrent permissions", async () => {
      const { queryFn, getCanUseTool, complete } = createPermissionQueryFn();
      const session = new AgentSdkSession("multi-perm-session", queryFn);

      session.send(
        createUnifiedMessage({
          type: "user_message",
          role: "user",
          content: [{ type: "text", text: "go" }],
        }),
      );

      await vi.waitFor(() => expect(getCanUseTool()).toBeDefined());

      const p1 = getCanUseTool()!("Bash", { command: "ls" });
      const p2 = getCanUseTool()!("Read", { path: "/tmp" });

      const iter = session.messages[Symbol.asyncIterator]();
      const { value: req1 } = await iter.next();
      const { value: req2 } = await iter.next();

      // Respond in reverse order
      session.send(
        createUnifiedMessage({
          type: "permission_response",
          role: "user",
          metadata: { requestId: req2.metadata.requestId, behavior: "allow" },
        }),
      );
      session.send(
        createUnifiedMessage({
          type: "permission_response",
          role: "user",
          metadata: { requestId: req1.metadata.requestId, behavior: "deny" },
        }),
      );

      const [d1, d2] = await Promise.all([p1, p2]);
      expect((d1 as { behavior: string }).behavior).toBe("deny");
      expect((d2 as { behavior: string }).behavior).toBe("allow");

      complete();
      await session.close();
    });
  });

  describe("interrupt", () => {
    it("aborts the query", async () => {
      const { queryFn, aborted } = createAbortableQueryFn();
      const session = new AgentSdkSession("abort-session", queryFn);

      session.send(
        createUnifiedMessage({
          type: "user_message",
          role: "user",
          content: [{ type: "text", text: "long task" }],
        }),
      );

      // Give the query time to start
      await vi.waitFor(() => expect(aborted.value).toBe(false));

      session.send(
        createUnifiedMessage({
          type: "interrupt",
          role: "user",
        }),
      );

      await vi.waitFor(() => expect(aborted.value).toBe(true));

      await session.close();
    });
  });

  describe("close", () => {
    it("terminates message stream", async () => {
      const queryFn = createMockQueryFn([]);
      const session = new AgentSdkSession("close-session", queryFn);

      await session.close();

      const iter = session.messages[Symbol.asyncIterator]();
      const { done } = await iter.next();
      expect(done).toBe(true);
    });

    it("rejects pending permissions", async () => {
      const { queryFn, getCanUseTool } = createPermissionQueryFn();
      const session = new AgentSdkSession("close-perm-session", queryFn);

      session.send(
        createUnifiedMessage({
          type: "user_message",
          role: "user",
          content: [{ type: "text", text: "go" }],
        }),
      );

      await vi.waitFor(() => expect(getCanUseTool()).toBeDefined());

      const permPromise = getCanUseTool()!("Bash", { command: "ls" });

      // Drain the permission_request from the message stream
      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next();

      await session.close();

      const decision = await permPromise;
      expect((decision as { behavior: string }).behavior).toBe("deny");
      expect((decision as { message: string }).message).toBe("Session closed");
    });

    it("throws on send after close", async () => {
      const queryFn = vi.fn(createMockQueryFn([]));
      const session = new AgentSdkSession("noop-session", queryFn);

      await session.close();

      expect(() =>
        session.send(
          createUnifiedMessage({
            type: "user_message",
            role: "user",
            content: [{ type: "text", text: "ignored" }],
          }),
        ),
      ).toThrow("Session is closed");
    });

    it("is idempotent", async () => {
      const queryFn = createMockQueryFn([]);
      const session = new AgentSdkSession("idempotent-session", queryFn);

      await session.close();
      await session.close(); // second close should not throw
    });
  });
});
