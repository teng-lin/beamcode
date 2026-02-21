/**
 * SDK Message Translator — translates Agent SDK messages to/from UnifiedMessage.
 *
 * Strategy: SDK message types that are structurally identical to CLIMessage
 * (assistant, result, system:init, system:status, stream_event, tool_progress,
 * tool_use_summary, auth_status) are delegated to the existing Claude adapter
 * translator via a runtime cast. SDK-only types (hooks, tasks, compact_boundary,
 * files_persisted) are handled directly here.
 *
 * This avoids duplicating ~200 lines of proven translation logic while still
 * handling the SDK's expanded message type set.
 */

import type { UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { CLIMessage } from "../../types/cli-messages.js";
import { translate as translateCliMessage } from "../claude/message-translator.js";

/**
 * The SDK's SDKMessage type is imported dynamically (heavy dependency).
 * At runtime, messages are plain objects with a `type` discriminant.
 * We use this minimal shape for the translator's input.
 */
type SdkMessageLike = Record<string, unknown>;

/**
 * Translate an SDK message into a UnifiedMessage.
 * Returns null for messages that should be silently consumed.
 */
export function translateFromSdk(msg: SdkMessageLike): UnifiedMessage | null {
  const type = msg.type as string | undefined;

  switch (type) {
    // --- Shared types: delegate to existing Claude translator ---
    case "assistant":
    case "result":
    case "stream_event":
    case "tool_progress":
    case "tool_use_summary":
    case "auth_status":
      return translateCliMessage(msg as unknown as CLIMessage);

    case "system":
      return translateSystemMessage(msg);

    // --- SDK-only types: handle directly ---
    case "user":
      // User message echo — silently consumed (same as CLI adapter)
      return null;

    case "keep_alive":
      return null;

    default:
      // Unknown message type — pass through as unknown
      return null;
  }
}

/**
 * Handle system messages, which have subtypes.
 * Shared subtypes (init, status) delegate to CLI translator.
 * SDK-only subtypes (compact_boundary, hook_*, task_*, files_persisted)
 * are handled directly.
 */
function translateSystemMessage(msg: SdkMessageLike): UnifiedMessage | null {
  const subtype = msg.subtype as string | undefined;

  switch (subtype) {
    // Shared subtypes — delegate to CLI translator
    case "init":
    case "status":
      return translateCliMessage(msg as unknown as CLIMessage);

    // SDK-only: compact boundary
    case "compact_boundary":
      return createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: {
          status: "compact_boundary",
          compact_metadata: msg.compact_metadata,
          uuid: msg.uuid,
          session_id: msg.session_id,
        },
      });

    // SDK-only: hook lifecycle
    case "hook_started":
      return createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: {
          status: "hook_started",
          hook_id: msg.hook_id,
          hook_name: msg.hook_name,
          hook_event: msg.hook_event,
          uuid: msg.uuid,
          session_id: msg.session_id,
        },
      });

    case "hook_progress":
      return createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: {
          status: "hook_progress",
          hook_id: msg.hook_id,
          hook_name: msg.hook_name,
          hook_event: msg.hook_event,
          stdout: msg.stdout,
          stderr: msg.stderr,
          output: msg.output,
          uuid: msg.uuid,
          session_id: msg.session_id,
        },
      });

    case "hook_response":
      return createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: {
          status: "hook_response",
          hook_id: msg.hook_id,
          hook_name: msg.hook_name,
          hook_event: msg.hook_event,
          output: msg.output,
          stdout: msg.stdout,
          stderr: msg.stderr,
          exit_code: msg.exit_code,
          outcome: msg.outcome,
          uuid: msg.uuid,
          session_id: msg.session_id,
        },
      });

    // SDK-only: task lifecycle
    case "task_started":
      return createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: {
          status: "task_started",
          task_id: msg.task_id,
          tool_use_id: msg.tool_use_id,
          description: msg.description,
          task_type: msg.task_type,
          uuid: msg.uuid,
          session_id: msg.session_id,
        },
      });

    case "task_notification":
      return createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: {
          status: "task_notification",
          task_id: msg.task_id,
          tool_use_id: msg.tool_use_id,
          task_status: msg.status,
          output_file: msg.output_file,
          summary: msg.summary,
          usage: msg.usage,
          uuid: msg.uuid,
          session_id: msg.session_id,
        },
      });

    // SDK-only: files persisted
    case "files_persisted":
      return createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: {
          status: "files_persisted",
          files: msg.files,
          failed: msg.failed,
          processed_at: msg.processed_at,
          uuid: msg.uuid,
          session_id: msg.session_id,
        },
      });

    default:
      // Unknown system subtype — pass through
      return null;
  }
}

/**
 * Translate a UnifiedMessage user_message to the SDK's input format.
 * Returns the user message text content for feeding into the query's prompt iterable.
 */
export function translateToSdkUserMessage(msg: UnifiedMessage): string | null {
  if (msg.type !== "user_message") return null;

  const textParts = msg.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""));

  const text = textParts.join("");
  return text.length > 0 ? text : null;
}
