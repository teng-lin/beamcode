import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSession, JsonRpcResponse } from "./codex-session.js";
import { CodexSlashExecutor } from "./codex-slash-executor.js";

function mockRpcResponse(result: unknown = {}): JsonRpcResponse {
  return { jsonrpc: "2.0", id: 1, result };
}

function mockRpcError(code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: 1, error: { code, message } };
}

function createMockSession(overrides?: Partial<CodexSession>): CodexSession {
  return {
    currentThreadId: "thread-123",
    requestRpc: vi.fn().mockResolvedValue(mockRpcResponse()),
    resetThread: vi.fn().mockResolvedValue("thread-456"),
    ...overrides,
  } as unknown as CodexSession;
}

describe("CodexSlashExecutor", () => {
  let session: CodexSession;
  let executor: CodexSlashExecutor;

  beforeEach(() => {
    session = createMockSession();
    executor = new CodexSlashExecutor(session);
  });

  describe("handles()", () => {
    it("returns true for supported commands", () => {
      expect(executor.handles("/compact")).toBe(true);
      expect(executor.handles("/new")).toBe(true);
      expect(executor.handles("/review")).toBe(true);
      expect(executor.handles("/rename my thread")).toBe(true);
    });

    it("returns false for unsupported commands", () => {
      expect(executor.handles("/help")).toBe(false);
      expect(executor.handles("/model")).toBe(false);
      expect(executor.handles("/diff")).toBe(false);
      expect(executor.handles("/unknown")).toBe(false);
    });
  });

  describe("supportedCommands()", () => {
    it("returns all supported command names", () => {
      const cmds = executor.supportedCommands();
      expect(cmds).toContain("/compact");
      expect(cmds).toContain("/new");
      expect(cmds).toContain("/review");
      expect(cmds).toContain("/rename");
      expect(cmds).toHaveLength(4);
    });
  });

  describe("execute()", () => {
    it("returns null for unsupported commands", async () => {
      const result = await executor.execute("/unknown");
      expect(result).toBeNull();
    });

    describe("/compact", () => {
      it("calls thread/compact/start with threadId and 60s timeout", async () => {
        const result = await executor.execute("/compact");

        expect(session.requestRpc).toHaveBeenCalledWith(
          "thread/compact/start",
          { threadId: "thread-123" },
          60_000,
        );
        expect(result).not.toBeNull();
        expect(result!.source).toBe("emulated");
        expect(result!.content).toBe("Compaction started.");
      });

      it("throws when no active thread", async () => {
        session = createMockSession({ currentThreadId: null } as Partial<CodexSession>);
        executor = new CodexSlashExecutor(session);

        await expect(executor.execute("/compact")).rejects.toThrow("No active thread");
      });

      it("returns error content when RPC returns error", async () => {
        vi.mocked(session.requestRpc).mockResolvedValue(
          mockRpcError(-32000, "Thread too small to compact"),
        );

        const result = await executor.execute("/compact");
        expect(result!.content).toBe("Error: Thread too small to compact");
      });
    });

    describe("/new", () => {
      it("calls resetThread() and returns new thread ID", async () => {
        const result = await executor.execute("/new");

        expect(session.resetThread).toHaveBeenCalled();
        expect(result).not.toBeNull();
        expect(result!.content).toContain("thread-456");
        expect(result!.source).toBe("emulated");
      });
    });

    describe("/review", () => {
      it("calls review/start with threadId", async () => {
        const result = await executor.execute("/review");

        expect(session.requestRpc).toHaveBeenCalledWith("review/start", { threadId: "thread-123" });
        expect(result!.content).toBe("Review started.");
      });
    });

    describe("/rename", () => {
      it("calls thread/name/set with threadId and name", async () => {
        const result = await executor.execute("/rename My Project");

        expect(session.requestRpc).toHaveBeenCalledWith("thread/name/set", {
          threadId: "thread-123",
          name: "My Project",
        });
        expect(result!.content).toBe("Thread renamed to: My Project");
      });

      it("throws when no name argument provided", async () => {
        await expect(executor.execute("/rename")).rejects.toThrow("Usage: /rename <name>");
      });

      it("throws when name is only whitespace", async () => {
        await expect(executor.execute("/rename   ")).rejects.toThrow("Usage: /rename <name>");
      });
    });

    describe("error handling", () => {
      it("surfaces method-not-found errors clearly", async () => {
        vi.mocked(session.requestRpc).mockRejectedValue(new Error("JSON-RPC error code: -32601"));

        await expect(executor.execute("/compact")).rejects.toThrow(
          'Codex server does not support "thread/compact/start"',
        );
      });

      it("re-throws other errors unchanged", async () => {
        vi.mocked(session.requestRpc).mockRejectedValue(new Error("Network timeout"));

        await expect(executor.execute("/compact")).rejects.toThrow("Network timeout");
      });
    });

    it("returns durationMs in result", async () => {
      const result = await executor.execute("/compact");
      expect(result!.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
