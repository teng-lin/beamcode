/**
 * AgentSdkSession tests.
 *
 * These tests mock `@anthropic-ai/claude-agent-sdk` to avoid needing the
 * real SDK installed and an API key. The mock query function yields
 * SDKMessages that exercise the session's translate+enqueue pipeline.
 */

import { describe, expect, it, vi } from "vitest";
import { createUnifiedMessage, isUnifiedMessage } from "../../core/types/unified-message.js";
import { AgentSdkSession } from "./agent-sdk-session.js";

// ---------------------------------------------------------------------------
// Mock the Agent SDK
// ---------------------------------------------------------------------------

function createMockQuery(messages: Record<string, unknown>[]) {
  const yielded = [...messages];
  let closed = false;

  const generator: AsyncGenerator<Record<string, unknown>, void> & {
    close: () => void;
    interrupt: () => Promise<void>;
  } = {
    async next() {
      if (closed || yielded.length === 0) {
        return { value: undefined, done: true } as IteratorResult<Record<string, unknown>>;
      }
      const msg = yielded.shift()!;
      return { value: msg, done: false };
    },
    async return() {
      closed = true;
      return { value: undefined, done: true } as IteratorResult<Record<string, unknown>>;
    },
    async throw(err: unknown) {
      closed = true;
      throw err;
    },
    close() {
      closed = true;
    },
    async interrupt() {
      // no-op
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return generator;
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ prompt: _prompt, options: _options }: { prompt: unknown; options?: unknown }) => {
    return createMockQuery([
      {
        type: "system",
        subtype: "init",
        cwd: "/test",
        session_id: "backend-session-1",
        tools: ["Bash"],
        mcp_servers: [],
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        apiKeySource: "user",
        claude_code_version: "1.0.0",
        slash_commands: [],
        skills: [],
        output_style: "concise",
        uuid: "00000000-0000-0000-0000-000000000001",
      },
      {
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Hello from Agent SDK" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000002",
        session_id: "backend-session-1",
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done",
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 1,
        total_cost_usd: 0.001,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "00000000-0000-0000-0000-000000000003",
        session_id: "backend-session-1",
      },
    ]);
  }),
}));

describe("AgentSdkSession", () => {
  describe("create", () => {
    it("creates a session with the given sessionId", async () => {
      const session = await AgentSdkSession.create({
        sessionId: "test-session",
      });

      expect(session.sessionId).toBe("test-session");
      await session.close();
    });

    it("yields translated messages from the SDK stream", async () => {
      const session = await AgentSdkSession.create({
        sessionId: "test-stream",
      });

      const messages: unknown[] = [];
      const iter = session.messages[Symbol.asyncIterator]();

      // Collect messages until stream ends
      for (let i = 0; i < 3; i++) {
        const { value, done } = await iter.next();
        if (done) break;
        messages.push(value);
      }

      expect(messages.length).toBeGreaterThanOrEqual(2);

      // First message should be session_init (from system:init)
      expect(isUnifiedMessage(messages[0])).toBe(true);
      expect((messages[0] as { type: string }).type).toBe("session_init");

      // Second message should be assistant
      expect(isUnifiedMessage(messages[1])).toBe(true);
      expect((messages[1] as { type: string }).type).toBe("assistant");

      await session.close();
    });
  });

  describe("sendRaw", () => {
    it("throws when called", async () => {
      const session = await AgentSdkSession.create({
        sessionId: "test-sendraw",
      });

      expect(() => session.sendRaw('{"type":"test"}')).toThrow(
        "AgentSdkSession does not support raw NDJSON",
      );

      await session.close();
    });
  });

  describe("send", () => {
    it("throws after close", async () => {
      const session = await AgentSdkSession.create({
        sessionId: "test-send-after-close",
      });

      await session.close();

      expect(() =>
        session.send(
          createUnifiedMessage({
            type: "user_message",
            role: "user",
            content: [{ type: "text", text: "test" }],
          }),
        ),
      ).toThrow("Session is closed");
    });
  });

  describe("close", () => {
    it("finishes the message stream", async () => {
      const session = await AgentSdkSession.create({
        sessionId: "test-close-stream",
      });

      await session.close();

      const iter = session.messages[Symbol.asyncIterator]();
      const { done } = await iter.next();
      expect(done).toBe(true);
    });

    it("is idempotent", async () => {
      const session = await AgentSdkSession.create({
        sessionId: "test-close-idempotent",
      });

      await session.close();
      await session.close(); // Should not throw
    });
  });

  describe("backendSessionId", () => {
    it("captures the backend session ID from system:init", async () => {
      const session = await AgentSdkSession.create({
        sessionId: "test-backend-id",
      });

      // Consume at least one message to trigger system:init processing
      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next();

      // Wait a tick for the stream processing to capture the ID
      await new Promise((r) => setTimeout(r, 10));

      expect(session.backendSessionId).toBe("backend-session-1");

      await session.close();
    });
  });
});
