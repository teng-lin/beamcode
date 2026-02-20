import { describe, expect, it } from "vitest";
import type {
  AcpInitializeResult,
  AcpPermissionRequest,
  AcpPromptResult,
  AcpSessionUpdate,
} from "./outbound-translator.js";
import {
  translateAuthStatus,
  translateInitializeResult,
  translatePermissionRequest,
  translatePromptError,
  translatePromptResult,
  translateSessionUpdate,
} from "./outbound-translator.js";

// ---------------------------------------------------------------------------
// translateSessionUpdate
// ---------------------------------------------------------------------------

describe("translateSessionUpdate", () => {
  describe("agent_message_chunk → stream_event", () => {
    it("translates text chunk with correct type and role", () => {
      const update: AcpSessionUpdate = {
        sessionId: "sess-1",
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello world" },
      };
      const result = translateSessionUpdate(update);

      expect(result.type).toBe("stream_event");
      expect(result.role).toBe("assistant");
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({ type: "text", text: "Hello world" });
      expect(result.metadata.sessionId).toBe("sess-1");
    });

    it("synthesizes Claude-compatible event in metadata", () => {
      const update: AcpSessionUpdate = {
        sessionId: "sess-1",
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello world" },
      };
      const result = translateSessionUpdate(update);

      expect(result.metadata.event).toEqual({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello world" },
      });
    });

    it("produces empty content when text is absent", () => {
      const update: AcpSessionUpdate = {
        sessionId: "sess-1",
        sessionUpdate: "agent_message_chunk",
      };
      const result = translateSessionUpdate(update);

      expect(result.type).toBe("stream_event");
      expect(result.content).toEqual([]);
      expect(result.metadata.event).toBeUndefined();
    });
  });

  describe("agent_thought_chunk → stream_event (thought)", () => {
    it("translates thought chunk with thought metadata", () => {
      const update: AcpSessionUpdate = {
        sessionId: "sess-1",
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Let me think..." },
      };
      const result = translateSessionUpdate(update);

      expect(result.type).toBe("stream_event");
      expect(result.role).toBe("assistant");
      expect(result.content[0]).toEqual({ type: "thinking", thinking: "Let me think..." });
      expect(result.metadata.thought).toBe(true);
    });

    it("synthesizes Claude-compatible thinking event in metadata", () => {
      const update: AcpSessionUpdate = {
        sessionId: "sess-1",
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Let me think..." },
      };
      const result = translateSessionUpdate(update);

      expect(result.metadata.event).toEqual({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Let me think..." },
      });
    });
  });

  describe("tool_call → tool_progress", () => {
    it("translates tool call announcement", () => {
      const update: AcpSessionUpdate = {
        sessionId: "sess-1",
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Reading file",
        kind: "read",
        status: "pending",
      };
      const result = translateSessionUpdate(update);

      expect(result.type).toBe("tool_progress");
      expect(result.role).toBe("tool");
      expect(result.metadata.toolCallId).toBe("call-1");
      expect(result.metadata.title).toBe("Reading file");
      expect(result.metadata.kind).toBe("read");
      expect(result.metadata.status).toBe("pending");
    });
  });

  describe("tool_call_update (in_progress) → tool_progress", () => {
    it("translates in-progress tool update", () => {
      const update: AcpSessionUpdate = {
        sessionId: "sess-1",
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "in_progress",
        content: { type: "text", text: "Processing..." },
      };
      const result = translateSessionUpdate(update);

      expect(result.type).toBe("tool_progress");
      expect(result.role).toBe("tool");
      expect(result.metadata.toolCallId).toBe("call-1");
      expect(result.metadata.status).toBe("in_progress");
      expect(result.metadata.content).toEqual({ type: "text", text: "Processing..." });
    });

    it("defaults to in_progress when status is absent", () => {
      const update: AcpSessionUpdate = {
        sessionId: "sess-1",
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
      };
      const result = translateSessionUpdate(update);

      expect(result.type).toBe("tool_progress");
      expect(result.metadata.status).toBe("in_progress");
    });
  });

  describe("tool_call_update (completed) → tool_use_summary", () => {
    it("translates completed tool update", () => {
      const update: AcpSessionUpdate = {
        sessionId: "sess-1",
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: { type: "text", text: "File contents here" },
      };
      const result = translateSessionUpdate(update);

      expect(result.type).toBe("tool_use_summary");
      expect(result.role).toBe("tool");
      expect(result.metadata.toolCallId).toBe("call-1");
      expect(result.metadata.status).toBe("completed");
      expect(result.metadata.is_error).toBe(false);
    });
  });

  describe("tool_call_update (failed) → tool_use_summary", () => {
    it("translates failed tool update with is_error", () => {
      const update: AcpSessionUpdate = {
        sessionId: "sess-1",
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "failed",
        content: { type: "text", text: "Permission denied" },
      };
      const result = translateSessionUpdate(update);

      expect(result.type).toBe("tool_use_summary");
      expect(result.role).toBe("tool");
      expect(result.metadata.is_error).toBe(true);
      expect(result.metadata.status).toBe("failed");
    });
  });

  describe("plan → status_change", () => {
    it("translates plan with entries", () => {
      const planEntries = [
        { title: "Step 1", status: "completed" },
        { title: "Step 2", status: "in_progress" },
      ];
      const update: AcpSessionUpdate = {
        sessionId: "sess-1",
        sessionUpdate: "plan",
        planEntries,
      };
      const result = translateSessionUpdate(update);

      expect(result.type).toBe("status_change");
      expect(result.role).toBe("system");
      expect(result.metadata.planEntries).toEqual(planEntries);
    });
  });

  describe("available_commands_update → configuration_change", () => {
    it("translates as forward-compat passthrough", () => {
      const commands = [{ name: "web", description: "Search the web" }];
      const update: AcpSessionUpdate = {
        sessionId: "sess-1",
        sessionUpdate: "available_commands_update",
        availableCommands: commands,
      };
      const result = translateSessionUpdate(update);

      expect(result.type).toBe("configuration_change");
      expect(result.role).toBe("system");
      expect(result.metadata.subtype).toBe("available_commands_update");
      expect(result.metadata.availableCommands).toEqual(commands);
    });
  });

  describe("current_mode_update → configuration_change", () => {
    it("translates mode change", () => {
      const update: AcpSessionUpdate = {
        sessionId: "sess-1",
        sessionUpdate: "current_mode_update",
        modeId: "architect",
      };
      const result = translateSessionUpdate(update);

      expect(result.type).toBe("configuration_change");
      expect(result.role).toBe("system");
      expect(result.metadata.modeId).toBe("architect");
    });
  });

  describe("unknown session update type → unknown", () => {
    it("passes through unrecognized update types", () => {
      const update: AcpSessionUpdate = {
        sessionId: "sess-1",
        sessionUpdate: "future_update_type",
        someData: 42,
      };
      const result = translateSessionUpdate(update);

      expect(result.type).toBe("unknown");
      expect(result.role).toBe("system");
      expect(result.metadata.raw).toEqual(update);
    });
  });
});

// ---------------------------------------------------------------------------
// translatePermissionRequest
// ---------------------------------------------------------------------------

describe("translatePermissionRequest", () => {
  it("maps ACP toolCall fields to flat consumer-compatible names", () => {
    const request: AcpPermissionRequest = {
      sessionId: "sess-1",
      toolCall: {
        toolCallId: "call-1",
        title: "Run command",
        kind: "shell",
        rawInput: { command: "ls -la" },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Deny", kind: "reject_once" },
      ],
    };
    const result = translatePermissionRequest(request);

    expect(result.type).toBe("permission_request");
    expect(result.role).toBe("system");
    expect(result.metadata.sessionId).toBe("sess-1");
    expect(result.metadata.request_id).toBe("call-1");
    expect(result.metadata.tool_use_id).toBe("call-1");
    expect(result.metadata.tool_name).toBe("shell");
    expect(result.metadata.input).toEqual({ command: "ls -la" });
    expect(result.metadata.description).toBe("Run command");
    expect(result.metadata.options).toHaveLength(2);
  });

  it("falls back to title when kind is absent", () => {
    const request: AcpPermissionRequest = {
      sessionId: "sess-1",
      toolCall: { toolCallId: "call-2", title: "Edit file" },
      options: [],
    };
    const result = translatePermissionRequest(request);

    expect(result.metadata.tool_name).toBe("Edit file");
  });

  it("defaults tool_name to 'tool' when both kind and title are absent", () => {
    const request: AcpPermissionRequest = {
      sessionId: "sess-1",
      toolCall: { toolCallId: "call-3" },
      options: [],
    };
    const result = translatePermissionRequest(request);

    expect(result.metadata.tool_name).toBe("tool");
    expect(result.metadata.input).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// translatePromptResult
// ---------------------------------------------------------------------------

describe("translatePromptResult", () => {
  it("translates end_turn result", () => {
    const result: AcpPromptResult = {
      sessionId: "sess-1",
      stopReason: "end_turn",
    };
    const msg = translatePromptResult(result);

    expect(msg.type).toBe("result");
    expect(msg.role).toBe("system");
    expect(msg.metadata.stopReason).toBe("end_turn");
    expect(msg.metadata.sessionId).toBe("sess-1");
  });

  it("translates cancelled result", () => {
    const result: AcpPromptResult = {
      sessionId: "sess-1",
      stopReason: "cancelled",
    };
    const msg = translatePromptResult(result);
    expect(msg.metadata.stopReason).toBe("cancelled");
  });

  it("forwards extra fields in metadata", () => {
    const result: AcpPromptResult = {
      sessionId: "sess-1",
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    const msg = translatePromptResult(result);
    expect(msg.metadata.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });
});

// ---------------------------------------------------------------------------
// translateInitializeResult
// ---------------------------------------------------------------------------

describe("translateInitializeResult", () => {
  it("translates initialize result with agent info", () => {
    const result: AcpInitializeResult = {
      protocolVersion: 1,
      agentCapabilities: { streaming: true, permissions: true },
      agentInfo: { name: "goose", version: "1.2.0" },
    };
    const msg = translateInitializeResult(result);

    expect(msg.type).toBe("session_init");
    expect(msg.role).toBe("system");
    expect(msg.metadata.protocolVersion).toBe(1);
    expect(msg.metadata.agentCapabilities).toEqual({ streaming: true, permissions: true });
    expect(msg.metadata.agentName).toBe("goose");
    expect(msg.metadata.agentVersion).toBe("1.2.0");
  });

  it("handles missing agent info", () => {
    const result: AcpInitializeResult = {
      protocolVersion: 1,
      agentCapabilities: {},
    };
    const msg = translateInitializeResult(result);

    expect(msg.metadata.agentName).toBeUndefined();
    expect(msg.metadata.agentVersion).toBeUndefined();
  });

  it("includes authMethods when present", () => {
    const result: AcpInitializeResult = {
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [
        { id: "oauth-personal", name: "Log in with Google" },
        {
          id: "gemini-api-key",
          name: "Use Gemini API key",
          description: "Requires GEMINI_API_KEY",
        },
      ],
    };
    const msg = translateInitializeResult(result);

    expect(msg.metadata.authMethods).toEqual([
      { id: "oauth-personal", name: "Log in with Google" },
      { id: "gemini-api-key", name: "Use Gemini API key", description: "Requires GEMINI_API_KEY" },
    ]);
  });

  it("omits authMethods when not present", () => {
    const result: AcpInitializeResult = {
      protocolVersion: 1,
      agentCapabilities: {},
    };
    const msg = translateInitializeResult(result);

    expect(msg.metadata.authMethods).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// translatePromptError
// ---------------------------------------------------------------------------

describe("translatePromptError", () => {
  it("defaults to api_error without a classifier", () => {
    const msg = translatePromptError("sess-1", {
      code: 500,
      message: "Verify your account to continue.",
    });

    expect(msg.type).toBe("result");
    expect(msg.metadata.stopReason).toBe("error");
    expect(msg.metadata.error_code).toBe("api_error");
    expect(msg.metadata.error_message).toBe("Verify your account to continue.");
  });

  it("uses provided classifier when given", () => {
    const classify = (code: number, _msg: string) => (code === 401 ? "provider_auth" : "unknown");
    const msg = translatePromptError("sess-1", { code: 401, message: "Unauthorized" }, classify);
    expect(msg.metadata.error_code).toBe("provider_auth");
  });

  it("preserves error data when present", () => {
    const msg = translatePromptError("sess-1", {
      code: 500,
      message: "Internal error",
      data: { details: "Session not found: abc" },
    });

    expect(msg.metadata.error_code).toBe("api_error");
    expect(msg.metadata.error_data).toEqual({ details: "Session not found: abc" });
  });

  it("omits error_data when not present", () => {
    const msg = translatePromptError("sess-1", {
      code: 500,
      message: "Internal error",
    });
    expect(msg.metadata.error_data).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// translateAuthStatus
// ---------------------------------------------------------------------------

describe("translateAuthStatus", () => {
  it("creates auth_status message with error", () => {
    const msg = translateAuthStatus("sess-1", "Verify your account to continue.");

    expect(msg.type).toBe("auth_status");
    expect(msg.role).toBe("system");
    expect(msg.metadata.sessionId).toBe("sess-1");
    expect(msg.metadata.isAuthenticating).toBe(false);
    expect(msg.metadata.output).toEqual([]);
    expect(msg.metadata.error).toBe("Verify your account to continue.");
  });
});

// ---------------------------------------------------------------------------
// Unified message shape
// ---------------------------------------------------------------------------

describe("unified message shape", () => {
  it("all translated messages have id, timestamp, type, role, content, metadata", () => {
    const messages = [
      translateSessionUpdate({
        sessionId: "s",
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
      }),
      translatePermissionRequest({
        sessionId: "s",
        toolCall: { toolCallId: "c" },
        options: [],
      }),
      translatePromptResult({ sessionId: "s", stopReason: "end_turn" }),
      translateInitializeResult({
        protocolVersion: 1,
        agentCapabilities: {},
      }),
    ];

    for (const msg of messages) {
      expect(msg.id).toBeTruthy();
      expect(typeof msg.timestamp).toBe("number");
      expect(msg.type).toBeTruthy();
      expect(msg.role).toBeTruthy();
      expect(Array.isArray(msg.content)).toBe(true);
      expect(typeof msg.metadata).toBe("object");
    }
  });
});
