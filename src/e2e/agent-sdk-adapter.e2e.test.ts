/**
 * AgentSdkAdapter E2E tests — exercises AgentSdkSession directly with a
 * controllable mock SDK query(), bypassing the real Agent SDK.
 *
 * Follows the Codex E2E pattern: create session, exercise full message flows,
 * verify UnifiedMessage output.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSession } from "../core/interfaces/backend-adapter.js";
import type { UnifiedMessage } from "../core/types/unified-message.js";
import {
  collectUnifiedMessages,
  createInterruptMessage,
  createPermissionResponse,
  createUserMessage,
  waitForUnifiedMessageType,
} from "./helpers/backend-test-utils.js";

// ---------------------------------------------------------------------------
// Controllable mock query
// ---------------------------------------------------------------------------

interface ControllableMock {
  push(msg: Record<string, unknown>): void;
  finish(): void;
  fail(err: Error): void;
  canUseTool: ((...args: unknown[]) => Promise<unknown>) | null;
  closeCalled: boolean;
  interruptCalled: boolean;
  capturedOptions: Record<string, unknown>;
  inputMessages: unknown[];
}

let currentMock: ControllableMock | null = null;

function createControllableMock(): ControllableMock {
  const messageQueue: Record<string, unknown>[] = [];
  let messageResolve: ((value: IteratorResult<Record<string, unknown>>) => void) | null = null;
  let finished = false;
  let streamError: Error | null = null;

  const mock: ControllableMock = {
    canUseTool: null,
    closeCalled: false,
    interruptCalled: false,
    capturedOptions: {},
    inputMessages: [],

    push(msg: Record<string, unknown>) {
      if (finished) return;
      if (messageResolve) {
        const resolve = messageResolve;
        messageResolve = null;
        resolve({ value: msg, done: false });
      } else {
        messageQueue.push(msg);
      }
    },

    finish() {
      finished = true;
      if (messageResolve) {
        const resolve = messageResolve;
        messageResolve = null;
        resolve({ value: undefined, done: true } as IteratorResult<Record<string, unknown>>);
      }
    },

    fail(err: Error) {
      streamError = err;
      if (messageResolve) {
        const resolve = messageResolve;
        messageResolve = null;
        // We need to reject, so we store the error and handle it in next()
        // Actually, we need to throw from the generator, which we do by
        // setting the error and resolving the pending next() with a special marker
        resolve({ value: { __error: err } as unknown as Record<string, unknown>, done: false });
      }
    },
  };

  // Create the async generator that the session will consume
  const generator: AsyncGenerator<Record<string, unknown>, void> & {
    close: () => void;
    interrupt: () => Promise<void>;
  } = {
    async next(): Promise<IteratorResult<Record<string, unknown>>> {
      if (streamError) {
        const err = streamError;
        streamError = null;
        throw err;
      }

      const queued = messageQueue.shift();
      if (queued !== undefined) {
        if ((queued as { __error?: Error }).__error) {
          throw (queued as { __error: Error }).__error;
        }
        return { value: queued, done: false };
      }

      if (finished) {
        return { value: undefined, done: true } as IteratorResult<Record<string, unknown>>;
      }

      return new Promise((resolve) => {
        messageResolve = resolve;
      }).then((result: unknown) => {
        const r = result as IteratorResult<Record<string, unknown>>;
        if (!r.done && (r.value as { __error?: Error }).__error) {
          throw (r.value as { __error: Error }).__error;
        }
        return r;
      });
    },
    async return() {
      finished = true;
      return { value: undefined, done: true } as IteratorResult<Record<string, unknown>>;
    },
    async throw(err: unknown) {
      finished = true;
      throw err;
    },
    close() {
      mock.closeCalled = true;
      finished = true;
      if (messageResolve) {
        const resolve = messageResolve;
        messageResolve = null;
        resolve({ value: undefined, done: true } as IteratorResult<Record<string, unknown>>);
      }
    },
    async interrupt() {
      mock.interruptCalled = true;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  // Attach the generator to the mock for access
  (mock as { _generator?: typeof generator })._generator = generator;

  return mock;
}

// ---------------------------------------------------------------------------
// Mock the Agent SDK module
// ---------------------------------------------------------------------------

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(
    ({
      prompt,
      options,
    }: {
      prompt: string | AsyncIterable<{ type: "user"; message: unknown }>;
      options?: Record<string, unknown>;
    }) => {
      if (!currentMock) throw new Error("No controllable mock set up");

      // Capture the options (including canUseTool)
      currentMock.capturedOptions = options ?? {};
      if (typeof options?.canUseTool === "function") {
        currentMock.canUseTool = options.canUseTool as (...args: unknown[]) => Promise<unknown>;
      }

      // Consume the prompt iterable in the background (for multi-turn)
      if (typeof prompt !== "string" && prompt[Symbol.asyncIterator]) {
        void (async () => {
          try {
            for await (const msg of prompt) {
              currentMock!.inputMessages.push(msg);
            }
          } catch {
            // input stream closed — expected on session close
          }
        })();
      }

      return (currentMock as { _generator?: unknown })._generator;
    },
  ),
}));

// ---------------------------------------------------------------------------
// SDK message factories
// ---------------------------------------------------------------------------

function sdkSystemInit(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    cwd: "/test",
    session_id: "backend-session-1",
    tools: ["Bash", "Read", "Write"],
    mcp_servers: [],
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    apiKeySource: "user",
    claude_code_version: "1.0.0",
    slash_commands: [],
    skills: [],
    output_style: "concise",
    uuid: "00000000-0000-0000-0000-000000000001",
    ...overrides,
  };
}

function sdkAssistant(text: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text }],
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
    ...overrides,
  };
}

function sdkResult(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

function sdkStreamEvent(text: string): Record<string, unknown> {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text },
    },
  };
}

function sdkToolProgress(toolName: string): Record<string, unknown> {
  return {
    type: "tool_progress",
    tool_name: toolName,
    tool_use_id: "tu-progress-1",
    data: "working...",
  };
}

function sdkHookStarted(hookName: string): Record<string, unknown> {
  return {
    type: "system",
    subtype: "hook_started",
    hook_id: `hook-${hookName}`,
    hook_name: hookName,
    hook_event: "PreToolUse",
    uuid: "00000000-0000-0000-0000-000000000010",
    session_id: "backend-session-1",
  };
}

function sdkHookProgress(hookName: string): Record<string, unknown> {
  return {
    type: "system",
    subtype: "hook_progress",
    hook_id: `hook-${hookName}`,
    hook_name: hookName,
    hook_event: "PreToolUse",
    stdout: "hook output",
    uuid: "00000000-0000-0000-0000-000000000011",
    session_id: "backend-session-1",
  };
}

function sdkHookResponse(hookName: string): Record<string, unknown> {
  return {
    type: "system",
    subtype: "hook_response",
    hook_id: `hook-${hookName}`,
    hook_name: hookName,
    hook_event: "PreToolUse",
    exit_code: 0,
    outcome: "approve",
    stdout: "hook done",
    uuid: "00000000-0000-0000-0000-000000000012",
    session_id: "backend-session-1",
  };
}

function sdkTaskStarted(taskId: string): Record<string, unknown> {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: "tu-task-1",
    description: "Running task",
    task_type: "background",
    uuid: "00000000-0000-0000-0000-000000000013",
    session_id: "backend-session-1",
  };
}

function sdkTaskNotification(taskId: string): Record<string, unknown> {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: "tu-task-1",
    status: "completed",
    summary: "Task finished",
    uuid: "00000000-0000-0000-0000-000000000014",
    session_id: "backend-session-1",
  };
}

function sdkCompactBoundary(): Record<string, unknown> {
  return {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { tokens_before: 5000, tokens_after: 2000 },
    uuid: "00000000-0000-0000-0000-000000000015",
    session_id: "backend-session-1",
  };
}

function sdkFilesPersisted(): Record<string, unknown> {
  return {
    type: "system",
    subtype: "files_persisted",
    files: ["/tmp/test.txt"],
    failed: [],
    processed_at: "2026-02-21T00:00:00Z",
    uuid: "00000000-0000-0000-0000-000000000016",
    session_id: "backend-session-1",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Import must happen after vi.mock so the mock is active */
async function createSession(options?: {
  sessionId?: string;
  resume?: boolean;
  backendSessionId?: string;
}): Promise<BackendSession> {
  const { AgentSdkSession } = await import("../adapters/agent-sdk/agent-sdk-session.js");
  return AgentSdkSession.create({
    sessionId: options?.sessionId ?? "e2e-agent-sdk",
    resume: options?.resume,
    adapterOptions: options?.backendSessionId
      ? { backendSessionId: options.backendSessionId }
      : undefined,
  });
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: AgentSdkAdapter", () => {
  let session: BackendSession | undefined;

  afterEach(async () => {
    if (session) {
      await session.close();
      session = undefined;
    }
    currentMock = null;
  });

  // -------------------------------------------------------------------------
  // 1. Full turn with streaming
  // -------------------------------------------------------------------------

  it("full turn with streaming: system:init → stream_event deltas → assistant → result", async () => {
    currentMock = createControllableMock();
    session = await createSession();

    // Push system:init
    currentMock.push(sdkSystemInit());

    const { target: initMsg } = await waitForUnifiedMessageType(session, "session_init");
    expect(initMsg.type).toBe("session_init");
    expect(initMsg.metadata.model).toBe("claude-sonnet-4-6");

    // Push streaming deltas
    currentMock.push(sdkStreamEvent("Hello "));
    currentMock.push(sdkStreamEvent("world!"));

    // Push assistant message
    currentMock.push(sdkAssistant("Hello world!"));

    // Push result
    currentMock.push(sdkResult());
    currentMock.finish();

    // Collect: 2 stream_events + 1 assistant + 1 result
    const messages = await collectUnifiedMessages(session, 4);

    expect(messages[0].type).toBe("stream_event");
    expect(messages[1].type).toBe("stream_event");
    expect(messages[2].type).toBe("assistant");
    expect(messages[2].content).toEqual([{ type: "text", text: "Hello world!" }]);
    expect(messages[3].type).toBe("result");
    expect(messages[3].metadata.is_error).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 2. Multi-turn conversation
  // -------------------------------------------------------------------------

  it("multi-turn: first turn completes, second user message is consumed", async () => {
    currentMock = createControllableMock();
    session = await createSession();

    // Turn 1
    currentMock.push(sdkSystemInit());
    await waitForUnifiedMessageType(session, "session_init");

    currentMock.push(sdkAssistant("Response 1"));
    currentMock.push(sdkResult());

    const turn1 = await collectUnifiedMessages(session, 2);
    expect(turn1[0].type).toBe("assistant");
    expect(turn1[1].type).toBe("result");

    // Send second user message
    session.send(createUserMessage("Turn 2"));
    await tick();

    // Verify the input message was consumed by the mock's prompt iterable
    expect(currentMock.inputMessages.length).toBeGreaterThanOrEqual(1);
    const lastInput = currentMock.inputMessages[currentMock.inputMessages.length - 1] as {
      type: string;
      message: { content: string };
    };
    expect(lastInput.type).toBe("user");
    expect(lastInput.message.content).toBe("Turn 2");

    // Simulate second response
    currentMock.push(sdkAssistant("Response 2"));
    currentMock.push(sdkResult());
    currentMock.finish();

    const turn2 = await collectUnifiedMessages(session, 2);
    expect(turn2[0].type).toBe("assistant");
    expect(turn2[0].content).toEqual([{ type: "text", text: "Response 2" }]);
    expect(turn2[1].type).toBe("result");
  });

  // -------------------------------------------------------------------------
  // 3. Permission flow — approve
  // -------------------------------------------------------------------------

  it("permission flow: approve resolves canUseTool with allow", async () => {
    currentMock = createControllableMock();
    session = await createSession();

    currentMock.push(sdkSystemInit());
    await waitForUnifiedMessageType(session, "session_init");

    // Wait for canUseTool to be captured
    await tick();
    expect(currentMock.canUseTool).not.toBeNull();

    // Simulate the SDK calling canUseTool
    const permissionPromise = currentMock.canUseTool!(
      "Bash",
      { command: "ls" },
      {
        signal: new AbortController().signal,
        toolUseID: "tu-1",
        agentID: "agent-1",
      },
    );

    // Wait for the permission_request to arrive
    const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");
    expect(permReq.metadata.tool_name).toBe("Bash");
    expect(permReq.metadata.input).toEqual({ command: "ls" });
    expect(permReq.metadata.request_id).toBe("tu-1");

    // Send approval
    session.send(
      createPermissionResponse("allow", permReq.id, {
        request_id: "tu-1",
        approved: true,
      }),
    );

    const decision = (await permissionPromise) as { behavior: string; updatedInput?: unknown };
    expect(decision.behavior).toBe("allow");
  });

  // -------------------------------------------------------------------------
  // 4. Permission flow — deny
  // -------------------------------------------------------------------------

  it("permission flow: deny resolves canUseTool with deny and message", async () => {
    currentMock = createControllableMock();
    session = await createSession();

    currentMock.push(sdkSystemInit());
    await waitForUnifiedMessageType(session, "session_init");
    await tick();

    const permissionPromise = currentMock.canUseTool!(
      "Bash",
      { command: "rm -rf /" },
      {
        signal: new AbortController().signal,
        toolUseID: "tu-2",
      },
    );

    const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");

    // Deny with a reason
    session.send(
      createPermissionResponse("deny", permReq.id, {
        request_id: "tu-2",
        approved: false,
        message: "Too dangerous",
      }),
    );

    const decision = (await permissionPromise) as { behavior: string; message?: string };
    expect(decision.behavior).toBe("deny");
    expect(decision.message).toBe("Too dangerous");
  });

  // -------------------------------------------------------------------------
  // 5. Permission flow — with updatedInput
  // -------------------------------------------------------------------------

  it("permission flow: approve with updatedInput passes through", async () => {
    currentMock = createControllableMock();
    session = await createSession();

    currentMock.push(sdkSystemInit());
    await waitForUnifiedMessageType(session, "session_init");
    await tick();

    const permissionPromise = currentMock.canUseTool!(
      "Bash",
      { command: "ls" },
      {
        signal: new AbortController().signal,
        toolUseID: "tu-3",
      },
    );

    const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");

    // Approve with modified input
    session.send(
      createPermissionResponse("allow", permReq.id, {
        request_id: "tu-3",
        approved: true,
        updated_input: { command: "ls -la" },
      }),
    );

    const decision = (await permissionPromise) as {
      behavior: string;
      updatedInput?: Record<string, unknown>;
    };
    expect(decision.behavior).toBe("allow");
    expect(decision.updatedInput).toEqual({ command: "ls -la" });
  });

  // -------------------------------------------------------------------------
  // 6. Interrupt
  // -------------------------------------------------------------------------

  it("interrupt calls mock.interrupt()", async () => {
    currentMock = createControllableMock();
    session = await createSession();

    currentMock.push(sdkSystemInit());
    await waitForUnifiedMessageType(session, "session_init");

    // Start streaming
    currentMock.push(sdkStreamEvent("partial..."));
    await collectUnifiedMessages(session, 1);

    // Send interrupt
    session.send(createInterruptMessage());
    await tick();

    expect(currentMock.interruptCalled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 7. Error during stream
  // -------------------------------------------------------------------------

  it("error during stream emits error result", async () => {
    currentMock = createControllableMock();
    session = await createSession();

    currentMock.push(sdkSystemInit());
    await waitForUnifiedMessageType(session, "session_init");

    // Push a partial message then fail
    currentMock.push(sdkStreamEvent("partial"));

    const msgs: UnifiedMessage[] = [];
    const streamEvent = await collectUnifiedMessages(session, 1);
    msgs.push(...streamEvent);
    expect(msgs[0].type).toBe("stream_event");

    // Fail the stream
    currentMock.fail(new Error("SDK crashed"));

    const { target: result } = await waitForUnifiedMessageType(session, "result");
    expect(result.metadata.status).toBe("failed");
    expect(result.metadata.is_error).toBe(true);
    expect(result.metadata.error).toBe("SDK crashed");
  });

  // -------------------------------------------------------------------------
  // 8. Close mid-stream
  // -------------------------------------------------------------------------

  it("close mid-stream terminates the stream", async () => {
    currentMock = createControllableMock();
    session = await createSession();

    currentMock.push(sdkSystemInit());
    await waitForUnifiedMessageType(session, "session_init");

    currentMock.push(sdkStreamEvent("partial..."));
    await collectUnifiedMessages(session, 1);

    // Close the session
    await session.close();

    expect(currentMock.closeCalled).toBe(true);

    // Subsequent sends should throw
    expect(() => session!.send(createUserMessage("after close"))).toThrow("Session is closed");

    session = undefined; // already closed
  });

  // -------------------------------------------------------------------------
  // 9. SDK-only system messages
  // -------------------------------------------------------------------------

  describe("SDK-only system messages", () => {
    it("hook_started → status_change with hook metadata", async () => {
      currentMock = createControllableMock();
      session = await createSession();

      currentMock.push(sdkSystemInit());
      await waitForUnifiedMessageType(session, "session_init");

      currentMock.push(sdkHookStarted("gofmt"));

      const { target: msg } = await waitForUnifiedMessageType(session, "status_change");
      expect(msg.metadata.status).toBe("hook_started");
      expect(msg.metadata.hook_name).toBe("gofmt");
      expect(msg.metadata.hook_event).toBe("PreToolUse");
    });

    it("hook_progress → status_change with output", async () => {
      currentMock = createControllableMock();
      session = await createSession();

      currentMock.push(sdkSystemInit());
      await waitForUnifiedMessageType(session, "session_init");

      currentMock.push(sdkHookProgress("gofmt"));

      const { target: msg } = await waitForUnifiedMessageType(session, "status_change");
      expect(msg.metadata.status).toBe("hook_progress");
      expect(msg.metadata.hook_name).toBe("gofmt");
      expect(msg.metadata.stdout).toBe("hook output");
    });

    it("hook_response → status_change with exit_code", async () => {
      currentMock = createControllableMock();
      session = await createSession();

      currentMock.push(sdkSystemInit());
      await waitForUnifiedMessageType(session, "session_init");

      currentMock.push(sdkHookResponse("gofmt"));

      const { target: msg } = await waitForUnifiedMessageType(session, "status_change");
      expect(msg.metadata.status).toBe("hook_response");
      expect(msg.metadata.hook_name).toBe("gofmt");
      expect(msg.metadata.exit_code).toBe(0);
      expect(msg.metadata.outcome).toBe("approve");
    });

    it("task_started → status_change with task metadata", async () => {
      currentMock = createControllableMock();
      session = await createSession();

      currentMock.push(sdkSystemInit());
      await waitForUnifiedMessageType(session, "session_init");

      currentMock.push(sdkTaskStarted("task-42"));

      const { target: msg } = await waitForUnifiedMessageType(session, "status_change");
      expect(msg.metadata.status).toBe("task_started");
      expect(msg.metadata.task_id).toBe("task-42");
      expect(msg.metadata.description).toBe("Running task");
    });

    it("task_notification → status_change with task status", async () => {
      currentMock = createControllableMock();
      session = await createSession();

      currentMock.push(sdkSystemInit());
      await waitForUnifiedMessageType(session, "session_init");

      currentMock.push(sdkTaskNotification("task-42"));

      const { target: msg } = await waitForUnifiedMessageType(session, "status_change");
      expect(msg.metadata.status).toBe("task_notification");
      expect(msg.metadata.task_id).toBe("task-42");
      expect(msg.metadata.task_status).toBe("completed");
      expect(msg.metadata.summary).toBe("Task finished");
    });

    it("compact_boundary → status_change with compact metadata", async () => {
      currentMock = createControllableMock();
      session = await createSession();

      currentMock.push(sdkSystemInit());
      await waitForUnifiedMessageType(session, "session_init");

      currentMock.push(sdkCompactBoundary());

      const { target: msg } = await waitForUnifiedMessageType(session, "status_change");
      expect(msg.metadata.status).toBe("compact_boundary");
      expect(msg.metadata.compact_metadata).toEqual({
        tokens_before: 5000,
        tokens_after: 2000,
      });
    });

    it("files_persisted → status_change with file list", async () => {
      currentMock = createControllableMock();
      session = await createSession();

      currentMock.push(sdkSystemInit());
      await waitForUnifiedMessageType(session, "session_init");

      currentMock.push(sdkFilesPersisted());

      const { target: msg } = await waitForUnifiedMessageType(session, "status_change");
      expect(msg.metadata.status).toBe("files_persisted");
      expect(msg.metadata.files).toEqual(["/tmp/test.txt"]);
      expect(msg.metadata.failed).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 10. Backend session ID capture
  // -------------------------------------------------------------------------

  it("captures backendSessionId from system:init", async () => {
    currentMock = createControllableMock();

    const { AgentSdkSession } = await import("../adapters/agent-sdk/agent-sdk-session.js");
    const agentSession = await AgentSdkSession.create({
      sessionId: "e2e-backend-id",
    });
    session = agentSession;

    currentMock.push(sdkSystemInit({ session_id: "backend-123" }));
    await waitForUnifiedMessageType(session, "session_init");
    await tick();

    expect(agentSession.backendSessionId).toBe("backend-123");
  });

  // -------------------------------------------------------------------------
  // 11. Resume support
  // -------------------------------------------------------------------------

  it("resume passes backendSessionId to SDK options", async () => {
    currentMock = createControllableMock();
    session = await createSession({
      resume: true,
      backendSessionId: "resume-id",
    });

    // Verify the captured options contain the resume ID
    expect(currentMock.capturedOptions.resume).toBe("resume-id");

    // Push init to avoid hanging
    currentMock.push(sdkSystemInit());
    currentMock.finish();
  });

  // -------------------------------------------------------------------------
  // 12. Send after close throws
  // -------------------------------------------------------------------------

  it("send after close throws 'Session is closed'", async () => {
    currentMock = createControllableMock();
    session = await createSession();

    currentMock.push(sdkSystemInit());
    await waitForUnifiedMessageType(session, "session_init");

    await session.close();

    expect(() => session!.send(createUserMessage("after close"))).toThrow("Session is closed");
    session = undefined; // already closed
  });

  // -------------------------------------------------------------------------
  // 13. sendRaw throws
  // -------------------------------------------------------------------------

  it("sendRaw throws 'does not support raw NDJSON'", async () => {
    currentMock = createControllableMock();
    session = await createSession();

    expect(() => session!.sendRaw("raw data")).toThrow("does not support raw NDJSON");
  });
});
