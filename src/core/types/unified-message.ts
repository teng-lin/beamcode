/**
 * UnifiedMessage type system — Phase 0.1
 *
 * Canonical envelope for all messages flowing through BeamCode, whether they
 * originate from a CLI backend, a consumer frontend, or internal control plane.
 *
 * Design notes:
 * - Envelope-centric: `metadata` is the primary data carrier for non-chat
 *   messages (session_init, status_change, tool_progress, etc.).
 * - `content` is specialised for assistant messages that carry rich blocks.
 * - No `seq` field — sequencing is a transport concern deferred to Phase 2.4.
 * - Forward-compatible: unknown message types pass through via metadata.
 *
 * Deterministic serialization (for Phase 2.3 HMAC signing):
 *   We adopt RFC 8785 (JSON Canonicalization Scheme / JCS). JCS is the IETF
 *   standard for deterministic JSON and relies on two rules:
 *     1. Object keys are sorted recursively by Unicode code-point order.
 *     2. Numbers use ES2015 Number.prototype.toString() (which is the default
 *        behaviour of JSON.stringify in V8/Node).
 *   A lightweight `canonicalize()` helper is provided below. If a validated
 *   third-party implementation is preferred later, `json-canonicalize` (npm)
 *   is a drop-in replacement with the same interface.
 */

// ---------------------------------------------------------------------------
// UnifiedMessageType
// ---------------------------------------------------------------------------

/** All known message types flowing through BeamCode. */
export type UnifiedMessageType =
  | "session_init"
  | "status_change"
  | "assistant"
  | "result"
  | "stream_event"
  | "permission_request"
  | "control_response"
  | "tool_progress"
  | "tool_use_summary"
  | "auth_status"
  | "user_message"
  | "permission_response"
  | "interrupt"
  | "configuration_change"
  | "team_message"
  | "team_task_update"
  | "team_state_change"
  | "session_lifecycle"
  | "unknown";

// ---------------------------------------------------------------------------
// UnifiedContent — discriminated union
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface CodeContent {
  type: "code";
  language: string;
  code: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  budget_tokens?: number;
}

export interface RefusalContent {
  type: "refusal";
  refusal: string;
}

export type UnifiedContent =
  | TextContent
  | ToolUseContent
  | ToolResultContent
  | CodeContent
  | ImageContent
  | ThinkingContent
  | RefusalContent;

/** The discriminant values of UnifiedContent. */
export type UnifiedContentType = UnifiedContent["type"];

// ---------------------------------------------------------------------------
// UnifiedMessage
// ---------------------------------------------------------------------------

export type UnifiedRole = "user" | "assistant" | "system" | "tool";

export interface UnifiedMessage {
  /** Unique message ID (UUID v4). */
  id: string;
  /** Unix epoch milliseconds. */
  timestamp: number;
  /** Semantic message type. */
  type: UnifiedMessageType;
  /** Sender role. */
  role: UnifiedRole;
  /** Rich content blocks (primarily for assistant messages). */
  content: UnifiedContent[];
  /** Arbitrary key-value data carrier — the primary payload for most types. */
  metadata: Record<string, unknown>;
  /** Optional parent message ID for threading. */
  parentId?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateUnifiedMessageParams {
  type: UnifiedMessageType;
  role: UnifiedRole;
  content?: UnifiedContent[];
  metadata?: Record<string, unknown>;
  parentId?: string;
}

/** Create a UnifiedMessage with auto-generated UUID and timestamp. */
export function createUnifiedMessage(params: CreateUnifiedMessageParams): UnifiedMessage {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    type: params.type,
    role: params.role,
    content: params.content ?? [],
    metadata: params.metadata ?? {},
    parentId: params.parentId,
  };
}

// ---------------------------------------------------------------------------
// Content type guards
// ---------------------------------------------------------------------------

export function isTextContent(block: UnifiedContent): block is TextContent {
  return block.type === "text";
}

export function isToolUseContent(block: UnifiedContent): block is ToolUseContent {
  return block.type === "tool_use";
}

export function isToolResultContent(block: UnifiedContent): block is ToolResultContent {
  return block.type === "tool_result";
}

export function isCodeContent(block: UnifiedContent): block is CodeContent {
  return block.type === "code";
}

export function isImageContent(block: UnifiedContent): block is ImageContent {
  return block.type === "image";
}

export function isThinkingContent(block: UnifiedContent): block is ThinkingContent {
  return block.type === "thinking";
}

export function isRefusalContent(block: UnifiedContent): block is RefusalContent {
  return block.type === "refusal";
}

// ---------------------------------------------------------------------------
// UnifiedMessage type guard
// ---------------------------------------------------------------------------

const VALID_MESSAGE_TYPES = new Set<string>([
  "session_init",
  "status_change",
  "assistant",
  "result",
  "stream_event",
  "permission_request",
  "control_response",
  "tool_progress",
  "tool_use_summary",
  "auth_status",
  "user_message",
  "permission_response",
  "interrupt",
  "configuration_change",
  "team_message",
  "team_task_update",
  "team_state_change",
  "session_lifecycle",
  "unknown",
]);

const VALID_ROLES = new Set<string>(["user", "assistant", "system", "tool"]);

/** Runtime validation that an unknown value conforms to UnifiedMessage. */
export function isUnifiedMessage(value: unknown): value is UnifiedMessage {
  if (typeof value !== "object" || value === null) return false;

  const msg = value as Record<string, unknown>;

  if (typeof msg.id !== "string" || msg.id.length === 0) return false;
  if (typeof msg.timestamp !== "number" || !Number.isFinite(msg.timestamp)) return false;
  if (typeof msg.type !== "string" || !VALID_MESSAGE_TYPES.has(msg.type)) return false;
  if (typeof msg.role !== "string" || !VALID_ROLES.has(msg.role)) return false;
  if (!Array.isArray(msg.content)) return false;
  if (typeof msg.metadata !== "object" || msg.metadata === null) return false;
  if (msg.parentId !== undefined && typeof msg.parentId !== "string") return false;

  return true;
}

// ---------------------------------------------------------------------------
// Team message type guards (Phase 5.1)
// ---------------------------------------------------------------------------

export function isTeamMessage(msg: UnifiedMessage): boolean {
  return msg.type === "team_message";
}

export function isTeamTaskUpdate(msg: UnifiedMessage): boolean {
  return msg.type === "team_task_update";
}

export function isTeamStateChange(msg: UnifiedMessage): boolean {
  return msg.type === "team_state_change";
}

// ---------------------------------------------------------------------------
// Canonical JSON serialization (RFC 8785 / JCS)
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic JSON string following RFC 8785 (JCS).
 *
 * Rules applied:
 * - Object keys are sorted recursively by Unicode code-point order.
 * - No whitespace is emitted.
 * - Numbers follow ES2015 serialization (JSON.stringify default in V8).
 * - null, booleans, and strings are serialized by JSON.stringify.
 *
 * This is suitable for HMAC signing where both sides must produce identical
 * byte sequences from the same logical message.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      );
    return `{${pairs.join(",")}}`;
  }
  return "null";
}

// ---------------------------------------------------------------------------
// Canonical error metadata
// ---------------------------------------------------------------------------

/**
 * Canonical error codes used across all adapters in `result` metadata.
 *
 * Adapters normalize their native error representations to these codes
 * so the consumer can distinguish error classes without adapter knowledge.
 */
export type UnifiedErrorCode =
  | "provider_auth"
  | "api_error"
  | "context_overflow"
  | "output_length"
  | "aborted"
  | "rate_limit"
  | "max_turns"
  | "max_budget"
  | "execution_error"
  | "unknown";

/**
 * Shape of error-related metadata keys in `result` messages.
 * Adapters set these keys in `metadata` — this interface documents the contract.
 */
export interface UnifiedErrorMeta {
  error_code: UnifiedErrorCode;
  error_message: string;
  error_source?: string;
}

// ---------------------------------------------------------------------------
// CLI → Unified mapping constant (documents the contract)
// ---------------------------------------------------------------------------

/**
 * Maps each CLIMessage `type` (+ optional `subtype`) to its UnifiedMessageType.
 * This is a documentation / test-support constant — actual conversion logic
 * lives in the adapter layer (Phase 0.2+).
 */
export const CLI_TO_UNIFIED_TYPE_MAP: Record<string, UnifiedMessageType> = {
  "system:init": "session_init",
  "system:status": "status_change",
  assistant: "assistant",
  result: "result",
  stream_event: "stream_event",
  control_request: "permission_request",
  control_response: "control_response",
  tool_progress: "tool_progress",
  tool_use_summary: "tool_use_summary",
  keep_alive: "unknown",
  auth_status: "auth_status",
};

/**
 * Maps each InboundMessage `type` to its UnifiedMessageType.
 */
export const INBOUND_TO_UNIFIED_TYPE_MAP: Record<string, UnifiedMessageType> = {
  user_message: "user_message",
  permission_response: "permission_response",
  interrupt: "interrupt",
  set_model: "configuration_change",
  set_permission_mode: "configuration_change",
  presence_query: "unknown",
  slash_command: "unknown",
};
