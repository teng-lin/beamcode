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
  const toolUseId =
    coerceString(m.tool_use_id) ??
    coerceString(m.call_id) ??
    coerceString(m.toolCallId) ??
    coerceString(m.part_id) ??
    "unknown";
  const toolName =
    coerceString(m.tool_name) ?? coerceString(m.tool) ?? coerceString(m.kind) ?? "tool";
  return {
    type: "tool_progress",
    tool_use_id: toolUseId,
    tool_name: toolName,
    elapsed_time_seconds: deriveElapsedSeconds(m),
  };
}

/**
 * Map a UnifiedMessage of type "tool_use_summary" to a ConsumerMessage.
 */
export function mapToolUseSummary(msg: UnifiedMessage): ConsumerMessage {
  const m = msg.metadata;
  const toolUseId =
    coerceString(m.tool_use_id) ?? coerceString(m.call_id) ?? coerceString(m.toolCallId);
  const toolUseIds = normalizeToolUseIds(m.tool_use_ids, toolUseId);
  const mapped: Extract<ConsumerMessage, { type: "tool_use_summary" }> = {
    type: "tool_use_summary",
    summary: deriveToolSummary(m),
    tool_use_ids: toolUseIds,
  };

  if (toolUseId) mapped.tool_use_id = toolUseId;
  if (typeof m.tool === "string") mapped.tool_name = m.tool;
  if (typeof m.tool_name === "string") mapped.tool_name = m.tool_name;
  if (typeof m.status === "string") mapped.status = m.status;
  if (typeof m.is_error === "boolean") mapped.is_error = m.is_error;
  if (Object.hasOwn(m, "input")) mapped.input = m.input;
  if (Object.hasOwn(m, "output")) mapped.output = m.output;
  if (!Object.hasOwn(m, "output") && Object.hasOwn(m, "content")) {
    mapped.output = m.content;
  }
  if (Object.hasOwn(m, "error")) mapped.error = m.error;

  return mapped;
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
  return mapMetadataMessage("configuration_change", msg);
}

/**
 * Map a UnifiedMessage of type "session_lifecycle" to a ConsumerMessage.
 */
export function mapSessionLifecycle(msg: UnifiedMessage): ConsumerMessage {
  return mapMetadataMessage("session_lifecycle", msg);
}

/** Shared mapper for message types that forward subtype + metadata. */
function mapMetadataMessage(
  type: "configuration_change" | "session_lifecycle",
  msg: UnifiedMessage,
): ConsumerMessage {
  const { subtype: sub, ...rest } = msg.metadata;
  return {
    type,
    subtype: (sub as string) ?? "unknown",
    metadata: rest,
  };
}

function coerceString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeToolUseIds(rawIds: unknown, toolUseId?: string): string[] {
  const ids = Array.isArray(rawIds)
    ? rawIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (toolUseId && !ids.includes(toolUseId)) ids.push(toolUseId);
  return ids;
}

function deriveToolSummary(metadata: UnifiedMessage["metadata"]): string {
  if (typeof metadata.summary === "string" && metadata.summary.length > 0) {
    return metadata.summary;
  }
  if (typeof metadata.title === "string" && metadata.title.length > 0) {
    return metadata.title;
  }

  const toolName =
    coerceString(metadata.tool_name) ?? coerceString(metadata.tool) ?? coerceString(metadata.kind);
  const status = coerceString(metadata.status);
  const isError = metadata.is_error === true || status === "error" || status === "failed";

  if (toolName && isError) return `${toolName} failed`;
  if (toolName && status) return `${toolName} ${status}`;
  if (toolName) return `${toolName} completed`;
  if (status && isError) return `Tool ${status}`;
  if (status) return `Tool ${status}`;

  return "Tool execution completed";
}

function deriveElapsedSeconds(metadata: UnifiedMessage["metadata"]): number {
  if (
    typeof metadata.elapsed_time_seconds === "number" &&
    Number.isFinite(metadata.elapsed_time_seconds)
  ) {
    return metadata.elapsed_time_seconds;
  }

  const time = metadata.time as { start?: number; end?: number } | undefined;
  if (
    time &&
    typeof time.start === "number" &&
    Number.isFinite(time.start) &&
    typeof time.end === "number" &&
    Number.isFinite(time.end)
  ) {
    return Math.max(0, Math.round((time.end - time.start) / 1000));
  }

  return 0;
}
