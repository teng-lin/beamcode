import { describe, expect, it } from "vitest";
import type {
  CLIAssistantMessage,
  CLIAuthStatusMessage,
  CLIControlRequestMessage,
  CLIControlResponseMessage,
  CLIMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  CLISystemInitMessage,
  CLISystemStatusMessage,
  CLIToolProgressMessage,
  CLIToolUseSummaryMessage,
} from "../../types/cli-messages.js";
import { translate } from "./message-translator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInitMsg(overrides?: Partial<CLISystemInitMessage>): CLISystemInitMessage {
  return {
    type: "system",
    subtype: "init",
    cwd: "/home/user/project",
    session_id: "sess-1",
    tools: ["Read", "Write", "Bash"],
    mcp_servers: [{ name: "local", status: "connected" }],
    model: "claude-sonnet-4-5-20250929",
    permissionMode: "default",
    apiKeySource: "env",
    claude_code_version: "1.0.0",
    slash_commands: ["/help", "/clear"],
    agents: ["planner"],
    skills: ["tdd"],
    output_style: "streaming",
    uuid: "uuid-init-1",
    ...overrides,
  };
}

function makeStatusMsg(overrides?: Partial<CLISystemStatusMessage>): CLISystemStatusMessage {
  return {
    type: "system",
    subtype: "status",
    status: "compacting",
    uuid: "uuid-status-1",
    session_id: "sess-1",
    ...overrides,
  };
}

function makeAssistantMsg(overrides?: Partial<CLIAssistantMessage>): CLIAssistantMessage {
  return {
    type: "assistant",
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [{ type: "text", text: "Hello world" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10,
      },
    },
    parent_tool_use_id: null,
    uuid: "uuid-asst-1",
    session_id: "sess-1",
    ...overrides,
  };
}

function makeResultMsg(overrides?: Partial<CLIResultMessage>): CLIResultMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done",
    duration_ms: 1200,
    duration_api_ms: 800,
    num_turns: 3,
    total_cost_usd: 0.05,
    stop_reason: "end_turn",
    usage: {
      input_tokens: 500,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 100,
    },
    uuid: "uuid-result-1",
    session_id: "sess-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("message-translator", () => {
  describe("system/init → session_init", () => {
    it("translates with correct type and role", () => {
      const result = translate(makeInitMsg());
      expect(result).not.toBeNull();
      expect(result!.type).toBe("session_init");
      expect(result!.role).toBe("system");
    });

    it("places all init fields in metadata, not content", () => {
      const result = translate(makeInitMsg())!;
      expect(result.content).toEqual([]);
      expect(result.metadata.model).toBe("claude-sonnet-4-5-20250929");
      expect(result.metadata.cwd).toBe("/home/user/project");
      expect(result.metadata.tools).toEqual(["Read", "Write", "Bash"]);
      expect(result.metadata.permissionMode).toBe("default");
      expect(result.metadata.apiKeySource).toBe("env");
      expect(result.metadata.claude_code_version).toBe("1.0.0");
      expect(result.metadata.mcp_servers).toEqual([{ name: "local", status: "connected" }]);
      expect(result.metadata.agents).toEqual(["planner"]);
      expect(result.metadata.slash_commands).toEqual(["/help", "/clear"]);
      expect(result.metadata.skills).toEqual(["tdd"]);
      expect(result.metadata.output_style).toBe("streaming");
      expect(result.metadata.session_id).toBe("sess-1");
      expect(result.metadata.uuid).toBe("uuid-init-1");
    });

    it("defaults agents/slash_commands/skills to empty arrays when undefined", () => {
      const msg = makeInitMsg({
        agents: undefined,
        slash_commands: undefined as unknown as string[],
        skills: undefined,
      });
      const result = translate(msg)!;
      expect(result.metadata.agents).toEqual([]);
      expect(result.metadata.slash_commands).toEqual([]);
      expect(result.metadata.skills).toEqual([]);
    });

    it("generates unique id and timestamp", () => {
      const r1 = translate(makeInitMsg())!;
      const r2 = translate(makeInitMsg())!;
      expect(r1.id).toBeTruthy();
      expect(r2.id).toBeTruthy();
      expect(r1.id).not.toBe(r2.id);
      expect(r1.timestamp).toBeGreaterThan(0);
    });
  });

  describe("system/status → status_change", () => {
    it("translates compacting status", () => {
      const result = translate(makeStatusMsg())!;
      expect(result.type).toBe("status_change");
      expect(result.role).toBe("system");
      expect(result.metadata.status).toBe("compacting");
    });

    it("translates null status", () => {
      const result = translate(makeStatusMsg({ status: null }))!;
      expect(result.metadata.status).toBeNull();
    });

    it("includes optional permissionMode", () => {
      const result = translate(makeStatusMsg({ permissionMode: "plan" }))!;
      expect(result.metadata.permissionMode).toBe("plan");
    });
  });

  describe("assistant → assistant", () => {
    it("translates text content blocks into content array", () => {
      const result = translate(makeAssistantMsg())!;
      expect(result.type).toBe("assistant");
      expect(result.role).toBe("assistant");
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({ type: "text", text: "Hello world" });
    });

    it("translates tool_use content blocks", () => {
      const msg = makeAssistantMsg({
        message: {
          ...makeAssistantMsg().message,
          content: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } }],
        },
      });
      const result = translate(msg)!;
      expect(result.content[0]).toEqual({
        type: "tool_use",
        id: "tu-1",
        name: "Read",
        input: { file_path: "/a.ts" },
      });
    });

    it("translates tool_result content blocks with string content", () => {
      const msg = makeAssistantMsg({
        message: {
          ...makeAssistantMsg().message,
          content: [
            { type: "tool_result", tool_use_id: "tu-1", content: "file contents", is_error: false },
          ],
        },
      });
      const result = translate(msg)!;
      expect(result.content[0]).toEqual({
        type: "tool_result",
        tool_use_id: "tu-1",
        content: "file contents",
        is_error: false,
      });
    });

    it("stringifies array tool_result content", () => {
      const msg = makeAssistantMsg({
        message: {
          ...makeAssistantMsg().message,
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu-1",
              content: [{ type: "text", text: "inner" }],
            },
          ],
        },
      });
      const result = translate(msg)!;
      expect(typeof (result.content[0] as { content: string }).content).toBe("string");
    });

    it("converts thinking blocks to text content", () => {
      const msg = makeAssistantMsg({
        message: {
          ...makeAssistantMsg().message,
          content: [{ type: "thinking", thinking: "Let me think..." }],
        },
      });
      const result = translate(msg)!;
      expect(result.content[0]).toEqual({ type: "text", text: "Let me think..." });
    });

    it("places usage and model in metadata", () => {
      const result = translate(makeAssistantMsg())!;
      expect(result.metadata.model).toBe("claude-sonnet-4-5-20250929");
      expect(result.metadata.usage).toEqual({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10,
      });
      expect(result.metadata.stop_reason).toBe("end_turn");
      expect(result.metadata.message_id).toBe("msg-1");
    });

    it("includes parent_tool_use_id when set", () => {
      const msg = makeAssistantMsg({ parent_tool_use_id: "ptu-1" });
      const result = translate(msg)!;
      expect(result.metadata.parent_tool_use_id).toBe("ptu-1");
    });
  });

  describe("result → result", () => {
    it("translates with all metadata fields", () => {
      const result = translate(makeResultMsg())!;
      expect(result.type).toBe("result");
      expect(result.role).toBe("system");
      expect(result.content).toEqual([]);
      expect(result.metadata.subtype).toBe("success");
      expect(result.metadata.is_error).toBe(false);
      expect(result.metadata.total_cost_usd).toBe(0.05);
      expect(result.metadata.num_turns).toBe(3);
      expect(result.metadata.duration_ms).toBe(1200);
      expect(result.metadata.duration_api_ms).toBe(800);
    });

    it("includes modelUsage when present", () => {
      const modelUsage = {
        "claude-sonnet-4-5-20250929": {
          inputTokens: 500,
          outputTokens: 200,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 0,
          contextWindow: 200000,
          maxOutputTokens: 8192,
          costUSD: 0.05,
        },
      };
      const result = translate(makeResultMsg({ modelUsage }))!;
      expect(result.metadata.modelUsage).toEqual(modelUsage);
    });

    it("includes line counts when present", () => {
      const result = translate(makeResultMsg({ total_lines_added: 42, total_lines_removed: 10 }))!;
      expect(result.metadata.total_lines_added).toBe(42);
      expect(result.metadata.total_lines_removed).toBe(10);
    });
  });

  describe("stream_event → stream_event", () => {
    it("translates with opaque event in metadata", () => {
      const msg: CLIStreamEventMessage = {
        type: "stream_event",
        event: { delta: { text: "chunk" } },
        parent_tool_use_id: "ptu-1",
        uuid: "uuid-se-1",
        session_id: "sess-1",
      };
      const result = translate(msg)!;
      expect(result.type).toBe("stream_event");
      expect(result.role).toBe("system");
      expect(result.metadata.event).toEqual({ delta: { text: "chunk" } });
      expect(result.metadata.parent_tool_use_id).toBe("ptu-1");
    });
  });

  describe("control_request → permission_request", () => {
    it("translates with tool_name, input, and suggestions", () => {
      const msg: CLIControlRequestMessage = {
        type: "control_request",
        request_id: "req-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "rm -rf /" },
          permission_suggestions: [
            {
              type: "addRules",
              rules: [{ toolName: "Bash" }],
              behavior: "allow",
              destination: "session",
            },
          ],
          description: "Run a command",
          tool_use_id: "tu-1",
          agent_id: "agent-1",
        },
      };
      const result = translate(msg)!;
      expect(result.type).toBe("permission_request");
      expect(result.role).toBe("system");
      expect(result.metadata.request_id).toBe("req-1");
      expect(result.metadata.tool_name).toBe("Bash");
      expect(result.metadata.input).toEqual({ command: "rm -rf /" });
      expect(result.metadata.description).toBe("Run a command");
      expect(result.metadata.tool_use_id).toBe("tu-1");
      expect(result.metadata.agent_id).toBe("agent-1");
      expect(result.metadata.permission_suggestions).toHaveLength(1);
    });
  });

  describe("control_response → control_response", () => {
    it("translates success response", () => {
      const msg: CLIControlResponseMessage = {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "req-1",
          response: {
            commands: [{ name: "/help", description: "Get help" }],
            models: [{ value: "claude-sonnet-4-5-20250929", displayName: "Sonnet" }],
            account: { email: "user@example.com" },
          },
        },
      };
      const result = translate(msg)!;
      expect(result.type).toBe("control_response");
      expect(result.role).toBe("system");
      expect(result.metadata.subtype).toBe("success");
      expect(result.metadata.request_id).toBe("req-1");
      const resp = result.metadata.response as Record<string, unknown>;
      expect(resp.commands).toHaveLength(1);
      expect(resp.models).toHaveLength(1);
    });

    it("translates error response", () => {
      const msg: CLIControlResponseMessage = {
        type: "control_response",
        response: {
          subtype: "error",
          request_id: "req-2",
          error: "Something went wrong",
        },
      };
      const result = translate(msg)!;
      expect(result.metadata.subtype).toBe("error");
      expect(result.metadata.error).toBe("Something went wrong");
    });
  });

  describe("tool_progress → tool_progress", () => {
    it("translates with tool details in metadata", () => {
      const msg: CLIToolProgressMessage = {
        type: "tool_progress",
        tool_use_id: "tu-1",
        tool_name: "Bash",
        parent_tool_use_id: null,
        elapsed_time_seconds: 5.2,
        uuid: "uuid-tp-1",
        session_id: "sess-1",
      };
      const result = translate(msg)!;
      expect(result.type).toBe("tool_progress");
      expect(result.role).toBe("tool");
      expect(result.metadata.tool_use_id).toBe("tu-1");
      expect(result.metadata.tool_name).toBe("Bash");
      expect(result.metadata.elapsed_time_seconds).toBe(5.2);
    });
  });

  describe("tool_use_summary → tool_use_summary", () => {
    it("translates with summary and tool_use_ids", () => {
      const msg: CLIToolUseSummaryMessage = {
        type: "tool_use_summary",
        summary: "Read 3 files",
        preceding_tool_use_ids: ["tu-1", "tu-2", "tu-3"],
        uuid: "uuid-ts-1",
        session_id: "sess-1",
      };
      const result = translate(msg)!;
      expect(result.type).toBe("tool_use_summary");
      expect(result.role).toBe("tool");
      expect(result.metadata.summary).toBe("Read 3 files");
      expect(result.metadata.tool_use_ids).toEqual(["tu-1", "tu-2", "tu-3"]);
    });
  });

  describe("auth_status → auth_status", () => {
    it("translates authenticating state", () => {
      const msg: CLIAuthStatusMessage = {
        type: "auth_status",
        isAuthenticating: true,
        output: ["Opening browser..."],
        uuid: "uuid-auth-1",
        session_id: "sess-1",
      };
      const result = translate(msg)!;
      expect(result.type).toBe("auth_status");
      expect(result.role).toBe("system");
      expect(result.metadata.isAuthenticating).toBe(true);
      expect(result.metadata.output).toEqual(["Opening browser..."]);
    });

    it("includes error when present", () => {
      const msg: CLIAuthStatusMessage = {
        type: "auth_status",
        isAuthenticating: false,
        output: [],
        error: "Auth failed",
        uuid: "uuid-auth-2",
        session_id: "sess-1",
      };
      const result = translate(msg)!;
      expect(result.metadata.error).toBe("Auth failed");
    });
  });

  describe("keep_alive → null", () => {
    it("returns null for keep_alive messages", () => {
      const msg: CLIMessage = { type: "keep_alive" };
      expect(translate(msg)).toBeNull();
    });
  });

  describe("unified message shape", () => {
    it("all translated messages have id, timestamp, type, role, content, metadata", () => {
      const messages: CLIMessage[] = [
        makeInitMsg(),
        makeStatusMsg(),
        makeAssistantMsg(),
        makeResultMsg(),
      ];
      for (const msg of messages) {
        const result = translate(msg)!;
        expect(result.id).toBeTruthy();
        expect(typeof result.timestamp).toBe("number");
        expect(result.type).toBeTruthy();
        expect(result.role).toBeTruthy();
        expect(Array.isArray(result.content)).toBe(true);
        expect(typeof result.metadata).toBe("object");
      }
    });
  });
});
