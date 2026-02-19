/**
 * ConsumerMessageMapper — Pure mapping functions from UnifiedMessage to ConsumerMessage.
 *
 * Extracted from SessionBridge's handleUnified* methods (Phase 5b refactoring).
 * These functions are **pure** — no side effects (no broadcasting, persisting, or emitting events).
 */

import type { PermissionRequest } from "../types/cli-messages.js";
import type { ConsumerMessage, ConsumerPermissionRequest } from "../types/consumer-messages.js";
import type { UnifiedMessage } from "./types/unified-message.js";

/**
 * Map a UnifiedMessage of type "assistant" to a ConsumerMessage.
 *
 * Extracts content blocks (text, tool_use, tool_result) and constructs the
 * consumer-facing assistant message shape.
 */
export function mapAssistantMessage(msg: UnifiedMessage): ConsumerMessage {
  const m = msg.metadata;
  return {
    type: "assistant",
    message: {
      id: (m.message_id as string) ?? msg.id,
      type: "message",
      role: "assistant",
      model: (m.model as string) ?? "",
      content: msg.content.map((block) => {
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
              content: block.content,
              is_error: block.is_error,
            };
          case "thinking":
            return {
              type: "thinking" as const,
              thinking: block.thinking,
              budget_tokens: block.budget_tokens,
            };
          case "code":
            return {
              type: "code" as const,
              language: block.language,
              code: block.code,
            };
          case "image":
            return {
              type: "image" as const,
              media_type: block.source.media_type,
              data: block.source.data,
            };
          case "refusal":
            return { type: "refusal" as const, refusal: block.refusal };
          default:
            return { type: "text" as const, text: "" };
        }
      }),
      stop_reason: (m.stop_reason as string | null) ?? null,
      usage: (m.usage as {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
      }) ?? {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: (m.parent_tool_use_id as string | null) ?? null,
  };
}

/**
 * Map a UnifiedMessage of type "result" to a ConsumerMessage.
 *
 * Constructs the result data payload with all cost/usage/duration fields.
 */
export function mapResultMessage(msg: UnifiedMessage): ConsumerMessage {
  const m = msg.metadata;
  const isError = (m.is_error as boolean) ?? false;
  const subtype = m.subtype as string | undefined as
    | "success"
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries"
    | undefined;
  const errors =
    (m.errors as string[] | undefined) ??
    (typeof m.error === "string" && m.error.length > 0 ? [m.error] : undefined);

  return {
    type: "result",
    data: {
      subtype: subtype ?? (isError ? "error_during_execution" : "success"),
      is_error: isError,
      result: m.result as string | undefined,
      errors,
      duration_ms: (m.duration_ms as number) ?? 0,
      duration_api_ms: (m.duration_api_ms as number) ?? 0,
      num_turns: (m.num_turns as number) ?? 0,
      total_cost_usd: (m.total_cost_usd as number) ?? 0,
      stop_reason: (m.stop_reason as string | null) ?? null,
      usage: (m.usage as {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
      }) ?? {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: m.modelUsage as
        | Record<
            string,
            {
              inputTokens: number;
              outputTokens: number;
              cacheReadInputTokens: number;
              cacheCreationInputTokens: number;
              contextWindow: number;
              maxOutputTokens: number;
              costUSD: number;
            }
          >
        | undefined,
      total_lines_added: m.total_lines_added as number | undefined,
      total_lines_removed: m.total_lines_removed as number | undefined,
      error_code: m.error_code as string | undefined,
      error_message: m.error_message as string | undefined,
    },
  };
}

/**
 * Map a UnifiedMessage of type "stream_event" to a ConsumerMessage.
 */
export function mapStreamEvent(msg: UnifiedMessage): ConsumerMessage {
  const m = msg.metadata;
  return {
    type: "stream_event",
    event: m.event,
    parent_tool_use_id: (m.parent_tool_use_id as string | null) ?? null,
  };
}

/**
 * Map a UnifiedMessage of type "permission_request" to both consumer and CLI permission types.
 *
 * Returns null when the message has a subtype that is not "can_use_tool",
 * matching the guard in the original SessionBridge handler.
 */
export function mapPermissionRequest(
  msg: UnifiedMessage,
): { consumerPerm: ConsumerPermissionRequest; cliPerm: PermissionRequest } | null {
  const m = msg.metadata;

  // Only store can_use_tool permission requests (matches CLI path guard)
  if (m.subtype && m.subtype !== "can_use_tool") return null;

  const consumerPerm: ConsumerPermissionRequest = {
    request_id: m.request_id as string,
    tool_name: m.tool_name as string,
    input: (m.input as Record<string, unknown>) ?? {},
    permission_suggestions: m.permission_suggestions as unknown[] | undefined,
    description: m.description as string | undefined,
    tool_use_id: m.tool_use_id as string,
    agent_id: m.agent_id as string | undefined,
    timestamp: Date.now(),
  };

  const cliPerm: PermissionRequest = {
    ...consumerPerm,
    permission_suggestions: m.permission_suggestions as PermissionRequest["permission_suggestions"],
  };

  return { consumerPerm, cliPerm };
}

/**
 * Map a UnifiedMessage of type "tool_progress" to a ConsumerMessage.
 */
export function mapToolProgress(msg: UnifiedMessage): ConsumerMessage {
  const m = msg.metadata;
  return {
    type: "tool_progress",
    tool_use_id: m.tool_use_id as string,
    tool_name: m.tool_name as string,
    elapsed_time_seconds: m.elapsed_time_seconds as number,
  };
}

/**
 * Map a UnifiedMessage of type "tool_use_summary" to a ConsumerMessage.
 */
export function mapToolUseSummary(msg: UnifiedMessage): ConsumerMessage {
  const m = msg.metadata;
  return {
    type: "tool_use_summary",
    summary: m.summary as string,
    tool_use_ids: m.tool_use_ids as string[],
  };
}

/**
 * Map a UnifiedMessage of type "auth_status" to a ConsumerMessage.
 */
export function mapAuthStatus(msg: UnifiedMessage): ConsumerMessage {
  const m = msg.metadata;
  return {
    type: "auth_status",
    isAuthenticating: m.isAuthenticating as boolean,
    output: m.output as string[],
    error: m.error as string | undefined,
  };
}

/**
 * Map a UnifiedMessage of type "configuration_change" to a ConsumerMessage.
 */
export function mapConfigurationChange(msg: UnifiedMessage): ConsumerMessage {
  const m = msg.metadata;
  const { subtype: sub, ...rest } = m;
  return {
    type: "configuration_change",
    subtype: (sub as string) ?? "unknown",
    metadata: rest,
  };
}

/**
 * Map a UnifiedMessage of type "session_lifecycle" to a ConsumerMessage.
 */
export function mapSessionLifecycle(msg: UnifiedMessage): ConsumerMessage {
  const m = msg.metadata;
  const { subtype: sub, ...rest } = m;
  return {
    type: "session_lifecycle",
    subtype: (sub as string) ?? "unknown",
    metadata: rest,
  };
}
