/**
 * Agent SDK Message Translator — Phase 3
 *
 * Pure functions that translate Claude Agent SDK messages ↔ UnifiedMessage.
 * No side effects, no state mutation, no I/O.
 *
 * Local SDK types mirror the real SDK without importing it.
 */

import type { UnifiedContent, UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";

// ---------------------------------------------------------------------------
// Local SDK message types — mirrors the real SDK without importing it
// ---------------------------------------------------------------------------

export interface SDKContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export interface SDKAssistantMessage {
  type: "assistant";
  message: {
    role: "user" | "assistant";
    content: SDKContentBlock[];
  };
  session_id?: string;
}

export interface SDKResultMessage {
  type: "result";
  subtype: string;
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  cost_usd?: number;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  session_id?: string;
}

export interface SDKSystemMessage {
  type: "system";
  subtype?: string;
  session_id?: string;
  [key: string]: unknown;
}

export type SDKMessage = SDKAssistantMessage | SDKResultMessage | SDKSystemMessage;

export interface SDKUserMessage {
  type: "user";
  session_id?: string;
  message: {
    role: "user";
    content: string | Array<{ type: string; text?: string; source?: unknown }>;
  };
  parent_tool_use_id?: string | null;
}

// ---------------------------------------------------------------------------
// Outbound: SDK → UnifiedMessage
// ---------------------------------------------------------------------------

/**
 * Translate an SDK message into a UnifiedMessage.
 *
 * Routes based on `msg.type`:
 * - "assistant" → UnifiedMessage with content blocks mapped to UnifiedContent
 * - "result"    → UnifiedMessage type "result" with metadata
 * - "system"    → UnifiedMessage type "status_change" with metadata passthrough
 */
export function translateSdkMessage(msg: SDKMessage): UnifiedMessage {
  switch (msg.type) {
    case "assistant":
      return translateAssistant(msg);
    case "result":
      return translateResult(msg);
    case "system":
      return translateSystem(msg);
    default:
      return createUnifiedMessage({
        type: "unknown",
        role: "system",
        metadata: { raw: msg },
      });
  }
}

// ---------------------------------------------------------------------------
// Inbound: UnifiedMessage → SDK user message
// ---------------------------------------------------------------------------

/**
 * Translate a UnifiedMessage into an SDK user message for sending input.
 *
 * Only `user_message` types are translatable; all others return `null`.
 */
export function translateToSdkInput(message: UnifiedMessage): SDKUserMessage | null {
  if (message.type !== "user_message") return null;

  const text = extractTextFromContent(message);

  return {
    type: "user",
    session_id: message.metadata.session_id as string | undefined,
    message: {
      role: "user",
      content: text,
    },
    parent_tool_use_id: (message.metadata.parent_tool_use_id as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Internal translators
// ---------------------------------------------------------------------------

function translateAssistant(msg: SDKAssistantMessage): UnifiedMessage {
  const content: UnifiedContent[] = msg.message.content.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text" as const, text: block.text ?? "" };
      case "tool_use":
        return {
          type: "tool_use" as const,
          id: block.id ?? "",
          name: block.name ?? "",
          input: block.input ?? {},
        };
      case "tool_result":
        return {
          type: "tool_result" as const,
          tool_use_id: block.tool_use_id ?? "",
          content:
            typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""),
          is_error: block.is_error,
        };
      default:
        return { type: "text" as const, text: "" };
    }
  });

  return createUnifiedMessage({
    type: "assistant",
    role: "assistant",
    content,
    metadata: {
      session_id: msg.session_id,
    },
  });
}

function translateResult(msg: SDKResultMessage): UnifiedMessage {
  return createUnifiedMessage({
    type: "result",
    role: "system",
    metadata: {
      subtype: msg.subtype,
      result: msg.result,
      duration_ms: msg.duration_ms,
      duration_api_ms: msg.duration_api_ms,
      cost_usd: msg.cost_usd,
      is_error: msg.is_error,
      total_cost_usd: msg.total_cost_usd,
      num_turns: msg.num_turns,
      session_id: msg.session_id,
    },
  });
}

function translateSystem(msg: SDKSystemMessage): UnifiedMessage {
  const { type: _type, ...rest } = msg;
  return createUnifiedMessage({
    type: "status_change",
    role: "system",
    metadata: rest,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTextFromContent(message: UnifiedMessage): string {
  const texts = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text);

  if (texts.length > 0) return texts.join("\n");

  // Fall back to metadata.text if no text content blocks
  return (message.metadata.text as string) ?? "";
}
