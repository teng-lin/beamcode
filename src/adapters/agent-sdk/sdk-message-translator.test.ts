import { describe, expect, it } from "vitest";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import { translateFromSdk, translateToSdkUserMessage } from "./sdk-message-translator.js";

describe("translateFromSdk", () => {
  describe("shared types (delegated to CLI translator)", () => {
    it("translates assistant message", () => {
      const msg = {
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Hello" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000001",
        session_id: "session-1",
      };

      const result = translateFromSdk(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("assistant");
      expect(result!.role).toBe("assistant");
      expect(result!.content).toHaveLength(1);
      expect(result!.content[0]).toEqual({ type: "text", text: "Hello" });
    });

    it("translates result success message", () => {
      const msg = {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done",
        duration_ms: 1000,
        duration_api_ms: 500,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "00000000-0000-0000-0000-000000000002",
        session_id: "session-1",
      };

      const result = translateFromSdk(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("result");
      expect(result!.metadata.subtype).toBe("success");
      expect(result!.metadata.is_error).toBe(false);
    });

    it("translates stream_event message", () => {
      const msg = {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000003",
        session_id: "session-1",
      };

      const result = translateFromSdk(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("stream_event");
      expect(result!.metadata.event).toEqual(msg.event);
    });

    it("translates tool_progress message", () => {
      const msg = {
        type: "tool_progress",
        tool_use_id: "tu-1",
        tool_name: "Bash",
        parent_tool_use_id: null,
        elapsed_time_seconds: 5,
        uuid: "00000000-0000-0000-0000-000000000004",
        session_id: "session-1",
      };

      const result = translateFromSdk(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("tool_progress");
      expect(result!.metadata.tool_name).toBe("Bash");
    });

    it("translates tool_use_summary message", () => {
      const msg = {
        type: "tool_use_summary",
        summary: "Ran bash command",
        preceding_tool_use_ids: ["tu-1"],
        uuid: "00000000-0000-0000-0000-000000000005",
        session_id: "session-1",
      };

      const result = translateFromSdk(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("tool_use_summary");
      expect(result!.metadata.summary).toBe("Ran bash command");
    });

    it("translates auth_status message", () => {
      const msg = {
        type: "auth_status",
        isAuthenticating: true,
        output: ["Authenticating..."],
        uuid: "00000000-0000-0000-0000-000000000006",
        session_id: "session-1",
      };

      const result = translateFromSdk(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("auth_status");
      expect(result!.metadata.isAuthenticating).toBe(true);
    });
  });

  describe("system subtypes (shared)", () => {
    it("translates system:init message", () => {
      const msg = {
        type: "system",
        subtype: "init",
        cwd: "/home/user",
        session_id: "session-1",
        tools: ["Bash", "Read"],
        mcp_servers: [{ name: "test", status: "connected" }],
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        apiKeySource: "user",
        claude_code_version: "1.0.0",
        slash_commands: ["/compact"],
        skills: ["commit"],
        output_style: "concise",
        uuid: "00000000-0000-0000-0000-000000000007",
      };

      const result = translateFromSdk(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("session_init");
      expect(result!.metadata.session_id).toBe("session-1");
      expect(result!.metadata.tools).toEqual(["Bash", "Read"]);
      expect(result!.metadata.model).toBe("claude-sonnet-4-6");
    });

    it("translates system:status message", () => {
      const msg = {
        type: "system",
        subtype: "status",
        status: "compacting",
        uuid: "00000000-0000-0000-0000-000000000008",
        session_id: "session-1",
      };

      const result = translateFromSdk(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("status_change");
      expect(result!.metadata.status).toBe("compacting");
    });
  });

  describe("SDK-only system subtypes", () => {
    it("translates compact_boundary", () => {
      const msg = {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 50000 },
        uuid: "00000000-0000-0000-0000-000000000009",
        session_id: "session-1",
      };

      const result = translateFromSdk(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("status_change");
      expect(result!.metadata.status).toBe("compact_boundary");
      expect(result!.metadata.compact_metadata).toEqual({
        trigger: "auto",
        pre_tokens: 50000,
      });
    });

    it("translates hook_started", () => {
      const msg = {
        type: "system",
        subtype: "hook_started",
        hook_id: "hook-1",
        hook_name: "PreToolUse",
        hook_event: "PreToolUse",
        uuid: "00000000-0000-0000-0000-00000000000a",
        session_id: "session-1",
      };

      const result = translateFromSdk(msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("status_change");
      expect(result!.metadata.status).toBe("hook_started");
      expect(result!.metadata.hook_name).toBe("PreToolUse");
    });

    it("translates hook_progress", () => {
      const msg = {
        type: "system",
        subtype: "hook_progress",
        hook_id: "hook-1",
        hook_name: "PreToolUse",
        hook_event: "PreToolUse",
        stdout: "running...",
        stderr: "",
        output: "running...",
        uuid: "00000000-0000-0000-0000-00000000000b",
        session_id: "session-1",
      };

      const result = translateFromSdk(msg);
      expect(result).not.toBeNull();
      expect(result!.metadata.status).toBe("hook_progress");
      expect(result!.metadata.stdout).toBe("running...");
    });

    it("translates hook_response", () => {
      const msg = {
        type: "system",
        subtype: "hook_response",
        hook_id: "hook-1",
        hook_name: "PreToolUse",
        hook_event: "PreToolUse",
        output: "done",
        stdout: "done",
        stderr: "",
        exit_code: 0,
        outcome: "success",
        uuid: "00000000-0000-0000-0000-00000000000c",
        session_id: "session-1",
      };

      const result = translateFromSdk(msg);
      expect(result).not.toBeNull();
      expect(result!.metadata.status).toBe("hook_response");
      expect(result!.metadata.outcome).toBe("success");
    });

    it("translates task_started", () => {
      const msg = {
        type: "system",
        subtype: "task_started",
        task_id: "task-1",
        tool_use_id: "tu-1",
        description: "Running tests",
        task_type: "bash",
        uuid: "00000000-0000-0000-0000-00000000000d",
        session_id: "session-1",
      };

      const result = translateFromSdk(msg);
      expect(result).not.toBeNull();
      expect(result!.metadata.status).toBe("task_started");
      expect(result!.metadata.task_id).toBe("task-1");
    });

    it("translates task_notification", () => {
      const msg = {
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        status: "completed",
        output_file: "/tmp/output.txt",
        summary: "Tests passed",
        uuid: "00000000-0000-0000-0000-00000000000e",
        session_id: "session-1",
      };

      const result = translateFromSdk(msg);
      expect(result).not.toBeNull();
      expect(result!.metadata.status).toBe("task_notification");
      expect(result!.metadata.task_status).toBe("completed");
    });

    it("translates files_persisted", () => {
      const msg = {
        type: "system",
        subtype: "files_persisted",
        files: [{ filename: "test.ts", file_id: "f-1" }],
        failed: [],
        processed_at: "2026-02-21T00:00:00Z",
        uuid: "00000000-0000-0000-0000-00000000000f",
        session_id: "session-1",
      };

      const result = translateFromSdk(msg);
      expect(result).not.toBeNull();
      expect(result!.metadata.status).toBe("files_persisted");
      expect(result!.metadata.files).toHaveLength(1);
    });
  });

  describe("silently consumed types", () => {
    it("returns null for user echo messages", () => {
      expect(translateFromSdk({ type: "user", message: {} })).toBeNull();
    });

    it("returns null for keep_alive messages", () => {
      expect(translateFromSdk({ type: "keep_alive" })).toBeNull();
    });

    it("returns null for unknown types", () => {
      expect(translateFromSdk({ type: "completely_unknown" })).toBeNull();
    });

    it("returns null for unknown system subtypes", () => {
      expect(translateFromSdk({ type: "system", subtype: "future_subtype" })).toBeNull();
    });
  });
});

describe("translateToSdkUserMessage", () => {
  it("extracts text from user_message", () => {
    const msg = createUnifiedMessage({
      type: "user_message",
      role: "user",
      content: [{ type: "text", text: "Hello Claude" }],
    });

    expect(translateToSdkUserMessage(msg)).toBe("Hello Claude");
  });

  it("joins multiple text blocks", () => {
    const msg = createUnifiedMessage({
      type: "user_message",
      role: "user",
      content: [
        { type: "text", text: "Part 1" },
        { type: "text", text: "Part 2" },
      ],
    });

    expect(translateToSdkUserMessage(msg)).toBe("Part 1Part 2");
  });

  it("returns null for non-user_message types", () => {
    const msg = createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
    });

    expect(translateToSdkUserMessage(msg)).toBeNull();
  });

  it("returns null for empty text content", () => {
    const msg = createUnifiedMessage({
      type: "user_message",
      role: "user",
      content: [],
    });

    expect(translateToSdkUserMessage(msg)).toBeNull();
  });
});
