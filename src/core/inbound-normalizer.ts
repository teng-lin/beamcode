/**
 * Inbound Normalizer — maps InboundMessage → UnifiedMessage.
 *
 * Pure function — no side effects, no state mutation, no I/O.
 * Moved from adapters/claude/inbound-translator.ts to core since
 * it operates only on core types (InboundMessage → UnifiedMessage).
 */

import type { InboundMessage } from "../types/inbound-messages.js";
import type { UnifiedContent, UnifiedMessage } from "./types/unified-message.js";
import { createUnifiedMessage } from "./types/unified-message.js";

/**
 * Normalize an InboundMessage (from a consumer) into a UnifiedMessage.
 *
 * Returns `null` for message types that don't map to a UnifiedMessage
 * (e.g. presence_query, slash_command — those are handled by the bridge directly).
 */
export function normalizeInbound(msg: InboundMessage): UnifiedMessage | null {
  switch (msg.type) {
    case "user_message":
      return normalizeUserMessage(msg);
    case "permission_response":
      return normalizePermissionResponse(msg);
    case "interrupt":
      return normalizeInterrupt();
    case "set_model":
      return normalizeSetModel(msg);
    case "set_permission_mode":
      return normalizeSetPermissionMode(msg);
    case "presence_query":
      return null; // handled by bridge directly
    case "slash_command":
      return null; // handled by bridge directly
    default:
      return null;
  }
}

function normalizeUserMessage(msg: {
  type: "user_message";
  content: string;
  session_id?: string;
  images?: { media_type: string; data: string }[];
}): UnifiedMessage {
  const content: UnifiedContent[] = [];

  // Images first, then text — matching SessionBridge.sendUserMessage order
  if (msg.images?.length) {
    for (const img of msg.images) {
      content.push({
        type: "image" as const,
        source: {
          type: "base64",
          media_type: img.media_type,
          data: img.data,
        },
      });
    }
  }
  content.push({ type: "text" as const, text: msg.content });

  return createUnifiedMessage({
    type: "user_message",
    role: "user",
    content,
    metadata: {
      session_id: msg.session_id,
    },
  });
}

function normalizePermissionResponse(msg: {
  type: "permission_response";
  request_id: string;
  behavior: "allow" | "deny";
  updated_input?: Record<string, unknown>;
  updated_permissions?: unknown[];
  message?: string;
}): UnifiedMessage {
  return createUnifiedMessage({
    type: "permission_response",
    role: "user",
    metadata: {
      request_id: msg.request_id,
      behavior: msg.behavior,
      updated_input: msg.updated_input,
      updated_permissions: msg.updated_permissions,
      message: msg.message,
    },
  });
}

function normalizeInterrupt(): UnifiedMessage {
  return createUnifiedMessage({
    type: "interrupt",
    role: "user",
  });
}

function normalizeSetModel(msg: { type: "set_model"; model: string }): UnifiedMessage {
  return createUnifiedMessage({
    type: "configuration_change",
    role: "user",
    metadata: {
      subtype: "set_model",
      model: msg.model,
    },
  });
}

function normalizeSetPermissionMode(msg: {
  type: "set_permission_mode";
  mode: string;
}): UnifiedMessage {
  return createUnifiedMessage({
    type: "configuration_change",
    role: "user",
    metadata: {
      subtype: "set_permission_mode",
      mode: msg.mode,
    },
  });
}
