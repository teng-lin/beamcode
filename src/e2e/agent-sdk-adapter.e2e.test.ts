/**
 * AgentSdkAdapter e2e tests — exercises AgentSdkAdapter.connect() through
 * full conversation flows using scripted query functions.
 */

import { afterEach, describe, expect, it } from "vitest";
import { AgentSdkAdapter } from "../adapters/agent-sdk/agent-sdk-adapter.js";
import type { SDKMessage, SDKUserMessage } from "../adapters/agent-sdk/sdk-message-translator.js";
import type { BackendSession } from "../core/interfaces/backend-adapter.js";
import {
  collectUnifiedMessages,
  createInterruptMessage,
  createPermissionQueryFn,
  createPermissionResponse,
  createScriptedQueryFn,
  createUserMessage,
  waitForUnifiedMessageType,
} from "./helpers/backend-test-utils.js";

describe("E2E: AgentSdkAdapter", () => {
  let session: BackendSession | undefined;

  afterEach(async () => {
    if (session) {
      await session.close();
      session = undefined;
    }
  });

  it("full conversation with rich content (tool_use + text)", async () => {
    const { queryFn } = createScriptedQueryFn([
      [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tu-1", name: "read_file", input: { path: "/tmp/x" } },
            ],
          },
        } satisfies SDKMessage,
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_result", tool_use_id: "tu-1", content: "file contents here" }],
          },
        } satisfies SDKMessage,
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Here is the file content." }],
          },
        } satisfies SDKMessage,
      ],
    ]);

    const adapter = new AgentSdkAdapter(queryFn);
    session = await adapter.connect({ sessionId: "e2e-sdk" });

    session.send(createUserMessage("Read /tmp/x"));

    const messages = await collectUnifiedMessages(session, 3);
    expect(messages).toHaveLength(3);

    // First message: tool_use
    expect(messages[0].type).toBe("assistant");
    expect(messages[0].content[0].type).toBe("tool_use");

    // Second: tool_result
    expect(messages[1].type).toBe("assistant");
    expect(messages[1].content[0].type).toBe("tool_result");

    // Third: text response
    expect(messages[2].type).toBe("assistant");
    expect(messages[2].content[0]).toEqual({ type: "text", text: "Here is the file content." });
  });

  it("result message with duration and metadata", async () => {
    const { queryFn } = createScriptedQueryFn([
      [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
          },
        } satisfies SDKMessage,
        {
          type: "result",
          subtype: "success",
          result: "Task completed",
          duration_ms: 1234,
          cost_usd: 0.05,
          num_turns: 1,
        } satisfies SDKMessage,
      ],
    ]);

    const adapter = new AgentSdkAdapter(queryFn);
    session = await adapter.connect({ sessionId: "e2e-sdk" });

    session.send(createUserMessage("Do something"));

    const { target: resultMsg } = await waitForUnifiedMessageType(session, "result");
    expect(resultMsg.metadata.duration_ms).toBe(1234);
    expect(resultMsg.metadata.cost_usd).toBe(0.05);
    expect(resultMsg.metadata.num_turns).toBe(1);
    expect(resultMsg.metadata.subtype).toBe("success");
  });

  it("permission round-trip via canUseTool → allow → tool executes", async () => {
    const queryFn = createPermissionQueryFn("bash", { command: "rm -rf /" }, (decision) => {
      if (decision.behavior === "allow") {
        return [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Tool executed successfully." }],
            },
          } satisfies SDKMessage,
        ];
      }
      return [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Tool was denied." }],
          },
        } satisfies SDKMessage,
      ];
    });

    const adapter = new AgentSdkAdapter(queryFn);
    session = await adapter.connect({ sessionId: "e2e-sdk" });

    session.send(createUserMessage("Execute bash"));

    // Should receive permission_request
    const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");
    expect(permReq.metadata.toolName).toBe("bash");

    // Allow it
    session.send(createPermissionResponse("allow", permReq.metadata.requestId as string));

    // Should get success message
    const { target: response } = await waitForUnifiedMessageType(session, "assistant");
    expect(response.content[0]).toEqual({ type: "text", text: "Tool executed successfully." });
  });

  it("permission deny → tool rejected", async () => {
    const queryFn = createPermissionQueryFn("write_file", { path: "/etc/passwd" }, (decision) => {
      if (decision.behavior === "deny") {
        return [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Permission denied by user." }],
            },
          } satisfies SDKMessage,
        ];
      }
      return [];
    });

    const adapter = new AgentSdkAdapter(queryFn);
    session = await adapter.connect({ sessionId: "e2e-sdk" });

    session.send(createUserMessage("Write /etc/passwd"));

    const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");

    // Deny it
    session.send(createPermissionResponse("deny", permReq.metadata.requestId as string));

    const { target: response } = await waitForUnifiedMessageType(session, "assistant");
    expect(response.content[0]).toEqual({ type: "text", text: "Permission denied by user." });
  });

  it("abort/interrupt cancels running query", async () => {
    let abortSignal: AbortSignal | undefined;

    const queryFn = (options: {
      prompt: string | AsyncIterable<SDKUserMessage>;
      options?: Record<string, unknown>;
    }) => {
      abortSignal = options.options?.abortSignal as AbortSignal | undefined;

      return {
        async *[Symbol.asyncIterator]() {
          // Consume prompt
          if (typeof options.prompt !== "string") {
            const iter = (options.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
            await iter.next();
          }

          yield {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Starting long task..." }],
            },
          } satisfies SDKMessage;

          // Wait for abort — if we receive it, the generator should stop
          await new Promise<void>((resolve) => {
            if (abortSignal?.aborted) {
              resolve();
              return;
            }
            abortSignal?.addEventListener("abort", () => resolve());
            // Also resolve after a timeout to not hang the test
            setTimeout(resolve, 2000);
          });
        },
      };
    };

    const adapter = new AgentSdkAdapter(queryFn);
    session = await adapter.connect({ sessionId: "e2e-sdk" });

    session.send(createUserMessage("Long task"));

    // Wait for first message
    const { target: first } = await waitForUnifiedMessageType(session, "assistant");
    expect(first.content[0]).toEqual({ type: "text", text: "Starting long task..." });

    // Send interrupt
    session.send(createInterruptMessage());

    // The abort signal should have been triggered
    expect(abortSignal?.aborted).toBe(true);
  });

  it("query function error → session remains usable after queryFn throws", async () => {
    let callCount = 0;

    const queryFn = (options: {
      prompt: string | AsyncIterable<SDKUserMessage>;
      options?: Record<string, unknown>;
    }) => ({
      async *[Symbol.asyncIterator]() {
        // Consume prompt
        if (typeof options.prompt !== "string") {
          const iter = (options.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
          await iter.next();
        }

        callCount++;
        if (callCount === 1) {
          throw new Error("Simulated query error");
        }
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Recovered!" }],
          },
        } satisfies SDKMessage;
      },
    });

    const adapter = new AgentSdkAdapter(queryFn);
    session = await adapter.connect({ sessionId: "e2e-sdk" });

    // First call throws — give a moment for error to propagate
    session.send(createUserMessage("Trigger error"));
    await new Promise((r) => setTimeout(r, 50));

    // Second call should succeed
    session.send(createUserMessage("Try again"));
    const { target: msg } = await waitForUnifiedMessageType(session, "assistant");
    expect(msg.content[0]).toEqual({ type: "text", text: "Recovered!" });
  });

  it("send after close throws", async () => {
    const { queryFn } = createScriptedQueryFn([]);
    const adapter = new AgentSdkAdapter(queryFn);
    session = await adapter.connect({ sessionId: "e2e-sdk" });
    await session.close();

    expect(() => session!.send(createUserMessage("after close"))).toThrow("Session is closed");
    session = undefined; // already closed
  });

  it("missing queryFn throws descriptive error", async () => {
    const adapter = new AgentSdkAdapter();
    await expect(adapter.connect({ sessionId: "e2e-sdk" })).rejects.toThrow("queryFn is required");
  });
});
