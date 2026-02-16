/**
 * AcpAdapter e2e tests — exercises AcpAdapter.connect() through full
 * conversation flows using mock subprocess infrastructure.
 *
 * Uses MessageReader to ensure a single iterator per test, since AcpSession
 * creates independent state per iterator call.
 */

import { afterEach, describe, expect, it } from "vitest";
import { AcpAdapter, type SpawnFn } from "../adapters/acp/acp-adapter.js";
import type { BackendSession } from "../core/interfaces/backend-adapter.js";
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

describe("E2E: AcpAdapter", () => {
  let session: BackendSession | undefined;

  afterEach(async () => {
    if (session) {
      await session.close();
      session = undefined;
    }
  });

  function createAdapter(setupStdin: (stdin: MockStream, stdout: MockStream) => void): AcpAdapter {
    const spawnFn: SpawnFn = ((_command: string, _args: string[]) => {
      const { child, stdin, stdout } = createMockChild();
      setupStdin(stdin, stdout);
      return child;
    }) as unknown as SpawnFn;

    return new AcpAdapter(spawnFn);
  }

  it("full conversation flow: connect → send → receive stream chunks → result", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          sendNotification(stdout, "session/update", {
            sessionId: "e2e-session",
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello " },
          });
          sendNotification(stdout, "session/update", {
            sessionId: "e2e-session",
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "world!" },
          });
          respondToRequest(stdout, parsed.id, {
            sessionId: "e2e-session",
            stopReason: "end_turn",
          });
        },
      });
    });

    session = await adapter.connect({ sessionId: "e2e-session" });
    expect(session.sessionId).toBe("e2e-session");

    const reader = new MessageReader(session);

    // First message is session_init from initialize handshake
    const { target: initMsg } = await reader.waitFor("session_init");
    expect(initMsg.metadata.agentName).toBe("e2e-agent");

    // Send a user message
    session.send(createUserMessage("Hello"));

    // Collect stream chunks + result
    const messages = await reader.collect(3);
    expect(messages[0].type).toBe("stream_event");
    expect(messages[0].content[0]).toEqual({ type: "text", text: "Hello " });
    expect(messages[1].type).toBe("stream_event");
    expect(messages[1].content[0]).toEqual({ type: "text", text: "world!" });
    expect(messages[2].type).toBe("result");
    expect(messages[2].metadata.stopReason).toBe("end_turn");
  });

  it("multi-turn conversation", async () => {
    let promptCount = 0;

    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          promptCount++;
          sendNotification(stdout, "session/update", {
            sessionId: "e2e-session",
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Response ${promptCount}` },
          });
          respondToRequest(stdout, parsed.id, {
            sessionId: "e2e-session",
            stopReason: "end_turn",
          });
        },
      });
    });

    session = await adapter.connect({ sessionId: "e2e-session" });
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    // Turn 1
    session.send(createUserMessage("First message"));
    const turn1 = await reader.collect(2);
    expect(turn1[0].type).toBe("stream_event");
    expect(turn1[0].content[0]).toEqual({ type: "text", text: "Response 1" });
    expect(turn1[1].type).toBe("result");

    // Turn 2
    session.send(createUserMessage("Second message"));
    const turn2 = await reader.collect(2);
    expect(turn2[0].type).toBe("stream_event");
    expect(turn2[0].content[0]).toEqual({ type: "text", text: "Response 2" });
    expect(turn2[1].type).toBe("result");

    expect(promptCount).toBe(2);
  });

  it("permission request → allow", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (_parsed) => {
          sendJsonRpcRequest(stdout, 100, "session/request_permission", {
            sessionId: "e2e-session",
            toolCall: { toolCallId: "tc-1", name: "bash", command: "ls" },
            options: [
              { optionId: "allow-once", name: "Allow Once", kind: "allow" },
              { optionId: "reject-once", name: "Reject Once", kind: "deny" },
            ],
          });
        },
      });
    });

    session = await adapter.connect({ sessionId: "e2e-session" });
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("Do something"));

    const { target: permReq } = await reader.waitFor("permission_request");
    expect(permReq.metadata.toolCall).toBeDefined();
    expect((permReq.metadata.toolCall as { name: string }).name).toBe("bash");

    session.send(createPermissionResponse("allow", permReq.id, { optionId: "allow-once" }));
  });

  it("permission request → deny", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (_parsed) => {
          sendJsonRpcRequest(stdout, 100, "session/request_permission", {
            sessionId: "e2e-session",
            toolCall: { toolCallId: "tc-2", name: "write", path: "/etc/passwd" },
            options: [
              { optionId: "allow-once", name: "Allow Once", kind: "allow" },
              { optionId: "reject-once", name: "Reject Once", kind: "deny" },
            ],
          });
        },
      });
    });

    session = await adapter.connect({ sessionId: "e2e-session" });
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("Do something dangerous"));

    const { target: permReq } = await reader.waitFor("permission_request");

    session.send(createPermissionResponse("deny", permReq.id, { optionId: "reject-once" }));
  });

  it("resume session sends session/load", async () => {
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
            setTimeout(() => respondToRequest(stdout, parsed.id, { sessionId: "e2e-session" }), 0);
          }
        } catch {
          // ignore
        }
        return true;
      };
    });

    session = await adapter.connect({ sessionId: "e2e-session", resume: true });
    expect(receivedMethod).toBe("session/load");
  });

  it("subprocess crash during conversation ends stream gracefully", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: () => {
          sendNotification(stdout, "session/update", {
            sessionId: "e2e-session",
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "partial..." },
          });
          setTimeout(() => {
            stdout.emit("close");
          }, 10);
        },
      });
    });

    session = await adapter.connect({ sessionId: "e2e-session" });
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("trigger crash"));

    const messages = await reader.collect(2, 2000);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].type).toBe("stream_event");
  });

  it("subprocess crash during handshake rejects connect()", async () => {
    const adapter = createAdapter((_stdin, stdout) => {
      setTimeout(() => stdout.emit("close"), 5);
    });

    await expect(adapter.connect({ sessionId: "e2e-session" })).rejects.toThrow();
  });

  it("send after close throws", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout);
    });

    session = await adapter.connect({ sessionId: "e2e-session" });
    await session.close();

    expect(() => session!.send(createUserMessage("after close"))).toThrow("Session is closed");
    session = undefined; // already closed
  });
});
