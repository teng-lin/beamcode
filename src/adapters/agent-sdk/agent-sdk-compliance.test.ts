/**
 * AgentSdkAdapter compliance test — runs the BackendAdapter compliance
 * suite against AgentSdkAdapter with an echo query function.
 */

import { runBackendAdapterComplianceTests } from "../../core/interfaces/backend-adapter-compliance.js";
import { AgentSdkAdapter } from "./agent-sdk-adapter.js";
import type { QueryFn } from "./agent-sdk-session.js";
import type { SDKMessage, SDKUserMessage } from "./sdk-message-translator.js";

/**
 * Create a query function that reads one message from the prompt
 * and yields an assistant echo response. This satisfies the compliance
 * suite's send/receive tests.
 */
function createEchoQueryFn(): QueryFn {
  return ({ prompt }) => ({
    async *[Symbol.asyncIterator]() {
      if (typeof prompt === "string") {
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `echo: ${prompt}` }],
          },
        } satisfies SDKMessage;
      } else {
        const iter = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        const { value, done } = await iter.next();
        if (!done && value) {
          yield {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "echo" }],
            },
          } satisfies SDKMessage;
        }
      }
    },
  });
}

runBackendAdapterComplianceTests("AgentSdkAdapter", () => new AgentSdkAdapter(createEchoQueryFn()));
