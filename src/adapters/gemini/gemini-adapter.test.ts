import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnFn } from "../acp/acp-adapter.js";
import { GeminiAdapter } from "./gemini-adapter.js";

// ---------------------------------------------------------------------------
// Mock subprocess helpers (same pattern as acp-adapter.test.ts)
// ---------------------------------------------------------------------------

class MockStream extends EventEmitter {
  readonly chunks: string[] = [];

  write(data: string): boolean {
    this.chunks.push(data);
    return true;
  }
}

function createMockChild() {
  const stdin = new MockStream();
  const stdout = new MockStream();
  const stderr = new MockStream();
  const child = new EventEmitter() as ChildProcess;

  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    killed: false,
    kill: vi.fn((_signal?: string) => {
      (child as unknown as { killed: boolean }).killed = true;
      child.emit("exit", 0, null);
      return true;
    }),
  });

  return { child, stdin, stdout, stderr };
}

function respondToRequest(stdout: MockStream, id: number, result: unknown) {
  const response = `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
  stdout.emit("data", Buffer.from(response));
}

function autoRespond(stdin: MockStream, stdout: MockStream): void {
  const origWrite = stdin.write.bind(stdin);
  stdin.write = (data: string): boolean => {
    origWrite(data);
    try {
      const parsed = JSON.parse(data.trim());
      if (parsed.method === "initialize") {
        setTimeout(
          () =>
            respondToRequest(stdout, parsed.id, {
              protocolVersion: 1,
              agentCapabilities: { streaming: true },
              agentInfo: { name: "gemini-acp", version: "1.0" },
            }),
          0,
        );
      } else if (parsed.method === "session/new" || parsed.method === "session/load") {
        const sessionId = parsed.params?.sessionId ?? "unknown";
        setTimeout(() => respondToRequest(stdout, parsed.id, { sessionId }), 0);
      }
    } catch {
      // ignore non-JSON
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GeminiAdapter", () => {
  let mockChild: ReturnType<typeof createMockChild>;
  let spawnCalls: Array<{ command: string; args: string[] }>;
  let mockSpawn: SpawnFn;

  function setup() {
    mockChild = createMockChild();
    spawnCalls = [];
    mockSpawn = ((command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      return mockChild.child;
    }) as unknown as SpawnFn;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("capabilities", () => {
    it("declares correct capabilities", () => {
      const adapter = new GeminiAdapter();
      expect(adapter.name).toBe("gemini");
      expect(adapter.capabilities).toEqual({
        streaming: true,
        permissions: true,
        slashCommands: true,
        availability: "local",
        teams: false,
      });
    });
  });

  describe("connect", () => {
    it("spawns gemini --experimental-acp by default", async () => {
      setup();
      autoRespond(mockChild.stdin, mockChild.stdout);

      const adapter = new GeminiAdapter({ spawnFn: mockSpawn });
      await adapter.connect({ sessionId: "sess-1" });

      expect(spawnCalls[0].command).toBe("gemini");
      expect(spawnCalls[0].args).toEqual(["--experimental-acp"]);
    });

    it("uses geminiBinary from constructor options", async () => {
      setup();
      autoRespond(mockChild.stdin, mockChild.stdout);

      const adapter = new GeminiAdapter({
        spawnFn: mockSpawn,
        geminiBinary: "/usr/local/bin/gemini-dev",
      });
      await adapter.connect({ sessionId: "sess-1" });

      expect(spawnCalls[0].command).toBe("/usr/local/bin/gemini-dev");
      expect(spawnCalls[0].args).toEqual(["--experimental-acp"]);
    });

    it("uses geminiBinary from adapterOptions (overrides constructor)", async () => {
      setup();
      autoRespond(mockChild.stdin, mockChild.stdout);

      const adapter = new GeminiAdapter({
        spawnFn: mockSpawn,
        geminiBinary: "/default/gemini",
      });
      await adapter.connect({
        sessionId: "sess-1",
        adapterOptions: { geminiBinary: "/override/gemini" },
      });

      expect(spawnCalls[0].command).toBe("/override/gemini");
    });

    it("returns a session with correct sessionId", async () => {
      setup();
      autoRespond(mockChild.stdin, mockChild.stdout);

      const adapter = new GeminiAdapter({ spawnFn: mockSpawn });
      const session = await adapter.connect({ sessionId: "sess-42" });

      expect(session.sessionId).toBe("sess-42");
    });

    it("performs ACP initialize + session/new handshake", async () => {
      setup();
      autoRespond(mockChild.stdin, mockChild.stdout);

      const adapter = new GeminiAdapter({ spawnFn: mockSpawn });
      await adapter.connect({ sessionId: "sess-1" });

      const initReq = JSON.parse(mockChild.stdin.chunks[0]);
      expect(initReq.method).toBe("initialize");
      expect(initReq.params.protocolVersion).toBe(1);

      const sessionReq = JSON.parse(mockChild.stdin.chunks[1]);
      expect(sessionReq.method).toBe("session/new");
    });
  });
});
