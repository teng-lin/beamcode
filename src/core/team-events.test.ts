/**
 * Team Event Emission Tests — Phase 5.7
 *
 * Tests that emitTeamEvents correctly diffs previous and current TeamState
 * and emits the right bridge events through the adapter path (routeUnifiedMessage).
 *
 * Uses the BackendAdapter path since emitTeamEvents is wired into routeUnifiedMessage.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { MemoryStorage } from "../adapters/memory-storage.js";
import type { AuthContext } from "../interfaces/auth.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "./interfaces/backend-adapter.js";
import { SessionBridge } from "./session-bridge.js";
import type { UnifiedMessage } from "./types/unified-message.js";
import { createUnifiedMessage } from "./types/unified-message.js";

// ---------------------------------------------------------------------------
// Mock infrastructure (same pattern as session-bridge-adapter.test.ts)
// ---------------------------------------------------------------------------

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
        r({ value: undefined as unknown as UnifiedMessage, done: true });
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
              value: undefined as unknown as UnifiedMessage,
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

class MockBackendSession implements BackendSession {
  readonly sessionId: string;
  readonly channel = createMessageChannel();
  readonly sentMessages: UnifiedMessage[] = [];
  private _closed = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  send(message: UnifiedMessage): void {
    if (this._closed) throw new Error("Session is closed");
    this.sentMessages.push(message);
  }

  get messages(): AsyncIterable<UnifiedMessage> {
    return this.channel;
  }

  async close(): Promise<void> {
    this._closed = true;
    this.channel.close();
  }

  pushMessage(msg: UnifiedMessage) {
    this.channel.push(msg);
  }
}

class MockBackendAdapter implements BackendAdapter {
  readonly name = "mock";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: true,
  };

  private sessions = new Map<string, MockBackendSession>();

  async connect(options: ConnectOptions): Promise<BackendSession> {
    const session = new MockBackendSession(options.sessionId);
    this.sessions.set(options.sessionId, session);
    return session;
  }

  getSession(id: string): MockBackendSession | undefined {
    return this.sessions.get(id);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _createMockSocket(): WebSocketLike & {
  sentMessages: string[];
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const sentMessages: string[] = [];
  return {
    send: vi.fn((data: string) => sentMessages.push(data)),
    close: vi.fn(),
    sentMessages,
  };
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

function _authContext(sessionId: string): AuthContext {
  return { sessionId, transport: {} };
}

function createBridgeWithAdapter() {
  const storage = new MemoryStorage();
  const adapter = new MockBackendAdapter();
  const bridge = new SessionBridge({
    storage,
    config: { port: 3456 },
    logger: noopLogger,
    adapter,
  });
  return { bridge, storage, adapter };
}

/** Helper: push a team tool_use + tool_result pair through the backend session. */
function pushTeamToolPair(
  backendSession: MockBackendSession,
  toolName: string,
  toolUseId: string,
  input: Record<string, unknown>,
  resultContent = "{}",
  isError = false,
) {
  // tool_use in an assistant message
  backendSession.pushMessage(
    createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: toolName,
          input,
        },
      ],
    }),
  );

  // tool_result in a subsequent message
  backendSession.pushMessage(
    createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: resultContent,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    }),
  );
}

/** Wait for async message consumption to process. */
function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("team event emission (Phase 5.7)", () => {
  let bridge: SessionBridge;
  let adapter: MockBackendAdapter;
  const SESSION_ID = "sess-team-events";

  beforeEach(() => {
    const ctx = createBridgeWithAdapter();
    bridge = ctx.bridge;
    adapter = ctx.adapter;
  });

  async function connectSession() {
    await bridge.connectBackend(SESSION_ID);
    return adapter.getSession(SESSION_ID)!;
  }

  describe("team:created", () => {
    it("emits team:created when TeamCreate tool_use + result are processed", async () => {
      const backend = await connectSession();
      const events: unknown[] = [];
      bridge.on("team:created", (e) => events.push(e));

      pushTeamToolPair(backend, "TeamCreate", "tu-1", { team_name: "alpha" });
      await tick();

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        sessionId: SESSION_ID,
        teamName: "alpha",
      });
    });

    it("does not emit team:created for non-team tool_use", async () => {
      const backend = await connectSession();
      const events: unknown[] = [];
      bridge.on("team:created", (e) => events.push(e));

      pushTeamToolPair(backend, "Read", "tu-read", { file_path: "/tmp/test" });
      await tick();

      expect(events).toHaveLength(0);
    });
  });

  describe("team:deleted", () => {
    it("emits team:deleted when TeamDelete tool_use + result are processed", async () => {
      const backend = await connectSession();

      // First create a team
      pushTeamToolPair(backend, "TeamCreate", "tu-1", { team_name: "alpha" });
      await tick();

      const events: unknown[] = [];
      bridge.on("team:deleted", (e) => events.push(e));

      // Then delete it
      pushTeamToolPair(backend, "TeamDelete", "tu-del", {});
      await tick();

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        sessionId: SESSION_ID,
        teamName: "alpha",
      });
    });
  });

  describe("team:member:joined", () => {
    it("emits team:member:joined when Task tool spawns a new member", async () => {
      const backend = await connectSession();

      // Create team first
      pushTeamToolPair(backend, "TeamCreate", "tu-1", { team_name: "alpha" });
      await tick();

      const events: unknown[] = [];
      bridge.on("team:member:joined", (e) => events.push(e));

      // Spawn a member via Task tool with team_name
      pushTeamToolPair(backend, "Task", "tu-2", {
        team_name: "alpha",
        name: "worker-1",
        model: "claude-sonnet-4-5-20250929",
      });
      await tick();

      expect(events).toHaveLength(1);
      expect((events[0] as { member: { name: string } }).member.name).toBe("worker-1");
      expect((events[0] as { member: { status: string } }).member.status).toBe("active");
    });
  });

  describe("team:task:created", () => {
    it("emits team:task:created when TaskCreate is processed", async () => {
      const backend = await connectSession();

      // Create team
      pushTeamToolPair(backend, "TeamCreate", "tu-1", { team_name: "alpha" });
      await tick();

      const events: unknown[] = [];
      bridge.on("team:task:created", (e) => events.push(e));

      // Create task
      pushTeamToolPair(backend, "TaskCreate", "tu-3", { subject: "Fix bug" }, '{"id": "1"}');
      await tick();

      expect(events).toHaveLength(1);
      expect((events[0] as { task: { subject: string } }).task.subject).toBe("Fix bug");
    });
  });

  describe("team:task:claimed", () => {
    it("emits team:task:claimed when TaskUpdate sets status to in_progress with owner", async () => {
      const backend = await connectSession();

      // Create team + task
      pushTeamToolPair(backend, "TeamCreate", "tu-1", { team_name: "alpha" });
      await tick();
      pushTeamToolPair(backend, "TaskCreate", "tu-2", { subject: "Fix bug" }, '{"id": "1"}');
      await tick();

      const events: unknown[] = [];
      bridge.on("team:task:claimed", (e) => events.push(e));

      // Claim task
      pushTeamToolPair(backend, "TaskUpdate", "tu-3", {
        taskId: "1",
        status: "in_progress",
        owner: "worker-1",
      });
      await tick();

      expect(events).toHaveLength(1);
      expect((events[0] as { task: { id: string; status: string } }).task.id).toBe("1");
      expect((events[0] as { task: { status: string } }).task.status).toBe("in_progress");
    });
  });

  describe("team:task:completed", () => {
    it("emits team:task:completed when TaskUpdate sets status to completed", async () => {
      const backend = await connectSession();

      // Create team + task
      pushTeamToolPair(backend, "TeamCreate", "tu-1", { team_name: "alpha" });
      await tick();
      pushTeamToolPair(backend, "TaskCreate", "tu-2", { subject: "Fix bug" }, '{"id": "1"}');
      await tick();

      const events: unknown[] = [];
      bridge.on("team:task:completed", (e) => events.push(e));

      // Complete task
      pushTeamToolPair(backend, "TaskUpdate", "tu-3", { taskId: "1", status: "completed" });
      await tick();

      expect(events).toHaveLength(1);
      expect((events[0] as { task: { id: string; status: string } }).task.id).toBe("1");
      expect((events[0] as { task: { status: string } }).task.status).toBe("completed");
    });
  });

  describe("no events for non-team sessions", () => {
    it("does not emit team events for regular assistant messages", async () => {
      const backend = await connectSession();
      const allEvents: string[] = [];

      bridge.on("team:created", () => allEvents.push("team:created"));
      bridge.on("team:deleted", () => allEvents.push("team:deleted"));
      bridge.on("team:member:joined", () => allEvents.push("team:member:joined"));
      bridge.on("team:task:created", () => allEvents.push("team:task:created"));

      // Send a regular text assistant message
      backend.pushMessage(
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text: "Hello, I'm helping you with code." }],
        }),
      );
      await tick();

      expect(allEvents).toHaveLength(0);
    });
  });

  describe("no events on reference equality", () => {
    it("does not emit events when team state is unchanged", async () => {
      const backend = await connectSession();

      // Create team
      pushTeamToolPair(backend, "TeamCreate", "tu-1", { team_name: "alpha" });
      await tick();

      const events: string[] = [];
      bridge.on("team:created", () => events.push("team:created"));
      bridge.on("team:deleted", () => events.push("team:deleted"));
      bridge.on("team:member:joined", () => events.push("team:member:joined"));
      bridge.on("team:task:created", () => events.push("team:task:created"));

      // Send a regular message (no team tools) — team state should not change
      backend.pushMessage(
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text: "Here is the result." }],
        }),
      );
      await tick();

      expect(events).toHaveLength(0);
    });
  });

  describe("error tool_result", () => {
    it("does not emit team events for error tool_result", async () => {
      const backend = await connectSession();

      // Create team first
      pushTeamToolPair(backend, "TeamCreate", "tu-1", { team_name: "alpha" });
      await tick();

      const events: string[] = [];
      bridge.on("team:task:created", () => events.push("team:task:created"));

      // TaskCreate with error result
      pushTeamToolPair(
        backend,
        "TaskCreate",
        "tu-err",
        { subject: "Broken" },
        "Something went wrong",
        true,
      );
      await tick();

      expect(events).toHaveLength(0);
    });
  });

  describe("full lifecycle", () => {
    it("emits create → member:joined → task:created → task:completed → deleted", async () => {
      const backend = await connectSession();
      const events: string[] = [];

      bridge.on("team:created", () => events.push("team:created"));
      bridge.on("team:deleted", () => events.push("team:deleted"));
      bridge.on("team:member:joined", () => events.push("team:member:joined"));
      bridge.on("team:task:created", () => events.push("team:task:created"));
      bridge.on("team:task:completed", () => events.push("team:task:completed"));

      // Create team
      pushTeamToolPair(backend, "TeamCreate", "tu-1", { team_name: "alpha" });
      await tick();
      expect(events).toEqual(["team:created"]);

      // Add member
      pushTeamToolPair(backend, "Task", "tu-2", { team_name: "alpha", name: "dev-1" });
      await tick();
      expect(events).toEqual(["team:created", "team:member:joined"]);

      // Create task
      pushTeamToolPair(backend, "TaskCreate", "tu-3", { subject: "Fix bug" }, '{"id": "1"}');
      await tick();
      expect(events).toEqual(["team:created", "team:member:joined", "team:task:created"]);

      // Complete task
      pushTeamToolPair(backend, "TaskUpdate", "tu-4", { taskId: "1", status: "completed" });
      await tick();
      expect(events).toEqual([
        "team:created",
        "team:member:joined",
        "team:task:created",
        "team:task:completed",
      ]);

      // Delete team
      pushTeamToolPair(backend, "TeamDelete", "tu-5", {});
      await tick();
      expect(events).toEqual([
        "team:created",
        "team:member:joined",
        "team:task:created",
        "team:task:completed",
        "team:deleted",
      ]);
    });
  });

  describe("session state sync", () => {
    it("updates session.state.team alongside events", async () => {
      const backend = await connectSession();

      // Create team
      pushTeamToolPair(backend, "TeamCreate", "tu-1", { team_name: "alpha" });
      await tick();

      const snapshot = bridge.getSession(SESSION_ID);
      expect(snapshot?.state.team).toBeDefined();
      expect(snapshot?.state.team?.name).toBe("alpha");
      expect(snapshot?.state.team?.role).toBe("lead");
    });

    it("clears session.state.team on TeamDelete", async () => {
      const backend = await connectSession();

      pushTeamToolPair(backend, "TeamCreate", "tu-1", { team_name: "alpha" });
      await tick();
      pushTeamToolPair(backend, "TeamDelete", "tu-del", {});
      await tick();

      const snapshot = bridge.getSession(SESSION_ID);
      expect(snapshot?.state.team).toBeUndefined();
      expect(snapshot?.state.agents).toEqual([]);
    });

    it("populates agents[] backward compat from team.members", async () => {
      const backend = await connectSession();

      pushTeamToolPair(backend, "TeamCreate", "tu-1", { team_name: "alpha" });
      await tick();
      pushTeamToolPair(backend, "Task", "tu-2", { team_name: "alpha", name: "dev-1" });
      await tick();

      const snapshot = bridge.getSession(SESSION_ID);
      expect(snapshot?.state.agents).toEqual(["dev-1"]);
    });
  });
});
