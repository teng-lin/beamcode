import { beforeEach, describe, expect, it } from "vitest";
import type { UnifiedMessage } from "../types/unified-message.js";
import { createUnifiedMessage, isUnifiedMessage } from "../types/unified-message.js";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "./backend-adapter.js";
import type {
  Configurable,
  Interruptible,
  PermissionHandler,
  PermissionRequestEvent,
} from "./extensions.js";

// ---------------------------------------------------------------------------
// Mock implementations — serve as TEMPLATE for real adapters
// ---------------------------------------------------------------------------

/** A channel for passing messages between send() and the messages iterable. */
function createMessageChannel() {
  const queue: UnifiedMessage[] = [];
  let resolve: ((value: IteratorResult<UnifiedMessage>) => void) | null = null;
  let done = false;

  return {
    push(msg: UnifiedMessage) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },
    close() {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<UnifiedMessage> {
      return {
        next(): Promise<IteratorResult<UnifiedMessage>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({
              value: undefined,
              done: true,
            });
          }
          return new Promise((r) => {
            resolve = r;
          });
        },
      };
    },
  };
}

class MockSession implements BackendSession, Interruptible, Configurable {
  readonly sessionId: string;
  private channel = createMessageChannel();
  private _closed = false;
  private _interrupted = false;
  private _model = "default";
  private _permissionMode = "default";

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  send(message: UnifiedMessage): void {
    if (this._closed) throw new Error("Session is closed");
    // Echo back as an assistant response
    const response = createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: `echo: ${message.id}` }],
      metadata: { inResponseTo: message.id },
    });
    this.channel.push(response);
  }

  sendRaw(_ndjson: string): void {
    throw new Error("MockSession does not support raw NDJSON");
  }

  get messages(): AsyncIterable<UnifiedMessage> {
    return this.channel;
  }

  async close(): Promise<void> {
    this._closed = true;
    this.channel.close();
  }

  interrupt(): void {
    this._interrupted = true;
  }

  setModel(model: string): void {
    this._model = model;
  }

  setPermissionMode(mode: string): void {
    this._permissionMode = mode;
  }

  get closed() {
    return this._closed;
  }
  get interrupted() {
    return this._interrupted;
  }
  get model() {
    return this._model;
  }
  get permissionMode() {
    return this._permissionMode;
  }
}

class MockAdapter implements BackendAdapter {
  readonly name = "mock";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: false,
  };

  private sessions = new Map<string, MockSession>();
  private _shouldFail = false;

  setShouldFail(fail: boolean) {
    this._shouldFail = fail;
  }

  async connect(options: ConnectOptions): Promise<BackendSession> {
    if (this._shouldFail) {
      throw new Error("Connection failed");
    }
    const session = new MockSession(options.sessionId);
    this.sessions.set(options.sessionId, session);
    return session;
  }

  getSession(id: string): MockSession | undefined {
    return this.sessions.get(id);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BackendAdapter contract", () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  // -- Adapter properties --

  it("exposes a name", () => {
    expect(adapter.name).toBe("mock");
  });

  it("exposes capabilities", () => {
    expect(adapter.capabilities.streaming).toBe(true);
    expect(adapter.capabilities.permissions).toBe(true);
    expect(adapter.capabilities.slashCommands).toBe(false);
    expect(adapter.capabilities.availability).toBe("local");
  });

  // -- Connect → send → receive → close lifecycle --

  it("connects and returns a session", async () => {
    const session = await adapter.connect({ sessionId: "s-1" });
    expect(session.sessionId).toBe("s-1");
  });

  it("sends a message and receives a response", async () => {
    const session = await adapter.connect({ sessionId: "s-1" });
    const msg = createUnifiedMessage({
      type: "user_message",
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });

    session.send(msg);

    const iterator = session.messages[Symbol.asyncIterator]();
    const { value, done } = await iterator.next();
    expect(done).toBe(false);
    expect(isUnifiedMessage(value)).toBe(true);
    expect(value.type).toBe("assistant");
    expect(value.metadata.inResponseTo).toBe(msg.id);
  });

  it("close() terminates the message stream", async () => {
    const session = await adapter.connect({ sessionId: "s-1" });
    await session.close();

    const iterator = session.messages[Symbol.asyncIterator]();
    const { done } = await iterator.next();
    expect(done).toBe(true);
  });

  it("send() throws after close()", async () => {
    const session = await adapter.connect({ sessionId: "s-1" });
    await session.close();

    const msg = createUnifiedMessage({
      type: "user_message",
      role: "user",
    });
    expect(() => session.send(msg)).toThrow("Session is closed");
  });

  // -- Capabilities querying --

  it("different adapters can declare different capabilities", () => {
    const remoteCapabilities: BackendCapabilities = {
      streaming: false,
      permissions: false,
      slashCommands: false,
      availability: "remote",
      teams: false,
    };

    // Just verify the type system allows different values
    expect(remoteCapabilities.streaming).toBe(false);
    expect(remoteCapabilities.availability).toBe("remote");
  });

  // -- Error handling --

  it("connect() rejects on connection failure", async () => {
    adapter.setShouldFail(true);
    await expect(adapter.connect({ sessionId: "s-1" })).rejects.toThrow("Connection failed");
  });

  // -- Concurrent sessions --

  it("supports multiple concurrent sessions", async () => {
    const s1 = await adapter.connect({ sessionId: "s-1" });
    const s2 = await adapter.connect({ sessionId: "s-2" });

    expect(s1.sessionId).toBe("s-1");
    expect(s2.sessionId).toBe("s-2");

    // Send to both
    const msg1 = createUnifiedMessage({ type: "user_message", role: "user" });
    const msg2 = createUnifiedMessage({ type: "user_message", role: "user" });

    s1.send(msg1);
    s2.send(msg2);

    const iter1 = s1.messages[Symbol.asyncIterator]();
    const iter2 = s2.messages[Symbol.asyncIterator]();

    const [r1, r2] = await Promise.all([iter1.next(), iter2.next()]);

    expect(r1.value.metadata.inResponseTo).toBe(msg1.id);
    expect(r2.value.metadata.inResponseTo).toBe(msg2.id);
  });

  it("closing one session does not affect another", async () => {
    const s1 = await adapter.connect({ sessionId: "s-1" });
    const s2 = await adapter.connect({ sessionId: "s-2" });

    await s1.close();

    // s2 should still work
    const msg = createUnifiedMessage({ type: "user_message", role: "user" });
    s2.send(msg);

    const iter = s2.messages[Symbol.asyncIterator]();
    const { value } = await iter.next();
    expect(value.metadata.inResponseTo).toBe(msg.id);
  });

  // -- ConnectOptions --

  it("accepts resume option", async () => {
    const session = await adapter.connect({
      sessionId: "s-1",
      resume: true,
    });
    expect(session.sessionId).toBe("s-1");
  });

  it("accepts adapterOptions", async () => {
    const session = await adapter.connect({
      sessionId: "s-1",
      adapterOptions: { claudeBinary: "/usr/local/bin/claude" },
    });
    expect(session.sessionId).toBe("s-1");
  });
});

// ---------------------------------------------------------------------------
// Extension interfaces
// ---------------------------------------------------------------------------

describe("extension interfaces", () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  it("Interruptible: session can be interrupted", async () => {
    const session = (await adapter.connect({
      sessionId: "s-1",
    })) as MockSession;

    expect(session.interrupted).toBe(false);
    session.interrupt();
    expect(session.interrupted).toBe(true);
  });

  it("Configurable: model can be changed", async () => {
    const session = (await adapter.connect({
      sessionId: "s-1",
    })) as MockSession;

    session.setModel("claude-opus-4-6");
    expect(session.model).toBe("claude-opus-4-6");
  });

  it("Configurable: permission mode can be changed", async () => {
    const session = (await adapter.connect({
      sessionId: "s-1",
    })) as MockSession;

    session.setPermissionMode("plan");
    expect(session.permissionMode).toBe("plan");
  });

  it("runtime narrowing: check for Interruptible support", async () => {
    const session = await adapter.connect({ sessionId: "s-1" });

    // Runtime extension check pattern
    if ("interrupt" in session) {
      (session as BackendSession & Interruptible).interrupt();
    }
    expect((session as MockSession).interrupted).toBe(true);
  });

  it("runtime narrowing: check for Configurable support", async () => {
    const session = await adapter.connect({ sessionId: "s-1" });

    if ("setModel" in session) {
      (session as BackendSession & Configurable).setModel("test-model");
    }
    expect((session as MockSession).model).toBe("test-model");
  });
});

// ---------------------------------------------------------------------------
// PermissionHandler extension
// ---------------------------------------------------------------------------

describe("PermissionHandler extension", () => {
  it("surfaces permission requests and accepts responses", async () => {
    // Minimal mock implementing PermissionHandler
    const responses: Array<{ requestId: string; behavior: string }> = [];

    const permChannel: PermissionRequestEvent[] = [
      {
        requestId: "pr-1",
        toolName: "Bash",
        input: { command: "rm -rf /" },
        description: "Delete everything",
      },
    ];

    let permIndex = 0;

    const handler: PermissionHandler = {
      permissionRequests: {
        [Symbol.asyncIterator](): AsyncIterator<PermissionRequestEvent> {
          return {
            next(): Promise<IteratorResult<PermissionRequestEvent>> {
              if (permIndex < permChannel.length) {
                return Promise.resolve({
                  value: permChannel[permIndex++],
                  done: false,
                });
              }
              return Promise.resolve({
                value: undefined as unknown as PermissionRequestEvent,
                done: true,
              });
            },
          };
        },
      },
      respondToPermission(requestId: string, behavior: "allow" | "deny") {
        responses.push({ requestId, behavior });
      },
    };

    // Consume one permission request
    const iter = handler.permissionRequests[Symbol.asyncIterator]();
    const { value } = await iter.next();
    expect(value.requestId).toBe("pr-1");
    expect(value.toolName).toBe("Bash");

    // Respond
    handler.respondToPermission("pr-1", "deny");
    expect(responses).toEqual([{ requestId: "pr-1", behavior: "deny" }]);
  });
});

// ---------------------------------------------------------------------------
// Mock as template verification
// ---------------------------------------------------------------------------

describe("MockAdapter as template", () => {
  it("satisfies BackendAdapter interface", () => {
    const adapter: BackendAdapter = new MockAdapter();
    expect(adapter.name).toBeDefined();
    expect(adapter.capabilities).toBeDefined();
    expect(typeof adapter.connect).toBe("function");
  });

  it("MockSession satisfies BackendSession interface", async () => {
    const adapter = new MockAdapter();
    const session: BackendSession = await adapter.connect({ sessionId: "s-1" });
    expect(session.sessionId).toBeDefined();
    expect(typeof session.send).toBe("function");
    expect(typeof session.close).toBe("function");
    expect(Symbol.asyncIterator in session.messages).toBe(true);
  });

  it("full lifecycle: connect → send → receive → close", async () => {
    const adapter = new MockAdapter();
    const session = await adapter.connect({ sessionId: "lifecycle-test" });

    // Send
    const userMsg = createUnifiedMessage({
      type: "user_message",
      role: "user",
      content: [{ type: "text", text: "What is 2+2?" }],
    });
    session.send(userMsg);

    // Receive
    const iter = session.messages[Symbol.asyncIterator]();
    const { value: response } = await iter.next();
    expect(response.type).toBe("assistant");
    expect(response.role).toBe("assistant");

    // Close
    await session.close();
    const { done } = await iter.next();
    expect(done).toBe(true);
  });
});
