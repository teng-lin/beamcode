/**
 * AgentSdkAdapter compliance test — runs the BackendAdapter compliance suite
 * against a wrapper that mocks the Agent SDK's query function.
 *
 * The mock query function yields a system:init message followed by echoed
 * assistant messages for any user input, satisfying the compliance suite's
 * send-then-receive expectations.
 */

import { vi } from "vitest";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";
import { runBackendAdapterComplianceTests } from "../../core/interfaces/backend-adapter-compliance.js";
import { AgentSdkSession } from "./agent-sdk-session.js";

// ---------------------------------------------------------------------------
// Mock the Agent SDK to echo user messages as assistant responses
// ---------------------------------------------------------------------------

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ prompt }: { prompt: string | AsyncIterable<unknown>; options?: unknown }) => {
    const messages: Record<string, unknown>[] = [];
    let closed = false;
    let waitResolve: ((val: IteratorResult<Record<string, unknown>>) => void) | null = null;

    // Start with system:init
    messages.push({
      type: "system",
      subtype: "init",
      cwd: "/test",
      session_id: "compliance-backend",
      tools: ["Bash"],
      mcp_servers: [],
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      apiKeySource: "user",
      claude_code_version: "1.0.0",
      slash_commands: [],
      skills: [],
      output_style: "concise",
      uuid: "00000000-0000-0000-0000-000000000001",
    });

    // If prompt is an async iterable, consume it and echo as assistant messages
    if (
      typeof prompt !== "string" &&
      prompt != null &&
      Symbol.asyncIterator in (prompt as object)
    ) {
      void (async () => {
        try {
          for await (const _userMsg of prompt as AsyncIterable<unknown>) {
            if (closed) break;
            const echoMsg = {
              type: "assistant",
              message: {
                id: `msg-${Date.now()}`,
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [{ type: "text", text: "echo" }],
                stop_reason: "end_turn",
                usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                },
              },
              parent_tool_use_id: null,
              uuid: crypto.randomUUID(),
              session_id: "compliance-backend",
            };
            messages.push(echoMsg);
            if (waitResolve) {
              const r = waitResolve;
              waitResolve = null;
              r({ value: echoMsg, done: false });
            }
          }
        } catch {
          // Input stream closed
        }
      })();
    }

    const generator = {
      async next(): Promise<IteratorResult<Record<string, unknown>>> {
        if (closed)
          return { value: undefined, done: true } as IteratorResult<Record<string, unknown>>;
        const queued = messages.shift();
        if (queued) return { value: queued, done: false };
        if (closed)
          return { value: undefined, done: true } as IteratorResult<Record<string, unknown>>;
        return new Promise((resolve) => {
          waitResolve = resolve;
        });
      },
      async return(): Promise<IteratorResult<Record<string, unknown>>> {
        closed = true;
        if (waitResolve) {
          waitResolve({ value: undefined, done: true } as IteratorResult<Record<string, unknown>>);
          waitResolve = null;
        }
        return { value: undefined, done: true } as IteratorResult<Record<string, unknown>>;
      },
      async throw(err: unknown): Promise<never> {
        closed = true;
        throw err;
      },
      close() {
        closed = true;
        if (waitResolve) {
          waitResolve({ value: undefined, done: true } as IteratorResult<Record<string, unknown>>);
          waitResolve = null;
        }
      },
      async interrupt() {
        // no-op for compliance
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    return generator;
  }),
}));

// ---------------------------------------------------------------------------
// Compliance wrapper
// ---------------------------------------------------------------------------

class ComplianceAgentSdkAdapter implements BackendAdapter {
  readonly name = "agent-sdk";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: true,
  };

  async connect(options: ConnectOptions): Promise<BackendSession> {
    return AgentSdkSession.create(options);
  }
}

runBackendAdapterComplianceTests("AgentSdkAdapter", () => new ComplianceAgentSdkAdapter());
