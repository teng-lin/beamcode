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

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: Record<string, unknown>;
  agentInfo?: { name?: string; version?: string };
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
        metadata: { sessionId: update.sessionId, raw: update },
      });
  }
}

/** Translate a session/request_permission request into a UnifiedMessage. */
export function translatePermissionRequest(request: AcpPermissionRequest): UnifiedMessage {
  return createUnifiedMessage({
    type: "permission_request",
    role: "system",
    metadata: {
      sessionId: request.sessionId,
      toolCall: request.toolCall,
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
    metadata: { sessionId, stopReason, ...rest },
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
    metadata: { sessionId: update.sessionId },
  });
}

function translateAgentThoughtChunk(update: AcpSessionUpdate): UnifiedMessage {
  const content: UnifiedContent[] = [];
  const textChunk = update.content as { type?: string; text?: string } | undefined;
  if (textChunk?.text) {
    content.push({ type: "text", text: textChunk.text });
  }

  return createUnifiedMessage({
    type: "stream_event",
    role: "assistant",
    content,
    metadata: { sessionId: update.sessionId, thought: true },
  });
}

function translateToolCall(update: AcpSessionUpdate): UnifiedMessage {
  return createUnifiedMessage({
    type: "tool_progress",
    role: "tool",
    metadata: {
      sessionId: update.sessionId,
      toolCallId: update.toolCallId as string,
      title: update.title as string | undefined,
      kind: update.kind as string | undefined,
      status: update.status as string | undefined,
    },
  });
}

function translateToolCallUpdate(update: AcpSessionUpdate): UnifiedMessage {
  const status = update.status as string | undefined;

  if (status === "completed" || status === "failed") {
    return createUnifiedMessage({
      type: "tool_use_summary",
      role: "tool",
      metadata: {
        sessionId: update.sessionId,
        toolCallId: update.toolCallId as string,
        content: update.content,
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
      sessionId: update.sessionId,
      toolCallId: update.toolCallId as string,
      content: update.content,
      status: status ?? "in_progress",
    },
  });
}

function translatePlan(update: AcpSessionUpdate): UnifiedMessage {
  return createUnifiedMessage({
    type: "status_change",
    role: "system",
    metadata: {
      sessionId: update.sessionId,
      planEntries: update.planEntries,
    },
  });
}

function translateAvailableCommandsUpdate(update: AcpSessionUpdate): UnifiedMessage {
  return createUnifiedMessage({
    type: "unknown",
    role: "system",
    metadata: {
      sessionId: update.sessionId,
      availableCommands: update.availableCommands,
    },
  });
}

function translateCurrentModeUpdate(update: AcpSessionUpdate): UnifiedMessage {
  return createUnifiedMessage({
    type: "configuration_change",
    role: "system",
    metadata: {
      sessionId: update.sessionId,
      modeId: update.modeId as string,
    },
  });
}
