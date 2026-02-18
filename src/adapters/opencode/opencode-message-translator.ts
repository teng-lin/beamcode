/**
 * OpenCode Message Translator
 *
 * Pure functions that translate between opencode SSE events and BeamCode's
 * UnifiedMessage envelope.
 *
 * opencode uses an SSE event stream where each event has a `type` and
 * `properties` payload. Sessions are identified by `sessionID` embedded in
 * the properties of most events.
 *
 * No side effects, no state mutation, no I/O.
 */

import type { UnifiedContent, UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type {
  OpencodeEvent,
  OpencodePart,
  OpencodePartInput,
  OpencodeToolPart,
  OpencodeToolState,
} from "./opencode-types.js";

// ---------------------------------------------------------------------------
// Outbound action type
// ---------------------------------------------------------------------------

export type OpencodeAction =
  | { type: "prompt"; parts: OpencodePartInput[]; model?: { providerID: string; modelID: string } }
  | { type: "permission_reply"; requestId: string; reply: "once" | "always" | "reject" }
  | { type: "abort" };

// ---------------------------------------------------------------------------
// SSE event → UnifiedMessage (inbound from opencode)
// ---------------------------------------------------------------------------

/**
 * Translate an opencode SSE event into a UnifiedMessage.
 * Returns `null` for events that don't produce user-facing messages.
 */
export function translateEvent(event: OpencodeEvent): UnifiedMessage | null {
  switch (event.type) {
    case "message.part.updated":
      return translatePartUpdated(event.properties.part, event.properties.delta);
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
    // Non-user-facing events
    case "server.heartbeat":
    case "permission.replied":
    case "session.compacted":
    case "session.created":
    case "session.updated":
    case "session.deleted":
    case "session.diff":
    case "message.removed":
    case "message.part.removed":
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// UnifiedMessage → opencode action (outbound to opencode)
// ---------------------------------------------------------------------------

/**
 * Translate a UnifiedMessage into an opencode action for sending over the wire.
 */
export function translateToOpencode(message: UnifiedMessage): OpencodeAction {
  switch (message.type) {
    case "user_message":
      return translateUserMessageToPrompt(message);
    case "permission_response":
      return translatePermissionResponse(message);
    case "interrupt":
      return { type: "abort" };
    default:
      return translateUserMessageToPrompt(message);
  }
}

// ---------------------------------------------------------------------------
// Session ID extraction
// ---------------------------------------------------------------------------

/**
 * Extract the session ID from any opencode SSE event for demuxing.
 * Returns `undefined` for events that have no session scope
 * (e.g. server.connected, server.heartbeat).
 */
export function extractSessionId(event: OpencodeEvent): string | undefined {
  switch (event.type) {
    case "server.connected":
    case "server.heartbeat":
      return undefined;
    case "session.created":
    case "session.updated":
      return event.properties.session.id;
    case "session.deleted":
      return event.properties.sessionID;
    case "session.status":
      return event.properties.sessionID;
    case "session.error":
      return event.properties.sessionID;
    case "session.compacted":
      return event.properties.sessionID;
    case "session.diff":
      return event.properties.sessionID;
    case "message.updated":
      return event.properties.info.sessionID;
    case "message.removed":
      return event.properties.sessionID;
    case "message.part.updated":
      return event.properties.part.sessionID;
    case "message.part.removed":
      return event.properties.sessionID;
    case "permission.updated":
      return event.properties.sessionID;
    case "permission.replied":
      return event.properties.sessionID;
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
      return createUnifiedMessage({
        type: "stream_event",
        role: "assistant",
        metadata: {
          delta: delta ?? "",
          part_id: part.id,
          message_id: part.messageID,
          session_id: part.sessionID,
          text: part.text,
          reasoning: false,
        },
      });
    case "reasoning":
      return createUnifiedMessage({
        type: "stream_event",
        role: "assistant",
        metadata: {
          delta: delta ?? "",
          part_id: part.id,
          message_id: part.messageID,
          session_id: part.sessionID,
          text: part.text,
          reasoning: true,
        },
      });
    case "tool":
      return translateToolPart(part);
    case "step-start":
    case "step-finish":
      // Not directly user-facing as individual messages
      return null;
    default:
      return null;
  }
}

function translateToolPart(part: OpencodeToolPart): UnifiedMessage | null {
  const state: OpencodeToolState = part.state;

  if (state.status === "running") {
    return createUnifiedMessage({
      type: "tool_progress",
      role: "tool",
      metadata: {
        part_id: part.id,
        message_id: part.messageID,
        session_id: part.sessionID,
        call_id: part.callID,
        tool: part.tool,
        input: state.input,
        title: state.title,
        status: "running",
      },
    });
  }

  if (state.status === "completed") {
    return createUnifiedMessage({
      type: "tool_use_summary",
      role: "tool",
      metadata: {
        part_id: part.id,
        message_id: part.messageID,
        session_id: part.sessionID,
        call_id: part.callID,
        tool: part.tool,
        input: state.input,
        output: state.output,
        title: state.title,
        status: "completed",
        time: state.time,
      },
    });
  }

  if (state.status === "error") {
    return createUnifiedMessage({
      type: "tool_use_summary",
      role: "tool",
      metadata: {
        part_id: part.id,
        message_id: part.messageID,
        session_id: part.sessionID,
        call_id: part.callID,
        tool: part.tool,
        input: state.input,
        error: state.error,
        status: "error",
        is_error: true,
        time: state.time,
      },
    });
  }

  // "pending" — not yet actionable for the user
  return null;
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
        provider_id: info.providerID,
        cost: info.cost,
        tokens: info.tokens,
        finish: info.finish,
        error: info.error,
      },
    });
  }

  // user message echo
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
  if (status.type === "idle") {
    return createUnifiedMessage({
      type: "result",
      role: "system",
      metadata: {
        session_id: sessionID,
        status: "completed",
      },
    });
  }

  if (status.type === "busy") {
    return createUnifiedMessage({
      type: "status_change",
      role: "system",
      metadata: {
        session_id: sessionID,
        busy: true,
      },
    });
  }

  // retry
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

function translateSessionError(
  sessionID: string,
  error: { name: string; data: { message: string } },
): UnifiedMessage {
  return createUnifiedMessage({
    type: "result",
    role: "system",
    metadata: {
      session_id: sessionID,
      is_error: true,
      error_name: error.name,
      error_message: error.data.message,
    },
  });
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

  // Fall back to metadata.text if content is empty
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

  const reply: "once" | "always" | "reject" = behavior === "allow" ? "once" : "reject";

  return { type: "permission_reply", requestId, reply };
}

// ---------------------------------------------------------------------------
// Internal: content helpers (kept for potential future use)
// ---------------------------------------------------------------------------

/** Extract text content blocks from a UnifiedMessage. */
function _extractTextContent(content: UnifiedContent[]): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

void _extractTextContent; // suppress "unused" lint — intentional utility
