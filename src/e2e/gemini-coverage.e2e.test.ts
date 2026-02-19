/**
 * GeminiAdapter coverage expansion tests — exercises edge cases, concurrent
 * behavior, and untested code paths using ACP mock subprocess infrastructure.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnFn } from "../adapters/acp/acp-adapter.js";
import { GeminiAdapter } from "../adapters/gemini/gemini-adapter.js";
import type { BackendSession } from "../core/interfaces/backend-adapter.js";
import { createUnifiedMessage } from "../core/types/unified-message.js";
import {
  createAcpAutoResponder,
  createMockChild,
  createPermissionResponse,
  createUserMessage,
  MessageReader,
  type MockStream,
  respondToRequest,
  sendJsonRpcRequest,
  sendNotification,
} from "./helpers/backend-test-utils.js";

describe("E2E: GeminiAdapter Coverage Expansion", () => {
  const activeSessions: BackendSession[] = [];
  let spawnCalls: Array<{ command: string; args: string[]; pid: number }>;
  let nextPid = 1000;
  /** Track the mock child for each spawned process so tests can inspect internals. */
  let lastMockChildren: Array<{
    child: ReturnType<typeof createMockChild>["child"];
    stdout: MockStream;
  }>;

  function createAdapter(
    setupStdin: (stdin: MockStream, stdout: MockStream, pid: number) => void,
    options?: { geminiBinary?: string },
  ): GeminiAdapter {
    spawnCalls = [];
    lastMockChildren = [];
    const spawnFn: SpawnFn = ((command: string, args: string[]) => {
      const pid = nextPid++;
      spawnCalls.push({ command, args, pid });
      const { child, stdin, stdout } = createMockChild();
      (child as any).pid = pid;
      lastMockChildren.push({ child, stdout });
      setupStdin(stdin, stdout, pid);
      return child;
    }) as unknown as SpawnFn;

    return new GeminiAdapter({ spawnFn, geminiBinary: options?.geminiBinary });
  }

  afterEach(async () => {
    while (activeSessions.length > 0) {
      const session = activeSessions.pop();
      if (session) {
        await session.close();
      }
    }
  });

  // -------------------------------------------------------------------------
  // Concurrent sessions
  // -------------------------------------------------------------------------

  it("handles multiple concurrent Gemini sessions independently", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          const params = parsed.params as { sessionId?: string };
          const sid = params.sessionId ?? "unknown";
          sendNotification(stdout, "session/update", {
            sessionId: sid,
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Reply to ${sid}` },
          });
          respondToRequest(stdout, parsed.id, {
            sessionId: sid,
            stopReason: "end_turn",
          });
        },
      });
    });

    const session1 = await adapter.connect({ sessionId: "sess-1" });
    activeSessions.push(session1);
    const session2 = await adapter.connect({ sessionId: "sess-2" });
    activeSessions.push(session2);

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0].pid).not.toBe(spawnCalls[1].pid);

    const reader1 = new MessageReader(session1);
    const reader2 = new MessageReader(session2);

    await reader1.waitFor("session_init");
    await reader2.waitFor("session_init");

    session1.send(createUserMessage("ping 1", "sess-1"));
    session2.send(createUserMessage("ping 2", "sess-2"));

    const res1 = await reader1.waitFor("result");
    const res2 = await reader2.waitFor("result");

    expect(res1.target.metadata.sessionId).toBe("sess-1");
    expect(res2.target.metadata.sessionId).toBe("sess-2");
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  it("propagates backend error results to the consumer", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          const errorResponse = JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: { code: -32000, message: "Internal Gemini error" },
          });
          stdout.emit("data", Buffer.from(`${errorResponse}\n`));
        },
      });
    });

    const session = await adapter.connect({ sessionId: "err-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("cause error"));

    const { target: resultMsg } = await reader.waitFor("result");
    expect(resultMsg.metadata.stopReason).toBe("error");
    expect(resultMsg.metadata.error).toContain("Internal Gemini error");
  });

  // -------------------------------------------------------------------------
  // Malformed JSON resilience
  // -------------------------------------------------------------------------

  it("handles malformed JSON from backend gracefully", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          // Send junk first, then a valid result
          stdout.emit("data", Buffer.from("this is not json\n"));
          respondToRequest(stdout, parsed.id, {
            sessionId: "bad-json-sess",
            stopReason: "end_turn",
          });
        },
      });
    });

    const session = await adapter.connect({ sessionId: "bad-json-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("still there?"));

    // The junk is ignored and we still get the valid result
    const { target: result } = await reader.waitFor("result");
    expect(result.metadata.stopReason).toBe("end_turn");
  });

  // -------------------------------------------------------------------------
  // Subprocess lifecycle
  // -------------------------------------------------------------------------

  it("terminates subprocess on session close", async () => {
    let killed = false;
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout);
    });

    const session = await adapter.connect({ sessionId: "kill-sess" });
    // The session IS the AcpSession — access child directly
    const child = (session as any).child;
    child.on("exit", () => {
      killed = true;
    });

    await session.close();
    expect(killed).toBe(true);
  });

  it("double close is idempotent", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout);
    });

    const session = await adapter.connect({ sessionId: "dbl-close" });
    await session.close();
    // Second close should not throw
    await session.close();
  });

  // -------------------------------------------------------------------------
  // Permission deny flow
  // -------------------------------------------------------------------------

  it("permission: tool-call → deny sends reject response", async () => {
    let permissionResponseReceived: Record<string, unknown> | undefined;

    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: () => {
          sendJsonRpcRequest(stdout, 200, "session/request_permission", {
            sessionId: "deny-sess",
            toolCall: { toolCallId: "tc-deny", name: "rm", path: "/etc" },
            options: [
              { optionId: "allow-once", name: "Allow Once", kind: "allow" },
              { optionId: "reject-once", name: "Reject Once", kind: "deny" },
            ],
          });
        },
      });

      // Watch for the permission response written to stdin
      const origWrite = stdin.write.bind(stdin);
      const wrappedWrite = stdin.write;
      stdin.write = (data: string): boolean => {
        const result = wrappedWrite.call(stdin, data);
        try {
          const parsed = JSON.parse(data.trim());
          // Permission responses are JSON-RPC responses (have id, no method)
          if (parsed.id === 200 && parsed.result) {
            permissionResponseReceived = parsed.result;
          }
        } catch {
          // ignore
        }
        return result;
      };
    });

    const session = await adapter.connect({ sessionId: "deny-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("dangerous command"));
    const { target: permReq } = await reader.waitFor("permission_request");
    expect(permReq.metadata.toolCall).toBeDefined();

    session.send(createPermissionResponse("deny", permReq.id, { optionId: "reject-once" }));

    await vi.waitFor(() => expect(permissionResponseReceived).toBeDefined());
    expect((permissionResponseReceived as any).outcome.optionId).toBe("reject-once");
  });

  // -------------------------------------------------------------------------
  // Session resume
  // -------------------------------------------------------------------------

  it("resume sends session/load instead of session/new", async () => {
    let receivedMethod: string | undefined;

    const adapter = createAdapter((stdin, stdout) => {
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
                  agentInfo: { name: "e2e-agent", version: "1.0" },
                }),
              0,
            );
          } else if (parsed.method === "session/new" || parsed.method === "session/load") {
            receivedMethod = parsed.method;
            setTimeout(
              () =>
                respondToRequest(stdout, parsed.id, {
                  sessionId: "resumed-sess",
                }),
              0,
            );
          }
        } catch {
          // ignore
        }
        return true;
      };
    });

    const session = await adapter.connect({
      sessionId: "resumed-sess",
      resume: true,
    });
    activeSessions.push(session);
    expect(receivedMethod).toBe("session/load");
  });

  // -------------------------------------------------------------------------
  // Agent thought chunks
  // -------------------------------------------------------------------------

  it("agent thought chunks are surfaced as stream_event with thought metadata", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          sendNotification(stdout, "session/update", {
            sessionId: "thought-sess",
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Thinking about this..." },
          });
          sendNotification(stdout, "session/update", {
            sessionId: "thought-sess",
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Here's my answer" },
          });
          respondToRequest(stdout, parsed.id, {
            sessionId: "thought-sess",
            stopReason: "end_turn",
          });
        },
      });
    });

    const session = await adapter.connect({ sessionId: "thought-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("think about this"));

    const msgs = await reader.collect(3);
    // First: thought chunk
    expect(msgs[0].type).toBe("stream_event");
    expect(msgs[0].metadata.thought).toBe(true);
    expect(msgs[0].content[0]).toEqual({
      type: "thinking",
      thinking: "Thinking about this...",
    });
    // Second: regular message chunk
    expect(msgs[1].type).toBe("stream_event");
    expect(msgs[1].metadata.thought).toBeUndefined();
    // Third: result
    expect(msgs[2].type).toBe("result");
  });

  // -------------------------------------------------------------------------
  // Tool call notifications
  // -------------------------------------------------------------------------

  it("tool_call notifications surface as tool_progress messages", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          sendNotification(stdout, "session/update", {
            sessionId: "tool-sess",
            sessionUpdate: "tool_call",
            toolCallId: "tc-1",
            title: "Running bash",
            kind: "bash",
            status: "in_progress",
          });
          respondToRequest(stdout, parsed.id, {
            sessionId: "tool-sess",
            stopReason: "end_turn",
          });
        },
      });
    });

    const session = await adapter.connect({ sessionId: "tool-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("run something"));

    const msgs = await reader.collect(2);
    expect(msgs[0].type).toBe("tool_progress");
    expect(msgs[0].metadata.toolCallId).toBe("tc-1");
    expect(msgs[0].metadata.title).toBe("Running bash");
    expect(msgs[1].type).toBe("result");
  });

  it("tool_call_update completed surfaces as tool_use_summary", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          sendNotification(stdout, "session/update", {
            sessionId: "tool-update-sess",
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-2",
            status: "completed",
            content: "File written successfully",
          });
          respondToRequest(stdout, parsed.id, {
            sessionId: "tool-update-sess",
            stopReason: "end_turn",
          });
        },
      });
    });

    const session = await adapter.connect({ sessionId: "tool-update-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("write a file"));

    const msgs = await reader.collect(2);
    expect(msgs[0].type).toBe("tool_use_summary");
    expect(msgs[0].metadata.toolCallId).toBe("tc-2");
    expect(msgs[0].metadata.status).toBe("completed");
    expect(msgs[0].metadata.is_error).toBe(false);
    expect(msgs[1].type).toBe("result");
  });

  it("tool_call_update failed surfaces with is_error true", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          sendNotification(stdout, "session/update", {
            sessionId: "tool-fail-sess",
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-3",
            status: "failed",
            content: "Permission denied",
          });
          respondToRequest(stdout, parsed.id, {
            sessionId: "tool-fail-sess",
            stopReason: "end_turn",
          });
        },
      });
    });

    const session = await adapter.connect({ sessionId: "tool-fail-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("fail"));

    const msgs = await reader.collect(2);
    expect(msgs[0].type).toBe("tool_use_summary");
    expect(msgs[0].metadata.is_error).toBe(true);
    expect(msgs[1].type).toBe("result");
  });

  it("tool_call_update in_progress surfaces as tool_progress", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          sendNotification(stdout, "session/update", {
            sessionId: "tool-prog-sess",
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-4",
            status: "in_progress",
            content: "50% complete",
          });
          respondToRequest(stdout, parsed.id, {
            sessionId: "tool-prog-sess",
            stopReason: "end_turn",
          });
        },
      });
    });

    const session = await adapter.connect({ sessionId: "tool-prog-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("progress"));

    const msgs = await reader.collect(2);
    expect(msgs[0].type).toBe("tool_progress");
    expect(msgs[0].metadata.status).toBe("in_progress");
    expect(msgs[1].type).toBe("result");
  });

  // -------------------------------------------------------------------------
  // Configuration change
  // -------------------------------------------------------------------------

  it("configuration_change set_model sends session/set_model request", async () => {
    let setModelReceived: Record<string, unknown> | undefined;

    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout);

      const origWrite = stdin.write.bind(stdin);
      const wrappedWrite = stdin.write;
      stdin.write = (data: string): boolean => {
        const result = wrappedWrite.call(stdin, data);
        try {
          const parsed = JSON.parse(data.trim());
          if (parsed.method === "session/set_model") {
            setModelReceived = parsed.params;
            respondToRequest(stdout, parsed.id, {});
          }
        } catch {
          // ignore
        }
        return result;
      };
    });

    const session = await adapter.connect({ sessionId: "model-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(
      createUnifiedMessage({
        type: "configuration_change",
        role: "user",
        metadata: { subtype: "set_model", model: "gemini-2.0-flash" },
      }),
    );

    await vi.waitFor(() => expect(setModelReceived).toBeDefined());
    expect(setModelReceived?.model).toBe("gemini-2.0-flash");
  });

  it("configuration_change set_mode sends session/set_mode request", async () => {
    let setModeReceived: Record<string, unknown> | undefined;

    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout);

      const origWrite = stdin.write.bind(stdin);
      const wrappedWrite = stdin.write;
      stdin.write = (data: string): boolean => {
        const result = wrappedWrite.call(stdin, data);
        try {
          const parsed = JSON.parse(data.trim());
          if (parsed.method === "session/set_mode") {
            setModeReceived = parsed.params;
            respondToRequest(stdout, parsed.id, {});
          }
        } catch {
          // ignore
        }
        return result;
      };
    });

    const session = await adapter.connect({ sessionId: "mode-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(
      createUnifiedMessage({
        type: "configuration_change",
        role: "user",
        metadata: { subtype: "set_mode", modeId: "yolo" },
      }),
    );

    await vi.waitFor(() => expect(setModeReceived).toBeDefined());
    expect(setModeReceived?.modeId).toBe("yolo");
  });

  // -------------------------------------------------------------------------
  // Plan notification
  // -------------------------------------------------------------------------

  it("plan notification surfaces as status_change", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          sendNotification(stdout, "session/update", {
            sessionId: "plan-sess",
            sessionUpdate: "plan",
            planEntries: [
              { step: 1, description: "Read file" },
              { step: 2, description: "Edit code" },
            ],
          });
          respondToRequest(stdout, parsed.id, {
            sessionId: "plan-sess",
            stopReason: "end_turn",
          });
        },
      });
    });

    const session = await adapter.connect({ sessionId: "plan-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("make a plan"));

    const msgs = await reader.collect(2);
    expect(msgs[0].type).toBe("status_change");
    expect(msgs[0].metadata.planEntries).toEqual([
      { step: 1, description: "Read file" },
      { step: 2, description: "Edit code" },
    ]);
    expect(msgs[1].type).toBe("result");
  });

  // -------------------------------------------------------------------------
  // Current mode update
  // -------------------------------------------------------------------------

  it("current_mode_update surfaces as configuration_change", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          sendNotification(stdout, "session/update", {
            sessionId: "mode-update-sess",
            sessionUpdate: "current_mode_update",
            modeId: "plan",
          });
          respondToRequest(stdout, parsed.id, {
            sessionId: "mode-update-sess",
            stopReason: "end_turn",
          });
        },
      });
    });

    const session = await adapter.connect({ sessionId: "mode-update-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("switch mode"));

    const msgs = await reader.collect(2);
    expect(msgs[0].type).toBe("configuration_change");
    expect(msgs[0].metadata.modeId).toBe("plan");
    expect(msgs[1].type).toBe("result");
  });

  // -------------------------------------------------------------------------
  // Unknown session update type
  // -------------------------------------------------------------------------

  it("unknown session update type surfaces as 'unknown' message", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          sendNotification(stdout, "session/update", {
            sessionId: "unknown-sess",
            sessionUpdate: "some_future_event",
            data: { foo: "bar" },
          });
          respondToRequest(stdout, parsed.id, {
            sessionId: "unknown-sess",
            stopReason: "end_turn",
          });
        },
      });
    });

    const session = await adapter.connect({ sessionId: "unknown-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("trigger unknown"));

    const msgs = await reader.collect(2);
    expect(msgs[0].type).toBe("unknown");
    expect(msgs[0].metadata.raw).toBeDefined();
    expect(msgs[1].type).toBe("result");
  });

  // -------------------------------------------------------------------------
  // sendRaw throws
  // -------------------------------------------------------------------------

  it("sendRaw throws with unsupported error", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout);
    });

    const session = await adapter.connect({ sessionId: "raw-sess" });
    activeSessions.push(session);

    expect(() => session.sendRaw('{"test": true}')).toThrow(
      "AcpSession does not support raw NDJSON",
    );
  });

  // -------------------------------------------------------------------------
  // Agent-initiated fs/terminal requests get error response
  // -------------------------------------------------------------------------

  it("agent-initiated fs/ request gets error response", async () => {
    let errorResponseSent = false;

    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: () => {
          // Agent sends an fs/read request to the client
          sendJsonRpcRequest(stdout, 300, "fs/read", {
            path: "/some/file",
          });
        },
      });

      const origWrite = stdin.write.bind(stdin);
      const wrappedWrite = stdin.write;
      stdin.write = (data: string): boolean => {
        const result = wrappedWrite.call(stdin, data);
        try {
          const parsed = JSON.parse(data.trim());
          if (parsed.id === 300 && parsed.error) {
            errorResponseSent = true;
          }
        } catch {
          // ignore
        }
        return result;
      };
    });

    const session = await adapter.connect({ sessionId: "fs-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("trigger fs request"));

    await vi.waitFor(() => expect(errorResponseSent).toBe(true));
  });

  it("agent-initiated terminal/ request gets error response", async () => {
    let errorResponseSent = false;

    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: () => {
          sendJsonRpcRequest(stdout, 301, "terminal/execute", {
            command: "ls",
          });
        },
      });

      const origWrite = stdin.write.bind(stdin);
      const wrappedWrite = stdin.write;
      stdin.write = (data: string): boolean => {
        const result = wrappedWrite.call(stdin, data);
        try {
          const parsed = JSON.parse(data.trim());
          if (parsed.id === 301 && parsed.error) {
            errorResponseSent = true;
          }
        } catch {
          // ignore
        }
        return result;
      };
    });

    const session = await adapter.connect({ sessionId: "term-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("trigger terminal request"));

    await vi.waitFor(() => expect(errorResponseSent).toBe(true));
  });

  // -------------------------------------------------------------------------
  // cwd passthrough
  // -------------------------------------------------------------------------

  it("passes cwd from adapterOptions to spawn", async () => {
    let spawnOptions: Record<string, unknown> | undefined;

    const spawnFn: SpawnFn = ((
      command: string,
      args: string[],
      options: Record<string, unknown>,
    ) => {
      spawnOptions = options;
      spawnCalls = [];
      spawnCalls.push({ command, args, pid: 0 });
      const { child, stdin, stdout } = createMockChild();
      createAcpAutoResponder(stdin, stdout);
      return child;
    }) as unknown as SpawnFn;

    const adapter = new GeminiAdapter({ spawnFn });
    const session = await adapter.connect({
      sessionId: "cwd-sess",
      adapterOptions: { cwd: "/tmp/test-dir" },
    });
    activeSessions.push(session);

    expect(spawnOptions?.cwd).toBe("/tmp/test-dir");
  });

  // -------------------------------------------------------------------------
  // geminiBinary from adapterOptions in connect overrides constructor
  // -------------------------------------------------------------------------

  it("adapterOptions.geminiBinary in connect overrides constructor default", async () => {
    const spawnFn: SpawnFn = ((command: string, args: string[]) => {
      spawnCalls = [];
      spawnCalls.push({ command, args, pid: 0 });
      const { child, stdin, stdout } = createMockChild();
      createAcpAutoResponder(stdin, stdout);
      return child;
    }) as unknown as SpawnFn;

    const adapter = new GeminiAdapter({
      spawnFn,
      geminiBinary: "/default/gemini",
    });
    const session = await adapter.connect({
      sessionId: "bin-sess",
      adapterOptions: { geminiBinary: "/override/gemini-beta" },
    });
    activeSessions.push(session);

    expect(spawnCalls[0].command).toBe("/override/gemini-beta");
  });

  // -------------------------------------------------------------------------
  // Stream iterator return() cleanup
  // -------------------------------------------------------------------------

  it("calling return() on message iterator stops the stream", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout);
    });

    const session = await adapter.connect({ sessionId: "iter-sess" });
    activeSessions.push(session);

    const iter = session.messages[Symbol.asyncIterator]();
    // Read the init message
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value.type).toBe("session_init");

    // Explicitly return
    const returned = await iter.return!(undefined as any);
    expect(returned.done).toBe(true);

    // Subsequent next() should also return done
    const after = await iter.next();
    expect(after.done).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Unrecognized message types are silently dropped by send()
  // -------------------------------------------------------------------------

  it("send with unrecognized message type is silently ignored", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout);
    });

    const session = await adapter.connect({ sessionId: "noop-sess" });
    activeSessions.push(session);

    // "result" is an outbound-only type — inbound translator returns null
    session.send(
      createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: {},
      }),
    );
    // Should not throw
  });

  // -------------------------------------------------------------------------
  // available_commands_update notification
  // -------------------------------------------------------------------------

  it("available_commands_update surfaces as unknown message", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          sendNotification(stdout, "session/update", {
            sessionId: "cmds-sess",
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "/help", description: "Show help" },
              { name: "/clear", description: "Clear screen" },
            ],
          });
          respondToRequest(stdout, parsed.id, {
            sessionId: "cmds-sess",
            stopReason: "end_turn",
          });
        },
      });
    });

    const session = await adapter.connect({ sessionId: "cmds-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("commands"));

    const msgs = await reader.collect(2);
    expect(msgs[0].type).toBe("configuration_change");
    expect(msgs[0].metadata.availableCommands).toEqual([
      { name: "/help", description: "Show help" },
      { name: "/clear", description: "Clear screen" },
    ]);
    expect(msgs[1].type).toBe("result");
  });

  // -------------------------------------------------------------------------
  // Partial line buffering
  // -------------------------------------------------------------------------

  it("handles split JSON lines arriving in multiple chunks", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          // Send a notification split across two chunks
          const fullMsg = JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "split-sess",
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Split message" },
            },
          });
          const mid = Math.floor(fullMsg.length / 2);
          stdout.emit("data", Buffer.from(fullMsg.slice(0, mid)));
          stdout.emit("data", Buffer.from(`${fullMsg.slice(mid)}\n`));

          respondToRequest(stdout, parsed.id, {
            sessionId: "split-sess",
            stopReason: "end_turn",
          });
        },
      });
    });

    const session = await adapter.connect({ sessionId: "split-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("split test"));

    const msgs = await reader.collect(2);
    expect(msgs[0].type).toBe("stream_event");
    expect(msgs[0].content[0]).toEqual({ type: "text", text: "Split message" });
    expect(msgs[1].type).toBe("result");
  });

  // -------------------------------------------------------------------------
  // Subprocess crash during conversation
  // -------------------------------------------------------------------------

  it("subprocess crash during conversation ends stream gracefully", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: () => {
          sendNotification(stdout, "session/update", {
            sessionId: "crash-sess",
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "partial..." },
          });
          setTimeout(() => stdout.emit("close"), 10);
        },
      });
    });

    const session = await adapter.connect({ sessionId: "crash-sess" });
    activeSessions.push(session);
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("crash now"));

    const msgs = await reader.collect(1, 2000);
    expect(msgs[0].type).toBe("stream_event");
  });

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  it("exposes correct capabilities", () => {
    const adapter = createAdapter(() => {});
    expect(adapter.capabilities).toEqual({
      streaming: true,
      permissions: true,
      slashCommands: true,
      availability: "local",
      teams: false,
    });
    expect(adapter.name).toBe("gemini");
  });
});
