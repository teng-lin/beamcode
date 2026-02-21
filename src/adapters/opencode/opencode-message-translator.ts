/**
 * OpenCode Message Translator
 *
 * Pure functions that translate between opencode SSE events and BeamCode's
 * UnifiedMessage envelope. No side effects, no state mutation, no I/O.
 */

import type { UnifiedContent, UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type {
  OpencodeEvent,
  OpencodeMessageError,
  OpencodePart,
  OpencodePartInput,
  OpencodeToolPart,
} from "./opencode-types.js";

// ---------------------------------------------------------------------------
// Outbound action type
// ---------------------------------------------------------------------------

export type OpencodeAction =
  | { type: "prompt"; parts: OpencodePartInput[]; model?: { providerID: string; modelID: string } }
  | { type: "permission_reply"; requestId: string; reply: "once" | "always" | "reject" }
  | { type: "abort" }
  | { type: "noop" };

// ---------------------------------------------------------------------------
// SSE event → UnifiedMessage (inbound from opencode)
// ---------------------------------------------------------------------------

export function translateEvent(event: OpencodeEvent): UnifiedMessage | null {
  switch (event.type) {
    case "message.part.updated":
      return translatePartUpdated(event.properties.part, event.properties.delta);
    case "message.part.delta":
      return translatePartDelta(event.properties);
    case "message.updated":
      return translateMessageUpdated(event.properties.info);
    case "session.status":
      return translateSessionStatus(event.properties.sessionID, event.properties.status);
    case "session.error":
      return translateSessionError(event.properties.sessionID, event.properties.error);
    case "permission.updated":
      return translatePermissionUpdated(event.properties);
    case "server.connected":
      return translateServerConnected();
    case "session.compacted":
      return createUnifiedMessage({
        type: "session_lifecycle",
        role: "system",
        metadata: {
          subtype: "session_compacted",
          session_id: event.properties.sessionID,
        },
      });
    case "message.removed":
      return createUnifiedMessage({
        type: "session_lifecycle",
        role: "system",
        metadata: {
          subtype: "message_removed",
          session_id: event.properties.sessionID,
          message_id: event.properties.messageID,
        },
      });
    case "server.heartbeat":
    case "permission.replied":
    case "session.created":
    case "session.updated":
    case "session.deleted":
    case "session.diff":
    case "message.part.removed":
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// UnifiedMessage → opencode action (outbound to opencode)
// ---------------------------------------------------------------------------

export function translateToOpencode(message: UnifiedMessage): OpencodeAction {
  switch (message.type) {
    case "user_message":
      return translateUserMessageToPrompt(message);
    case "permission_response":
      return translatePermissionResponse(message);
    case "interrupt":
      return { type: "abort" };
    case "session_init":
    case "configuration_change":
      return { type: "noop" };
    default:
      throw new Error(`Unsupported message type for opencode: ${message.type}`);
  }
}

// ---------------------------------------------------------------------------
// Session ID extraction
// ---------------------------------------------------------------------------

export function extractSessionId(event: OpencodeEvent): string | undefined {
  const properties = event.properties as Record<string, unknown> | undefined;

  switch (event.type) {
    case "server.connected":
    case "server.heartbeat":
      return undefined;
    case "session.created":
    case "session.updated":
      return (
        ((properties?.info as { id?: string } | undefined)?.id ??
          (properties?.session as { id?: string } | undefined)?.id) ||
        undefined
      );
    case "message.updated":
      return (properties?.info as { sessionID?: string } | undefined)?.sessionID;
    case "message.part.updated":
      return (properties?.part as { sessionID?: string } | undefined)?.sessionID;
    case "message.part.delta":
      return (properties as { sessionID?: string } | undefined)?.sessionID;
    case "session.deleted":
    case "session.status":
    case "session.error":
    case "session.compacted":
    case "session.diff":
    case "message.removed":
    case "message.part.removed":
    case "permission.updated":
    case "permission.replied":
      return (properties as { sessionID?: string } | undefined)?.sessionID;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Internal: event-type translators
// ---------------------------------------------------------------------------

function translatePartUpdated(part: OpencodePart, delta?: string): UnifiedMessage | null {
  switch (part.type) {
    case "text":
    case "reasoning": {
      const isReasoning = part.type === "reasoning";
      const hasDelta = typeof delta === "string" && delta.length > 0;
      const content: UnifiedContent[] =
        isReasoning && part.text ? [{ type: "thinking", thinking: part.text }] : [];
      return createUnifiedMessage({
        type: "stream_event",
        role: "assistant",
        content,
        metadata: {
          delta: delta ?? "",
          part_id: part.id,
          message_id: part.messageID,
          session_id: part.sessionID,
          text: part.text,
          ...(hasDelta && {
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: delta },
            },
          }),
          ...(isReasoning && { reasoning: true }),
        },
      });
    }
    case "tool":
      return translateToolPart(part);
    case "step-start":
    case "step-finish":
      return createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: {
          session_id: part.sessionID,
          step: part.type === "step-start" ? "start" : "finish",
          step_id: part.id,
          message_id: part.messageID,
        },
      });
    default:
      return null;
  }
}

function translatePartDelta(properties: {
  sessionID: string;
  messageID: string;
  partID: string;
  field: string;
  delta: string;
}): UnifiedMessage | null {
  if (properties.field !== "text" || properties.delta.length === 0) {
    return null;
  }

  return createUnifiedMessage({
    type: "stream_event",
    role: "assistant",
    metadata: {
      delta: properties.delta,
      part_id: properties.partID,
      message_id: properties.messageID,
      session_id: properties.sessionID,
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: properties.delta },
      },
    },
  });
}

function translateToolPart(part: OpencodeToolPart): UnifiedMessage | null {
  const shared = {
    part_id: part.id,
    message_id: part.messageID,
    session_id: part.sessionID,
    tool_use_id: part.callID,
    tool: part.tool,
  };

  switch (part.state.status) {
    case "running":
      return createUnifiedMessage({
        type: "tool_progress",
        role: "tool",
        metadata: {
          ...shared,
          input: part.state.input,
          title: part.state.title,
          status: "running",
        },
      });
    case "completed":
      return createUnifiedMessage({
        type: "tool_use_summary",
        role: "tool",
        metadata: {
          ...shared,
          input: part.state.input,
          output: part.state.output,
          title: part.state.title,
          status: "completed",
          time: part.state.time,
        },
      });
    case "error":
      return createUnifiedMessage({
        type: "tool_use_summary",
        role: "tool",
        metadata: {
          ...shared,
          input: part.state.input,
          error: part.state.error,
          status: "error",
          is_error: true,
          time: part.state.time,
        },
      });
    case "pending":
      return createUnifiedMessage({
        type: "tool_progress",
        role: "tool",
        metadata: {
          ...shared,
          input: part.state.input,
          status: "pending",
        },
      });
  }
}

function translateMessageUpdated(
  info:
    | { role: "user"; id: string; sessionID: string }
    | {
        role: "assistant";
        id: string;
        sessionID: string;
        modelID: string;
        providerID: string;
        cost: number;
        tokens: {
          input: number;
          output: number;
          reasoning: number;
          cache: { read: number; write: number };
        };
        error?: { name: string; data: { message: string } };
        finish?: string;
      },
): UnifiedMessage {
  if (info.role === "assistant") {
    return createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      metadata: {
        message_id: info.id,
        session_id: info.sessionID,
        model_id: info.modelID,
        model: info.modelID,
        provider_id: info.providerID,
        cost: info.cost,
        tokens: info.tokens,
        finish: info.finish,
        error: info.error,
      },
    });
  }

  return createUnifiedMessage({
    type: "user_message",
    role: "user",
    metadata: {
      message_id: info.id,
      session_id: info.sessionID,
    },
  });
}

function translateSessionStatus(
  sessionID: string,
  status:
    | { type: "idle" }
    | { type: "busy" }
    | { type: "retry"; attempt: number; message: string; next: number },
): UnifiedMessage {
  switch (status.type) {
    case "idle":
      return createUnifiedMessage({
        type: "result",
        role: "system",
        metadata: { session_id: sessionID, status: "completed" },
      });
    case "busy":
      return createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: { session_id: sessionID, busy: true },
      });
    case "retry":
      return createUnifiedMessage({
        type: "status_change",
        role: "system",
        metadata: {
          session_id: sessionID,
          retry: true,
          attempt: status.attempt,
          message: status.message,
          next: status.next,
        },
      });
  }
}

function translateSessionError(sessionID: string, error: OpencodeMessageError): UnifiedMessage {
  return createUnifiedMessage({
    type: "result",
    role: "system",
    metadata: {
      session_id: sessionID,
      is_error: true,
      error_name: error.name,
      error_message: error.data.message,
      error_code: normalizeOpencodeErrorCode(error.name),
      ...(error.name === "api_error" &&
        "status" in error.data &&
        typeof error.data.status === "number" && { error_status: error.data.status }),
    },
  });
}

const KNOWN_OPENCODE_ERROR_CODES = new Set([
  "provider_auth",
  "output_length",
  "aborted",
  "context_overflow",
  "api_error",
]);

function normalizeOpencodeErrorCode(name: string): string {
  return KNOWN_OPENCODE_ERROR_CODES.has(name) ? name : "unknown";
}

function translatePermissionUpdated(properties: {
  id: string;
  sessionID: string;
  permission: string;
  title?: string;
  metadata?: Record<string, unknown>;
}): UnifiedMessage {
  return createUnifiedMessage({
    type: "permission_request",
    role: "system",
    metadata: {
      request_id: properties.id,
      session_id: properties.sessionID,
      permission: properties.permission,
      title: properties.title,
      extra: properties.metadata,
    },
  });
}

function translateServerConnected(): UnifiedMessage {
  return createUnifiedMessage({
    type: "session_init",
    role: "system",
    metadata: {},
  });
}

// ---------------------------------------------------------------------------
// Internal: outbound translators
// ---------------------------------------------------------------------------

function translateUserMessageToPrompt(message: UnifiedMessage): OpencodeAction {
  const parts: OpencodePartInput[] = message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => ({ type: "text" as const, text: c.text }));

  if (parts.length === 0) {
    const text = (message.metadata.text as string) ?? "";
    if (text) {
      parts.push({ type: "text", text });
    }
  }

  const model = message.metadata.model as { providerID: string; modelID: string } | undefined;

  return { type: "prompt", parts, model };
}

function translatePermissionResponse(message: UnifiedMessage): OpencodeAction {
  const requestId = (message.metadata.request_id as string) ?? "";
  const behavior = message.metadata.behavior as string | undefined;

  const reply: "once" | "always" | "reject" =
    behavior === "allow" ? "once" : behavior === "always" ? "always" : "reject";

  return { type: "permission_reply", requestId, reply };
}
