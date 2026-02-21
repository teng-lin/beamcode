/**
 * Claude Message Translator — Phase 1a.1
 *
 * Pure function that translates CLIMessage → UnifiedMessage.
 * No side effects, no state mutation, no I/O.
 */

import type { UnifiedContent, UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
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

/**
 * Translate a CLIMessage into a UnifiedMessage.
 *
 * Returns `null` for messages that should be silently consumed (e.g. keep_alive).
 */
export function translate(msg: CLIMessage): UnifiedMessage | null {
  switch (msg.type) {
    case "system":
      return msg.subtype === "init" ? translateSystemInit(msg) : translateSystemStatus(msg);
    case "assistant":
      return translateAssistant(msg);
    case "result":
      return translateResult(msg);
    case "stream_event":
      return translateStreamEvent(msg);
    case "control_request":
      return translateControlRequest(msg);
    case "control_response":
      return translateControlResponse(msg);
    case "tool_progress":
      return translateToolProgress(msg);
    case "tool_use_summary":
      return translateToolUseSummary(msg);
    case "auth_status":
      return translateAuthStatus(msg);
    case "keep_alive":
    case "user": // CLI echo of user message — bridge already handles this directly
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Individual translators
// ---------------------------------------------------------------------------

function translateSystemInit(msg: CLISystemInitMessage): UnifiedMessage {
  return createUnifiedMessage({
    type: "session_init",
    role: "system",
    metadata: {
      session_id: msg.session_id,
      model: msg.model,
      cwd: msg.cwd,
      tools: msg.tools,
      permissionMode: msg.permissionMode,
      apiKeySource: msg.apiKeySource,
      claude_code_version: msg.claude_code_version,
      mcp_servers: msg.mcp_servers,
      slash_commands: msg.slash_commands ?? [],
      skills: msg.skills ?? [],
      output_style: msg.output_style,
      uuid: msg.uuid,
    },
  });
}

function translateSystemStatus(msg: CLISystemStatusMessage): UnifiedMessage {
  return createUnifiedMessage({
    type: "status_change",
    role: "system",
    metadata: {
      status: msg.status,
      permissionMode: msg.permissionMode,
      uuid: msg.uuid,
      session_id: msg.session_id,
    },
  });
}

function translateAssistant(msg: CLIAssistantMessage): UnifiedMessage {
  const droppedContentBlockTypes: string[] = [];
  const content: UnifiedContent[] = msg.message.content.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text" as const, text: block.text };
      case "tool_use":
        return {
          type: "tool_use" as const,
          id: block.id,
          name: block.name,
          input: block.input,
        };
      case "tool_result":
        return {
          type: "tool_result" as const,
          tool_use_id: block.tool_use_id,
          content:
            typeof block.content === "string" ? block.content : JSON.stringify(block.content),
          is_error: block.is_error,
        };
      case "thinking":
        return {
          type: "thinking" as const,
          thinking: block.thinking,
          budget_tokens: (block as { budget_tokens?: number }).budget_tokens,
        };
      case "image":
        return {
          type: "image" as const,
          source: block.source,
        };
      case "code":
        return {
          type: "code" as const,
          language: block.language,
          code: block.code,
        };
      case "refusal":
        return {
          type: "refusal" as const,
          refusal: block.refusal,
        };
      default:
        droppedContentBlockTypes.push(
          typeof (block as { type?: unknown }).type === "string"
            ? (block as { type: string }).type
            : "unknown",
        );
        return { type: "text" as const, text: "" };
    }
  });

  return createUnifiedMessage({
    type: "assistant",
    role: "assistant",
    content,
    metadata: {
      message_id: msg.message.id,
      model: msg.message.model,
      stop_reason: msg.message.stop_reason,
      usage: msg.message.usage,
      parent_tool_use_id: msg.parent_tool_use_id,
      error: msg.error,
      uuid: msg.uuid,
      session_id: msg.session_id,
      ...(droppedContentBlockTypes.length > 0
        ? {
            dropped_content_block_types: [...new Set(droppedContentBlockTypes)],
          }
        : {}),
    },
  });
}

function translateResult(msg: CLIResultMessage): UnifiedMessage {
  return createUnifiedMessage({
    type: "result",
    role: "system",
    metadata: {
      subtype: msg.subtype,
      is_error: msg.is_error,
      result: msg.result,
      errors: msg.errors,
      duration_ms: msg.duration_ms,
      duration_api_ms: msg.duration_api_ms,
      num_turns: msg.num_turns,
      total_cost_usd: msg.total_cost_usd,
      stop_reason: msg.stop_reason,
      usage: msg.usage,
      modelUsage: msg.modelUsage,
      total_lines_added: msg.total_lines_added,
      total_lines_removed: msg.total_lines_removed,
      uuid: msg.uuid,
      session_id: msg.session_id,
      ...normalizeClaudeError(msg.subtype, msg.is_error, msg.errors),
    },
  });
}

function normalizeClaudeError(
  subtype: string | undefined,
  isError: boolean,
  errors: string[] | undefined,
): { error_code?: string; error_message?: string } {
  if (!isError) return {};
  const message = errors?.[0] ?? "Unknown error";
  switch (subtype) {
    case "error_max_turns":
      return { error_code: "max_turns", error_message: message };
    case "error_max_budget_usd":
      return { error_code: "max_budget", error_message: message };
    case "error_max_structured_output_retries":
      return { error_code: "execution_error", error_message: message };
    default:
      return { error_code: "execution_error", error_message: message };
  }
}

function translateStreamEvent(msg: CLIStreamEventMessage): UnifiedMessage {
  return createUnifiedMessage({
    type: "stream_event",
    role: "system",
    metadata: {
      event: msg.event,
      parent_tool_use_id: msg.parent_tool_use_id,
      uuid: msg.uuid,
      session_id: msg.session_id,
    },
  });
}

function translateControlRequest(msg: CLIControlRequestMessage): UnifiedMessage {
  return createUnifiedMessage({
    type: "permission_request",
    role: "system",
    metadata: {
      subtype: msg.request.subtype,
      request_id: msg.request_id,
      tool_name: msg.request.tool_name,
      input: msg.request.input,
      permission_suggestions: msg.request.permission_suggestions,
      description: msg.request.description,
      tool_use_id: msg.request.tool_use_id,
      agent_id: msg.request.agent_id,
    },
  });
}

function translateControlResponse(msg: CLIControlResponseMessage): UnifiedMessage {
  return createUnifiedMessage({
    type: "control_response",
    role: "system",
    metadata: {
      subtype: msg.response.subtype,
      request_id: msg.response.request_id,
      response: msg.response.response,
      error: msg.response.error,
    },
  });
}

function translateToolProgress(msg: CLIToolProgressMessage): UnifiedMessage {
  return createUnifiedMessage({
    type: "tool_progress",
    role: "tool",
    metadata: {
      tool_use_id: msg.tool_use_id,
      tool_name: msg.tool_name,
      elapsed_time_seconds: msg.elapsed_time_seconds,
      parent_tool_use_id: msg.parent_tool_use_id,
      uuid: msg.uuid,
      session_id: msg.session_id,
    },
  });
}

function translateToolUseSummary(msg: CLIToolUseSummaryMessage): UnifiedMessage {
  return createUnifiedMessage({
    type: "tool_use_summary",
    role: "tool",
    metadata: {
      summary: msg.summary,
      tool_use_ids: msg.preceding_tool_use_ids,
      uuid: msg.uuid,
      session_id: msg.session_id,
    },
  });
}

function translateAuthStatus(msg: CLIAuthStatusMessage): UnifiedMessage {
  return createUnifiedMessage({
    type: "auth_status",
    role: "system",
    metadata: {
      isAuthenticating: msg.isAuthenticating,
      output: msg.output,
      error: msg.error,
      uuid: msg.uuid,
      session_id: msg.session_id,
    },
  });
}
