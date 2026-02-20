import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnFn } from "../acp/acp-adapter.js";
import { autoRespond, createMockChild, type MockChild } from "../acp/acp-mock-helpers.js";
import { GeminiAdapter } from "./gemini-adapter.js";

describe("GeminiAdapter", () => {
  let mockChild: MockChild;
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
      expect(spawnCalls[0].args).toEqual(["--experimental-acp", "--approval-mode", "default"]);
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
      expect(spawnCalls[0].args).toEqual(["--experimental-acp", "--approval-mode", "default"]);
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

    it("rejects if subprocess closes before responding", async () => {
      setup();
      // No autoRespond — subprocess closes immediately
      setTimeout(() => mockChild.stdout.emit("close"), 0);

      const adapter = new GeminiAdapter({ spawnFn: mockSpawn });
      await expect(adapter.connect({ sessionId: "sess-1" })).rejects.toThrow(
        "ACP subprocess closed before responding",
      );
    });
  });
});
