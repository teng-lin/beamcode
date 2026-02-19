/**
 * Gemini Message Translator
 *
 * Pure functions that translate between the Gemini A2A protocol and
 * BeamCode's UnifiedMessage envelope.
 *
 * The A2A protocol uses SSE streaming with JSON-RPC 2.0 wrappers.
 * Events are discriminated by `result.kind` and `metadata.coderAgent.kind`.
 *
 * No side effects, no state mutation, no I/O.
 */

import type { UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type {
  A2AStatusUpdate,
  A2AStreamEvent,
  A2ATaskResult,
  GeminiMessage,
  ToolCall,
  ToolCallConfirmation,
} from "./gemini-types.js";

// ---------------------------------------------------------------------------
// Outbound action type (UnifiedMessage → A2A HTTP)
// ---------------------------------------------------------------------------

export interface GeminiAction {
  type: "message_stream" | "message_stream_resume" | "cancel" | "noop";
  message?: GeminiMessage;
  taskId?: string;
}

// ---------------------------------------------------------------------------
// A2A event → UnifiedMessage (outbound from Gemini)
// ---------------------------------------------------------------------------

/**
 * Translate an A2A SSE event into a UnifiedMessage.
 * Returns `null` for events that don't produce user-facing messages.
 */
export function translateA2AEvent(event: A2AStreamEvent): UnifiedMessage | null {
  if (event.error) {
    return createUnifiedMessage({
      type: "result",
      role: "system",
      metadata: {
        status: "failed",
        is_error: true,
        error: event.error.message,
        error_code: event.error.code,
      },
    });
  }

  const result = event.result;
  if (!result) return null;

  if (result.kind === "task") {
    return translateTaskSubmitted(result);
  }

  if (result.kind === "status-update") {
    return translateStatusUpdate(result);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Task submitted
// ---------------------------------------------------------------------------

function translateTaskSubmitted(result: A2ATaskResult): UnifiedMessage {
  return createUnifiedMessage({
    type: "session_init",
    role: "system",
    metadata: {
      task_id: result.id,
      context_id: result.contextId,
      state: result.status.state,
    },
  });
}

// ---------------------------------------------------------------------------
// Status update dispatch
// ---------------------------------------------------------------------------

function translateStatusUpdate(update: A2AStatusUpdate): UnifiedMessage | null {
  const coderAgentKind = update.metadata?.coderAgent?.kind;

  if (update.final) {
    return translateFinalStateChange(update);
  }

  switch (coderAgentKind) {
    case "text-content":
      return translateTextContent(update);
    case "tool-call-update":
      return translateToolCallUpdate(update);
    case "tool-call-confirmation":
      return translateToolConfirmation(update);
    case "thought":
      return translateThought(update);
    case "state-change":
      // Non-final state changes are internal — no emit
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Text content
// ---------------------------------------------------------------------------

function translateTextContent(update: A2AStatusUpdate): UnifiedMessage {
  const text = extractTextFromMessage(update.status.message);
  return createUnifiedMessage({
    type: "stream_event",
    role: "assistant",
    metadata: {
      delta: text,
      task_id: update.taskId,
    },
  });
}

// ---------------------------------------------------------------------------
// Tool call update
// ---------------------------------------------------------------------------

function translateToolCallUpdate(update: A2AStatusUpdate): UnifiedMessage {
  const toolCall = extractToolCallFromMessage(update.status.message);
  return createUnifiedMessage({
    type: "tool_progress",
    role: "tool",
    metadata: {
      tool_call_id: toolCall?.tool_call_id,
      tool_name: toolCall?.tool_name,
      status: toolCall?.status,
      description: toolCall?.description,
      live_content: toolCall?.live_content,
      input_parameters: toolCall?.input_parameters,
      output: toolCall?.output,
      error: toolCall?.error,
      task_id: update.taskId,
    },
  });
}

// ---------------------------------------------------------------------------
// Tool confirmation (permission request)
// ---------------------------------------------------------------------------

function translateToolConfirmation(update: A2AStatusUpdate): UnifiedMessage {
  const toolCall = extractToolCallFromMessage(update.status.message);
  return createUnifiedMessage({
    type: "permission_request",
    role: "system",
    metadata: {
      tool_call_id: toolCall?.tool_call_id,
      tool_name: toolCall?.tool_name,
      description: toolCall?.description,
      input_parameters: toolCall?.input_parameters,
      confirmation_options: toolCall?.confirmation_request?.options,
      task_id: update.taskId,
    },
  });
}

// ---------------------------------------------------------------------------
// Thought
// ---------------------------------------------------------------------------

function translateThought(update: A2AStatusUpdate): UnifiedMessage {
  const text = extractTextFromMessage(update.status.message);
  return createUnifiedMessage({
    type: "stream_event",
    role: "assistant",
    metadata: {
      thought: true,
      delta: text,
      task_id: update.taskId,
    },
  });
}

// ---------------------------------------------------------------------------
// Final state changes → result
// ---------------------------------------------------------------------------

function translateFinalStateChange(update: A2AStatusUpdate): UnifiedMessage {
  const state = update.status.state;

  if (state === "failed") {
    const text = extractTextFromMessage(update.status.message);
    return createUnifiedMessage({
      type: "result",
      role: "system",
      metadata: {
        status: "failed",
        is_error: true,
        error: text || "Task failed",
        task_id: update.taskId,
      },
    });
  }

  // input-required or completed
  return createUnifiedMessage({
    type: "result",
    role: "system",
    metadata: {
      status: state === "completed" ? "completed" : "input-required",
      task_id: update.taskId,
    },
  });
}

// ---------------------------------------------------------------------------
// UnifiedMessage → Gemini action (inbound to Gemini)
// ---------------------------------------------------------------------------

/**
 * Translate a UnifiedMessage into a Gemini A2A action.
 */
export function translateToGemini(message: UnifiedMessage): GeminiAction {
  switch (message.type) {
    case "user_message":
      return {
        type: "message_stream",
        message: {
          kind: "message",
          role: "user",
          parts: [{ kind: "text", text: extractTextContent(message) }],
          messageId: message.id,
        },
      };

    case "permission_response": {
      const confirmation: ToolCallConfirmation = {
        tool_call_id: message.metadata.tool_call_id as string,
        selected_option_id: message.metadata.behavior === "allow" ? "proceed_once" : "reject",
      };
      return {
        type: "message_stream_resume",
        taskId: message.metadata.task_id as string,
        message: {
          kind: "message",
          role: "user",
          parts: [{ kind: "data", data: { ...confirmation } }],
          messageId: message.id,
        },
      };
    }

    case "interrupt":
      return {
        type: "cancel",
        taskId: message.metadata.task_id as string | undefined,
      };

    case "session_init":
    default:
      return { type: "noop" };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractTextFromMessage(message?: GeminiMessage): string {
  if (!message?.parts) return "";
  return message.parts
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
    .map((p) => p.text)
    .join("");
}

function extractToolCallFromMessage(message?: GeminiMessage): ToolCall | undefined {
  if (!message?.parts) return undefined;
  for (const part of message.parts) {
    if (part.kind === "data" && isToolCall(part.data)) {
      return part.data as unknown as ToolCall;
    }
  }
  return undefined;
}

function isToolCall(data: Record<string, unknown>): boolean {
  return typeof data.tool_call_id === "string" && typeof data.tool_name === "string";
}

function extractTextContent(message: UnifiedMessage): string {
  if (message.content.length > 0) {
    return message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return (message.metadata.text as string) ?? "";
}

/** Build the JSON-RPC request body for a message/stream call. */
export function buildMessageStreamBody(
  rpcId: number,
  message: GeminiMessage,
  taskId?: string,
): string {
  const params: Record<string, unknown> = {
    message: {
      kind: "message",
      role: message.role,
      parts: message.parts,
      messageId: message.messageId,
    },
    configuration: { acceptedOutputModes: ["text"] },
  };

  if (taskId) {
    params.id = taskId;
  }

  return JSON.stringify({
    jsonrpc: "2.0",
    id: rpcId,
    method: "message/stream",
    params,
  });
}

/** Build the JSON-RPC request body for a tasks/cancel call. */
export function buildCancelBody(rpcId: number, taskId: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: rpcId,
    method: "tasks/cancel",
    params: { id: taskId },
  });
}
