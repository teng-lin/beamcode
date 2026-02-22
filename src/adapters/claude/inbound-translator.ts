/**
 * Claude Inbound Translator (T2: UnifiedMessage → Claude NDJSON).
 *
 * Converts outbound UnifiedMessages into the NDJSON strings that the
 * Claude Code CLI expects on its WebSocket connection.
 */

import type { UnifiedMessage } from "../../core/types/unified-message.js";

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
