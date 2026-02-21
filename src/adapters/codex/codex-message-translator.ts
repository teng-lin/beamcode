/**
 * Codex Message Translator
 *
 * Pure functions that translate between Codex CLI's modified JSON-RPC 2.0
 * protocol and BeamCode's UnifiedMessage envelope.
 *
 * Codex uses a Thread/Turn/Item hierarchy:
 * - Thread = conversation session
 * - Turn   = user/assistant exchange
 * - Item   = individual content piece (text, tool call, tool result)
 *
 * No side effects, no state mutation, no I/O.
 */

import type {
  UnifiedContent,
  UnifiedErrorCode,
  UnifiedMessage,
} from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";

// ---------------------------------------------------------------------------
// Codex protocol types (local — no external SDK dependency)
// ---------------------------------------------------------------------------

export interface CodexContentPart {
  type: "input_text" | "output_text";
  text: string;
}

export interface CodexRefusalPart {
  type: "refusal";
  refusal: string;
}

export type CodexItemContent = CodexContentPart | CodexRefusalPart;

export interface CodexItem {
  type: "message" | "function_call" | "function_call_output";
  id?: string;
  role?: "user" | "assistant" | "system";
  content?: CodexItemContent[];
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: string;
  status?: "in_progress" | "completed" | "incomplete";
}

export interface CodexResponse {
  id: string;
  status: string;
  output: CodexItem[];
}

export interface CodexTurnEvent {
  type:
    | "response.output_item.added"
    | "response.output_item.done"
    | "response.output_text.delta"
    | "response.completed"
    | "response.failed";
  item?: CodexItem;
  delta?: string;
  output_index?: number;
  response?: CodexResponse;
}

export interface CodexApprovalRequest {
  type: "approval_requested";
  item: CodexItem;
}

export interface CodexInitResponse {
  capabilities: Record<string, unknown>;
  version?: string;
}

// ---------------------------------------------------------------------------
// Outbound: Codex action → JSON-RPC payload
// ---------------------------------------------------------------------------

export interface CodexAction {
  type: "turn" | "approval_response" | "cancel";
  input?: string;
  approve?: boolean;
  itemId?: string;
}

// ---------------------------------------------------------------------------
// Codex event → UnifiedMessage (outbound from Codex)
// ---------------------------------------------------------------------------

/**
 * Translate a Codex turn event into a UnifiedMessage.
 * Returns `null` for events that don't produce user-facing messages.
 */
export function translateCodexEvent(event: CodexTurnEvent): UnifiedMessage | null {
  switch (event.type) {
    case "response.output_text.delta":
      return translateTextDelta(event);
    case "response.output_item.added":
      return translateItemAdded(event);
    case "response.output_item.done":
      return translateItemDone(event);
    case "response.completed":
      return translateCompleted(event);
    case "response.failed":
      return translateFailed(event);
    default:
      return null;
  }
}

/** Translate an approval_requested event into a UnifiedMessage. */
export function translateApprovalRequest(request: CodexApprovalRequest): UnifiedMessage {
  return createUnifiedMessage({
    type: "permission_request",
    role: "system",
    metadata: {
      item: {
        type: request.item.type,
        id: request.item.id,
        name: request.item.name,
        arguments: request.item.arguments,
        call_id: request.item.call_id,
      },
      tool_name: request.item.name,
      tool_use_id: request.item.call_id,
    },
  });
}

/** Translate an initialize response into a UnifiedMessage. */
export function translateInitResponse(response: CodexInitResponse): UnifiedMessage {
  return createUnifiedMessage({
    type: "session_init",
    role: "system",
    metadata: {
      capabilities: response.capabilities,
      version: response.version,
    },
  });
}

// ---------------------------------------------------------------------------
// UnifiedMessage → Codex action (inbound to Codex)
// ---------------------------------------------------------------------------

/**
 * Translate a UnifiedMessage into a Codex action for sending over the wire.
 */
export function translateToCodex(message: UnifiedMessage): CodexAction {
  switch (message.type) {
    case "user_message":
      return {
        type: "turn",
        input: extractTextContent(message),
      };
    case "permission_response":
      return {
        type: "approval_response",
        approve: message.metadata.behavior === "allow",
        itemId: message.metadata.request_id as string | undefined,
      };
    case "interrupt":
      return { type: "cancel" };
    default:
      return {
        type: "turn",
        input: extractTextContent(message),
      };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function translateTextDelta(event: CodexTurnEvent): UnifiedMessage {
  return createUnifiedMessage({
    type: "stream_event",
    role: "assistant",
    metadata: {
      delta: event.delta ?? "",
      output_index: event.output_index,
    },
  });
}

function translateItemAdded(event: CodexTurnEvent): UnifiedMessage | null {
  const item = event.item;
  if (!item) return null;

  if (item.type === "message") {
    const content = itemContentToUnified(item);
    return createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content,
      metadata: {
        item_id: item.id,
        status: item.status,
        output_index: event.output_index,
      },
    });
  }

  if (item.type === "function_call") {
    return createUnifiedMessage({
      type: "tool_progress",
      role: "tool",
      metadata: {
        name: item.name,
        tool_name: item.name,
        arguments: item.arguments,
        tool_use_id: item.call_id,
        item_id: item.id,
        status: item.status,
        output_index: event.output_index,
      },
    });
  }

  return null;
}

function translateItemDone(event: CodexTurnEvent): UnifiedMessage | null {
  const item = event.item;
  if (!item) return null;

  if (item.type === "function_call_output") {
    return createUnifiedMessage({
      type: "tool_use_summary",
      role: "tool",
      metadata: {
        output: item.output,
        tool_use_id: item.call_id,
        status: item.status,
        item_id: item.id,
        output_index: event.output_index,
      },
    });
  }

  if (item.type === "function_call") {
    return createUnifiedMessage({
      type: "tool_progress",
      role: "tool",
      metadata: {
        name: item.name,
        tool_name: item.name,
        arguments: item.arguments,
        tool_use_id: item.call_id,
        item_id: item.id,
        status: item.status,
        output_index: event.output_index,
      },
    });
  }

  if (item.type === "message") {
    const content = itemContentToUnified(item);
    return createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      content,
      metadata: {
        item_id: item.id,
        status: item.status,
        output_index: event.output_index,
      },
    });
  }

  return null;
}

function translateCompleted(event: CodexTurnEvent): UnifiedMessage {
  const response = event.response;
  return createUnifiedMessage({
    type: "result",
    role: "system",
    metadata: {
      status: response?.status ?? "completed",
      response_id: response?.id,
      output_items: response?.output?.length ?? 0,
    },
  });
}

function translateFailed(event: CodexTurnEvent): UnifiedMessage {
  const status = event.response?.status ?? "unknown_error";
  return createUnifiedMessage({
    type: "result",
    role: "system",
    metadata: {
      status: "failed",
      is_error: true,
      response_id: event.response?.id,
      error: status,
      error_code: classifyCodexError(status),
      error_message: humanizeCodexError(status),
    },
  });
}

function classifyCodexError(status: string): UnifiedErrorCode {
  switch (status) {
    case "rate_limited":
      return "rate_limit";
    case "incomplete":
      return "output_length";
    case "cancelled":
      return "aborted";
    default:
      return "execution_error";
  }
}

function humanizeCodexError(status: string): string {
  switch (status) {
    case "rate_limited":
      return "Rate limit exceeded";
    case "incomplete":
      return "Output truncated (too long)";
    case "cancelled":
      return "Request cancelled";
    default:
      return `Execution failed: ${status}`;
  }
}

/** Extract plain text from a CodexItem's content array. */
function itemContentToUnified(item: CodexItem): UnifiedContent[] {
  if (!item.content || item.content.length === 0) return [];

  return item.content.map((part): UnifiedContent => {
    if (part.type === "refusal") {
      return { type: "refusal", refusal: part.refusal };
    }
    return { type: "text", text: part.text };
  });
}

/** Extract text content from a UnifiedMessage for sending to Codex. */
function extractTextContent(message: UnifiedMessage): string {
  if (message.content.length > 0) {
    return message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return (message.metadata.text as string) ?? "";
}
