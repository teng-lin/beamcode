/**
 * GeminiAdapter e2e tests — exercises GeminiAdapter through full conversation
 * flows using ACP mock subprocess infrastructure.
 *
 * Since GeminiAdapter delegates to AcpAdapter, these tests verify Gemini-specific
 * behavior (binary name, --experimental-acp flag) while reusing ACP mock patterns.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { SpawnFn } from "../adapters/acp/acp-adapter.js";
import { GeminiAdapter } from "../adapters/gemini/gemini-adapter.js";
import type { BackendSession } from "../core/interfaces/backend-adapter.js";
import {
  createAcpAutoResponder,
  createInterruptMessage,
  createMockChild,
  createPermissionResponse,
  createUserMessage,
  MessageReader,
  type MockStream,
  respondToRequest,
  sendJsonRpcRequest,
  sendNotification,
} from "./helpers/backend-test-utils.js";

describe("E2E: GeminiAdapter", () => {
  let session: BackendSession | undefined;
  let spawnCalls: Array<{ command: string; args: string[] }>;

  function createAdapter(
    setupStdin: (stdin: MockStream, stdout: MockStream) => void,
    options?: { geminiBinary?: string },
  ): GeminiAdapter {
    spawnCalls = [];
    const spawnFn: SpawnFn = ((command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      const { child, stdin, stdout } = createMockChild();
      setupStdin(stdin, stdout);
      return child;
    }) as unknown as SpawnFn;

    return new GeminiAdapter({ spawnFn, geminiBinary: options?.geminiBinary });
  }

  afterEach(async () => {
    if (session) {
      await session.close();
      session = undefined;
    }
  });

  it("spawns gemini --experimental-acp and completes full streaming turn", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          sendNotification(stdout, "session/update", {
            sessionId: "e2e-gemini",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Hello " },
            },
          });
          sendNotification(stdout, "session/update", {
            sessionId: "e2e-gemini",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "world!" },
            },
          });
          respondToRequest(stdout, parsed.id, {
            sessionId: "e2e-gemini",
            stopReason: "end_turn",
          });
        },
      });
    });

    session = await adapter.connect({ sessionId: "e2e-gemini" });

    // Verify gemini binary and --experimental-acp flag
    expect(spawnCalls[0].command).toBe("gemini");
    expect(spawnCalls[0].args).toContain("--experimental-acp");

    const reader = new MessageReader(session);

    const { target: initMsg } = await reader.waitFor("session_init");
    expect(initMsg.metadata.agentName).toBe("e2e-agent");

    session.send(createUserMessage("Hello Gemini"));

    const messages = await reader.collect(4);
    expect(messages[0].type).toBe("stream_event");
    expect(messages[0].content[0]).toEqual({ type: "text", text: "Hello " });
    expect(messages[1].type).toBe("stream_event");
    expect(messages[1].content[0]).toEqual({ type: "text", text: "world!" });
    expect(messages[2].type).toBe("assistant");
    expect(messages[3].type).toBe("result");
    expect(messages[3].metadata.stopReason).toBe("end_turn");
  });

  it("uses custom geminiBinary", async () => {
    const adapter = createAdapter(
      (stdin, stdout) => {
        createAcpAutoResponder(stdin, stdout);
      },
      { geminiBinary: "/custom/gemini-dev" },
    );

    session = await adapter.connect({ sessionId: "e2e-gemini" });
    expect(spawnCalls[0].command).toBe("/custom/gemini-dev");
    expect(spawnCalls[0].args).toContain("--experimental-acp");
  });

  it("multi-turn conversation", async () => {
    let promptCount = 0;

    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          promptCount++;
          sendNotification(stdout, "session/update", {
            sessionId: "e2e-gemini",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Response ${promptCount}` },
            },
          });
          respondToRequest(stdout, parsed.id, {
            sessionId: "e2e-gemini",
            stopReason: "end_turn",
          });
        },
      });
    });

    session = await adapter.connect({ sessionId: "e2e-gemini" });
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    // Turn 1
    session.send(createUserMessage("Turn 1"));
    const turn1 = await reader.collect(3);
    expect(turn1[0].type).toBe("stream_event");
    expect(turn1[0].content[0]).toEqual({ type: "text", text: "Response 1" });
    expect(turn1[1].type).toBe("assistant");
    expect(turn1[2].type).toBe("result");

    // Turn 2
    session.send(createUserMessage("Turn 2"));
    const turn2 = await reader.collect(3);
    expect(turn2[0].type).toBe("stream_event");
    expect(turn2[0].content[0]).toEqual({ type: "text", text: "Response 2" });
    expect(turn2[1].type).toBe("assistant");
    expect(turn2[2].type).toBe("result");

    expect(promptCount).toBe(2);
  });

  it("permission: tool-call → approve", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: () => {
          sendJsonRpcRequest(stdout, 100, "session/request_permission", {
            sessionId: "e2e-gemini",
            toolCall: { toolCallId: "tc-1", name: "bash", command: "ls" },
            options: [
              { optionId: "allow-once", name: "Allow Once", kind: "allow" },
              { optionId: "reject-once", name: "Reject Once", kind: "deny" },
            ],
          });
        },
      });
    });

    session = await adapter.connect({ sessionId: "e2e-gemini" });
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("Run a command"));

    const { target: permReq } = await reader.waitFor("permission_request");
    expect(permReq.metadata.tool_use_id).toBe("tc-1");

    session.send(createPermissionResponse("allow", permReq.id, { optionId: "allow-once" }));
  });

  it("cancel sends session/cancel notification", async () => {
    let cancelReceived = false;

    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout, {
        onPrompt: (parsed) => {
          sendNotification(stdout, "session/update", {
            sessionId: "e2e-gemini",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "working..." },
            },
          });
          respondToRequest(stdout, parsed.id, {
            sessionId: "e2e-gemini",
            stopReason: "end_turn",
          });
        },
      });

      // Watch for cancel notification
      const origWrite = stdin.write.bind(stdin);
      const wrappedWrite = stdin.write;
      stdin.write = (data: string): boolean => {
        const result = wrappedWrite.call(stdin, data);
        try {
          const parsed = JSON.parse(data.trim());
          if (parsed.method === "session/cancel") cancelReceived = true;
        } catch {
          // ignore
        }
        return result;
      };
    });

    session = await adapter.connect({ sessionId: "e2e-gemini" });
    const reader = new MessageReader(session);
    await reader.waitFor("session_init");

    session.send(createUserMessage("Start something"));
    await reader.collect(2); // stream + result

    session.send(createInterruptMessage());
    // Allow async processing
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelReceived).toBe(true);
  });

  it("subprocess crash during handshake rejects connect()", async () => {
    const adapter = createAdapter((_stdin, stdout) => {
      setTimeout(() => stdout.emit("close"), 5);
    });

    await expect(adapter.connect({ sessionId: "e2e-gemini" })).rejects.toThrow();
  });

  it("send after close throws", async () => {
    const adapter = createAdapter((stdin, stdout) => {
      createAcpAutoResponder(stdin, stdout);
    });

    session = await adapter.connect({ sessionId: "e2e-gemini" });
    await session.close();

    expect(() => session!.send(createUserMessage("after close"))).toThrow("Session is closed");
    session = undefined;
  });
});
