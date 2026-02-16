/**
 * SdkUrl Inbound Translator — Phase 1b.3
 *
 * Two responsibilities:
 * 1. normalizeInbound: InboundMessage → UnifiedMessage (normalize consumer input)
 * 2. toNDJSON: UnifiedMessage → NDJSON string (for sending to CLI)
 *
 * Both are pure functions — no side effects, no state mutation, no I/O.
 */

import type { UnifiedContent, UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { InboundMessage } from "../../types/inbound-messages.js";

// ---------------------------------------------------------------------------
// InboundMessage → UnifiedMessage
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// UnifiedMessage → NDJSON string (for CLI)
// ---------------------------------------------------------------------------

/**
 * Convert a UnifiedMessage into the NDJSON string the CLI expects.
 *
 * Returns `null` for message types that aren't sent as NDJSON (e.g. interrupt
 * uses a signal, not a message).
 */
export function toNDJSON(msg: UnifiedMessage): string | null {
  switch (msg.type) {
    case "user_message":
      return userMessageToNDJSON(msg);
    case "permission_response":
      return permissionResponseToNDJSON(msg);
    case "interrupt":
      return interruptToNDJSON();
    case "configuration_change":
      return configurationChangeToNDJSON(msg);
    default:
      return null;
  }
}

function userMessageToNDJSON(msg: UnifiedMessage): string {
  // Build content: if images are present, use content block array; otherwise plain string
  const textBlock = msg.content.find((b) => b.type === "text");
  const imageBlocks = msg.content.filter((b) => b.type === "image");
  const text = textBlock && textBlock.type === "text" ? textBlock.text : "";

  let messageContent: string | unknown[];
  if (imageBlocks.length > 0) {
    const blocks: unknown[] = [];
    for (const img of imageBlocks) {
      if (img.type === "image") {
        blocks.push({
          type: "image",
          source: img.source,
        });
      }
    }
    blocks.push({ type: "text", text });
    messageContent = blocks;
  } else {
    messageContent = text;
  }

  return JSON.stringify({
    type: "user",
    message: { role: "user", content: messageContent },
    parent_tool_use_id: null,
    session_id: (msg.metadata.session_id as string) || "",
  });
}

function permissionResponseToNDJSON(msg: UnifiedMessage): string {
  const m = msg.metadata;
  const behavior = m.behavior as string;

  let innerResponse: Record<string, unknown>;
  if (behavior === "allow") {
    innerResponse = {
      behavior: "allow",
      updatedInput: (m.updated_input as Record<string, unknown>) ?? {},
    };
    const updatedPermissions = m.updated_permissions as unknown[] | undefined;
    if (updatedPermissions?.length) {
      innerResponse.updatedPermissions = updatedPermissions;
    }
  } else {
    innerResponse = {
      behavior: "deny",
      message: (m.message as string) || "Denied by user",
    };
  }

  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: m.request_id,
      response: innerResponse,
    },
  });
}

function interruptToNDJSON(): string {
  return JSON.stringify({
    type: "control_request",
    request_id: crypto.randomUUID(),
    request: { subtype: "interrupt" },
  });
}

function configurationChangeToNDJSON(msg: UnifiedMessage): string {
  const m = msg.metadata;
  const subtype = m.subtype as string;

  if (subtype === "set_model") {
    return JSON.stringify({
      type: "control_request",
      request_id: crypto.randomUUID(),
      request: { subtype: "set_model", model: m.model },
    });
  }

  if (subtype === "set_permission_mode") {
    return JSON.stringify({
      type: "control_request",
      request_id: crypto.randomUUID(),
      request: { subtype: "set_permission_mode", mode: m.mode },
    });
  }

  return JSON.stringify({
    type: "control_request",
    request_id: crypto.randomUUID(),
    request: { subtype },
  });
}
