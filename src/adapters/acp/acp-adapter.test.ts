import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { SpawnFn } from "./acp-adapter.js";
import { AcpAdapter } from "./acp-adapter.js";

// ---------------------------------------------------------------------------
// Mock subprocess helpers
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

function sendNotification(stdout: MockStream, method: string, params: unknown) {
  const notification = `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
  stdout.emit("data", Buffer.from(notification));
}

function sendRequest(stdout: MockStream, id: number, method: string, params: unknown) {
  const request = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
  stdout.emit("data", Buffer.from(request));
}

/** Allow the adapter to process async microtasks between responses. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Auto-responder: watches stdin for JSON-RPC requests and
 * responds to initialize + session/new|session/load automatically.
 * Returns a promise that resolves when the handshake completes.
 */
function autoRespond(
  stdin: MockStream,
  stdout: MockStream,
  initResult?: Record<string, unknown>,
  sessionResult?: Record<string, unknown>,
): void {
  const defaultInit = {
    protocolVersion: 1,
    agentCapabilities: { streaming: true },
    agentInfo: { name: "test-agent", version: "1.0" },
    ...initResult,
  };
  const defaultSession = { sessionId: "sess-1", ...sessionResult };

  // Watch for writes to stdin and auto-respond
  const origWrite = stdin.write.bind(stdin);
  stdin.write = (data: string): boolean => {
    origWrite(data);
    try {
      const parsed = JSON.parse(data.trim());
      if (parsed.method === "initialize") {
        // Use setTimeout to ensure response arrives after listener is attached
        setTimeout(() => respondToRequest(stdout, parsed.id, defaultInit), 0);
      } else if (parsed.method === "session/new" || parsed.method === "session/load") {
        setTimeout(() => respondToRequest(stdout, parsed.id, defaultSession), 0);
      }
    } catch {
      // ignore
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AcpAdapter", () => {
  let mockChild: ReturnType<typeof createMockChild>;
  let mockSpawn: SpawnFn;
  let spawnCalls: Array<{ command: string; args: string[] }>;

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
      setup();
      const adapter = new AcpAdapter(mockSpawn);
      expect(adapter.name).toBe("acp");
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
    it("spawns subprocess with specified command", async () => {
      setup();
      autoRespond(mockChild.stdin, mockChild.stdout, {
        agentInfo: { name: "my-agent", version: "1.0" },
      });

      const adapter = new AcpAdapter(mockSpawn);
      const session = await adapter.connect({
        sessionId: "sess-1",
        adapterOptions: { command: "my-agent", args: ["--verbose"] },
      });

      expect(spawnCalls[0].command).toBe("my-agent");
      expect(spawnCalls[0].args).toEqual(["--verbose"]);
      expect(session.sessionId).toBe("sess-1");
    });

    it("defaults command to goose", async () => {
      setup();
      autoRespond(mockChild.stdin, mockChild.stdout);

      const adapter = new AcpAdapter(mockSpawn);
      await adapter.connect({ sessionId: "sess-1" });

      expect(spawnCalls[0].command).toBe("goose");
      expect(spawnCalls[0].args).toEqual([]);
    });

    it("sends initialize and session/new handshake", async () => {
      setup();
      const adapter = new AcpAdapter(mockSpawn);
      const connectPromise = adapter.connect({ sessionId: "sess-1" });

      await tick();

      const initReq = JSON.parse(mockChild.stdin.chunks[0]);
      expect(initReq.method).toBe("initialize");
      expect(initReq.params.protocolVersion).toBe(1);

      respondToRequest(mockChild.stdout, 1, {
        protocolVersion: 1,
        agentCapabilities: {},
      });

      await tick();

      const sessionReq = JSON.parse(mockChild.stdin.chunks[1]);
      expect(sessionReq.method).toBe("session/new");

      respondToRequest(mockChild.stdout, 2, { sessionId: "sess-1" });
      await connectPromise;
    });

    it("uses session/load for resume", async () => {
      setup();
      const adapter = new AcpAdapter(mockSpawn);
      const connectPromise = adapter.connect({
        sessionId: "sess-existing",
        resume: true,
      });

      await tick();
      respondToRequest(mockChild.stdout, 1, {
        protocolVersion: 1,
        agentCapabilities: {},
      });

      await tick();
      respondToRequest(mockChild.stdout, 2, { sessionId: "sess-existing" });

      await connectPromise;

      const sessionReq = JSON.parse(mockChild.stdin.chunks[1]);
      expect(sessionReq.method).toBe("session/load");
    });
  });

  describe("session", () => {
    async function createSession() {
      setup();
      autoRespond(mockChild.stdin, mockChild.stdout);

      const adapter = new AcpAdapter(mockSpawn);
      return adapter.connect({ sessionId: "sess-1" });
    }

    it("yields session_init as first message", async () => {
      const session = await createSession();
      const iter = session.messages[Symbol.asyncIterator]();
      const first = await iter.next();

      expect(first.done).toBe(false);
      expect(first.value.type).toBe("session_init");
      expect(first.value.metadata.agentName).toBe("test-agent");

      await iter.return!();
    });

    it("sends user_message as session/prompt", async () => {
      const session = await createSession();

      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "Hello agent" }],
        metadata: { sessionId: "sess-1" },
      });
      session.send(msg);

      const promptReq = JSON.parse(mockChild.stdin.chunks[mockChild.stdin.chunks.length - 1]);
      expect(promptReq.method).toBe("session/prompt");
      expect(promptReq.params.prompt).toEqual([{ type: "text", text: "Hello agent" }]);
    });

    it("receives session/update as UnifiedMessage stream", async () => {
      const session = await createSession();
      const iter = session.messages[Symbol.asyncIterator]();

      // Skip session_init
      await iter.next();

      sendNotification(mockChild.stdout, "session/update", {
        sessionId: "sess-1",
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello user" },
      });

      const result = await iter.next();
      expect(result.value.type).toBe("stream_event");
      expect(result.value.role).toBe("assistant");
      expect(result.value.content[0]).toEqual({ type: "text", text: "Hello user" });

      await iter.return!();
    });

    it("handles permission request/response flow", async () => {
      const session = await createSession();
      const iter = session.messages[Symbol.asyncIterator]();

      // Skip session_init
      await iter.next();

      // Agent sends permission request
      sendRequest(mockChild.stdout, 100, "session/request_permission", {
        sessionId: "sess-1",
        toolCall: { toolCallId: "call-1", title: "Run bash" },
        options: [
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "reject-once", name: "Deny", kind: "reject_once" },
        ],
      });

      const permReq = await iter.next();
      expect(permReq.value.type).toBe("permission_request");
      expect(permReq.value.metadata.toolCall).toEqual({
        toolCallId: "call-1",
        title: "Run bash",
      });

      // Send permission response
      const permResp = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "allow", optionId: "allow-once" },
      });
      session.send(permResp);

      const lastWrite = JSON.parse(mockChild.stdin.chunks[mockChild.stdin.chunks.length - 1]);
      expect(lastWrite.id).toBe(100);
      expect(lastWrite.result.outcome.optionId).toBe("allow-once");

      await iter.return!();
    });

    it("sends interrupt as session/cancel notification", async () => {
      const session = await createSession();

      const msg = createUnifiedMessage({
        type: "interrupt",
        role: "user",
      });
      session.send(msg);

      const cancelMsg = JSON.parse(mockChild.stdin.chunks[mockChild.stdin.chunks.length - 1]);
      expect(cancelMsg.method).toBe("session/cancel");
      expect("id" in cancelMsg).toBe(false);
    });

    it("stubs fs/ requests with error response", async () => {
      const session = await createSession();
      const iter = session.messages[Symbol.asyncIterator]();

      // Skip session_init
      await iter.next();

      sendRequest(mockChild.stdout, 200, "fs/read_text_file", {
        path: "/some/file.ts",
      });

      await tick();

      const errResp = JSON.parse(mockChild.stdin.chunks[mockChild.stdin.chunks.length - 1]);
      expect(errResp.id).toBe(200);
      expect(errResp.error.code).toBe(-32601);
      expect(errResp.error.message).toBe("Method not supported");

      await iter.return!();
    });

    it("close sends SIGTERM to subprocess", async () => {
      const session = await createSession();

      await session.close();

      expect(mockChild.child.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("throws on send after close", async () => {
      const session = await createSession();
      await session.close();

      expect(() =>
        session.send(
          createUnifiedMessage({
            type: "user_message",
            role: "user",
            content: [{ type: "text", text: "should be ignored" }],
            metadata: {},
          }),
        ),
      ).toThrow("Session is closed");
    });
  });
});
