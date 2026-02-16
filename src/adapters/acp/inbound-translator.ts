/**
 * ACP Inbound Translator — Phase 3
 *
 * Pure function that translates UnifiedMessage → ACP JSON-RPC action.
 * No side effects, no state mutation, no I/O.
 */

import type { UnifiedMessage } from "../../core/types/unified-message.js";

// ---------------------------------------------------------------------------
// ACP outbound action type
// ---------------------------------------------------------------------------

export interface AcpOutboundAction {
  type: "request" | "notification" | "response";
  /** JSON-RPC method (for requests/notifications). */
  method?: string;
  /** JSON-RPC params (for requests/notifications). */
  params?: unknown;
  /** JSON-RPC request ID to echo back (for responses). */
  requestId?: number | string;
  /** JSON-RPC result payload (for responses). */
  result?: unknown;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translate a UnifiedMessage into an ACP JSON-RPC action.
 *
 * Returns `null` for message types that don't map to an ACP action
 * (e.g. assistant, result — those flow outbound only).
 */
export function translateToAcp(
  message: UnifiedMessage,
  context?: { pendingRequestId?: number | string },
): AcpOutboundAction | null {
  switch (message.type) {
    case "user_message":
      return translateUserMessage(message);
    case "permission_response":
      return translatePermissionResponse(message, context);
    case "interrupt":
      return translateInterrupt();
    case "configuration_change":
      return translateConfigurationChange(message);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Internal translators
// ---------------------------------------------------------------------------

function translateUserMessage(message: UnifiedMessage): AcpOutboundAction {
  // Extract text content blocks and wrap as ACP prompt content
  const prompt = message.content.map((block) => {
    if (block.type === "text") {
      return { type: "text" as const, text: block.text };
    }
    if (block.type === "image" && block.source) {
      return {
        type: "image" as const,
        mimeType: block.source.media_type,
        data: block.source.data,
      };
    }
    return { type: "text" as const, text: "" };
  });

  return {
    type: "request",
    method: "session/prompt",
    params: {
      sessionId: (message.metadata.sessionId as string) ?? (message.metadata.session_id as string),
      prompt,
    },
  };
}

function translatePermissionResponse(
  message: UnifiedMessage,
  context?: { pendingRequestId?: number | string },
): AcpOutboundAction {
  const behavior = message.metadata.behavior as string;
  const requestId = context?.pendingRequestId;

  let outcome: Record<string, unknown>;
  if (behavior === "allow") {
    // Map to ACP "selected" outcome with the allow option
    const optionId = (message.metadata.optionId as string) ?? "allow-once";
    outcome = { outcome: "selected", optionId };
  } else {
    // Map deny to "selected" with the reject option
    const optionId = (message.metadata.optionId as string) ?? "reject-once";
    outcome = { outcome: "selected", optionId };
  }

  return {
    type: "response",
    requestId,
    result: { outcome },
  };
}

function translateInterrupt(): AcpOutboundAction {
  return {
    type: "notification",
    method: "session/cancel",
  };
}

function translateConfigurationChange(message: UnifiedMessage): AcpOutboundAction {
  const subtype = message.metadata.subtype as string;

  if (subtype === "set_model") {
    return {
      type: "request",
      method: "session/set_model",
      params: { model: message.metadata.model as string },
    };
  }

  if (subtype === "set_mode" || subtype === "set_permission_mode") {
    const modeId = (message.metadata.modeId as string) ?? (message.metadata.mode as string);
    return {
      type: "request",
      method: "session/set_mode",
      params: { modeId },
    };
  }

  return {
    type: "request",
    method: "session/set_mode",
    params: { subtype, ...message.metadata },
  };
}
