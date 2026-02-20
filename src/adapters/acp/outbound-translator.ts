/**
 * ACP Outbound Translator — Phase 3
 *
 * Pure functions that translate ACP session/update notifications and responses
 * into UnifiedMessage envelopes. No side effects, no state, no I/O.
 */

import type { UnifiedContent, UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";

// ---------------------------------------------------------------------------
// ACP types (locally defined — no external SDK dependency)
// ---------------------------------------------------------------------------

export interface AcpSessionUpdate {
  sessionId: string;
  sessionUpdate: string;
  [key: string]: unknown;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string; [key: string]: unknown };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface AcpPromptResult {
  sessionId: string;
  stopReason: string;
  [key: string]: unknown;
}

export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string | null;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: Record<string, unknown>;
  agentInfo?: { name?: string; version?: string };
  authMethods?: AcpAuthMethod[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Translate a session/update notification into a UnifiedMessage. */
export function translateSessionUpdate(update: AcpSessionUpdate): UnifiedMessage {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return translateAgentMessageChunk(update);
    case "agent_thought_chunk":
      return translateAgentThoughtChunk(update);
    case "tool_call":
      return translateToolCall(update);
    case "tool_call_update":
      return translateToolCallUpdate(update);
    case "plan":
      return translatePlan(update);
    case "available_commands_update":
      return translateAvailableCommandsUpdate(update);
    case "current_mode_update":
      return translateCurrentModeUpdate(update);
    default:
      return createUnifiedMessage({
        type: "unknown",
        role: "system",
        metadata: { session_id: update.sessionId, raw: update },
      });
  }
}

/** Translate a session/request_permission request into a UnifiedMessage. */
export function translatePermissionRequest(request: AcpPermissionRequest): UnifiedMessage {
  const tc = request.toolCall;
  return createUnifiedMessage({
    type: "permission_request",
    role: "system",
    metadata: {
      session_id: request.sessionId,
      // Map ACP toolCall fields to the flat names expected by consumer-message-mapper
      request_id: tc.toolCallId,
      tool_use_id: tc.toolCallId,
      tool_name: (tc.kind as string) ?? (tc.title as string) ?? "tool",
      input: (tc.rawInput as Record<string, unknown>) ?? {},
      description: tc.title as string | undefined,
      // Preserve ACP options for inbound permission response translation
      options: request.options,
    },
  });
}

/** Translate a session/prompt response (turn complete) into a UnifiedMessage. */
export function translatePromptResult(result: AcpPromptResult): UnifiedMessage {
  const { sessionId, stopReason, ...rest } = result;
  return createUnifiedMessage({
    type: "result",
    role: "system",
    metadata: { session_id: sessionId, stopReason, ...rest },
  });
}

/** Signature for backend-specific error classifiers. */
export type ErrorClassifier = (code: number, message: string) => string;

/**
 * Translate a JSON-RPC error on a prompt response into a result UnifiedMessage.
 *
 * Preserves the full error detail (code, message, data) so consumers can
 * surface actionable info. An optional classifier maps the error to a
 * UnifiedErrorCode; defaults to "api_error" when no classifier is provided.
 */
export function translatePromptError(
  sessionId: string,
  error: { code: number; message: string; data?: unknown },
  classify?: ErrorClassifier,
): UnifiedMessage {
  return createUnifiedMessage({
    type: "result",
    role: "system",
    metadata: {
      session_id: sessionId,
      stopReason: "error",
      error_code: classify ? classify(error.code, error.message) : "api_error",
      error_message: error.message,
      ...(error.data !== undefined && { error_data: error.data }),
    },
  });
}

/** Translate an auth error into an auth_status UnifiedMessage. */
export function translateAuthStatus(
  sessionId: string,
  error: string,
  data?: { validationLink?: string; validationDescription?: string; learnMoreUrl?: string },
): UnifiedMessage {
  return createUnifiedMessage({
    type: "auth_status",
    role: "system",
    metadata: {
      session_id: sessionId,
      isAuthenticating: false,
      output: [],
      error,
      ...(data?.validationLink && { validationLink: data.validationLink }),
    },
  });
}

/** Translate an initialize response into a UnifiedMessage. */
export function translateInitializeResult(result: AcpInitializeResult): UnifiedMessage {
  return createUnifiedMessage({
    type: "session_init",
    role: "system",
    metadata: {
      protocolVersion: result.protocolVersion,
      agentCapabilities: result.agentCapabilities,
      agentName: result.agentInfo?.name,
      agentVersion: result.agentInfo?.version,
      ...(result.authMethods && { authMethods: result.authMethods }),
    },
  });
}

// ---------------------------------------------------------------------------
// Internal translators for each session/update type
// ---------------------------------------------------------------------------

function translateAgentMessageChunk(update: AcpSessionUpdate): UnifiedMessage {
  const content: UnifiedContent[] = [];
  const textChunk = update.content as { type?: string; text?: string } | undefined;
  if (textChunk?.text) {
    content.push({ type: "text", text: textChunk.text });
  }

  return createUnifiedMessage({
    type: "stream_event",
    role: "assistant",
    content,
    metadata: {
      session_id: update.sessionId,
      // Synthesize Claude-compatible event so consumer-message-mapper stays backend-agnostic
      ...(textChunk?.text && {
        event: { type: "content_block_delta", delta: { type: "text_delta", text: textChunk.text } },
      }),
    },
  });
}

function translateAgentThoughtChunk(update: AcpSessionUpdate): UnifiedMessage {
  const content: UnifiedContent[] = [];
  const textChunk = update.content as { type?: string; text?: string } | undefined;
  if (textChunk?.text) {
    content.push({ type: "thinking", thinking: textChunk.text });
  }

  return createUnifiedMessage({
    type: "stream_event",
    role: "assistant",
    content,
    metadata: {
      session_id: update.sessionId,
      thought: true,
      // Synthesize Claude-compatible event so consumer-message-mapper stays backend-agnostic
      ...(textChunk?.text && {
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: textChunk.text },
        },
      }),
    },
  });
}

function translateToolCall(update: AcpSessionUpdate): UnifiedMessage {
  return createUnifiedMessage({
    type: "tool_progress",
    role: "tool",
    metadata: {
      session_id: update.sessionId,
      tool_use_id: update.toolCallId as string,
      title: update.title as string | undefined,
      kind: update.kind as string | undefined,
      status: update.status as string | undefined,
    },
  });
}

function translateToolCallUpdate(update: AcpSessionUpdate): UnifiedMessage {
  const status = update.status as string | undefined;
  const content = extractToolContent(update.content);

  if (status === "completed" || status === "failed") {
    return createUnifiedMessage({
      type: "tool_use_summary",
      role: "tool",
      metadata: {
        session_id: update.sessionId,
        tool_use_id: update.toolCallId as string,
        content,
        status,
        is_error: status === "failed",
      },
    });
  }

  // in_progress or unknown status
  return createUnifiedMessage({
    type: "tool_progress",
    role: "tool",
    metadata: {
      session_id: update.sessionId,
      tool_use_id: update.toolCallId as string,
      content,
      status: status ?? "in_progress",
    },
  });
}

/**
 * Extract text from ACP tool content format.
 * ACP sends: [{type: "content", content: {type: "text", text: "..."}}]
 * We flatten to a plain text string for the consumer.
 */
function extractToolContent(raw: unknown): string | unknown {
  if (!Array.isArray(raw)) return raw;
  const texts: string[] = [];
  for (const item of raw) {
    if (
      item?.type === "content" &&
      item?.content?.type === "text" &&
      typeof item.content.text === "string"
    ) {
      texts.push(item.content.text);
    } else if (item?.type === "text" && typeof item?.text === "string") {
      texts.push(item.text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : raw;
}

function translatePlan(update: AcpSessionUpdate): UnifiedMessage {
  return createUnifiedMessage({
    type: "status_change",
    role: "system",
    metadata: {
      session_id: update.sessionId,
      planEntries: update.planEntries,
    },
  });
}

function translateAvailableCommandsUpdate(update: AcpSessionUpdate): UnifiedMessage {
  return createUnifiedMessage({
    type: "configuration_change",
    role: "system",
    metadata: {
      subtype: "available_commands_update",
      session_id: update.sessionId,
      availableCommands: update.availableCommands,
    },
  });
}

function translateCurrentModeUpdate(update: AcpSessionUpdate): UnifiedMessage {
  return createUnifiedMessage({
    type: "configuration_change",
    role: "system",
    metadata: {
      subtype: "current_mode_update",
      session_id: update.sessionId,
      modeId: update.modeId as string,
    },
  });
}
