/**
 * Gemini A2A protocol types — local definitions (no external SDK dependency).
 *
 * Based on the A2A (Agent-to-Agent) protocol with the `development-tool`
 * extension used by `gemini-cli-a2a-server`.
 */

// ---------------------------------------------------------------------------
// Task states
// ---------------------------------------------------------------------------

export type GeminiTaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

// ---------------------------------------------------------------------------
// Message parts
// ---------------------------------------------------------------------------

export interface GeminiTextPart {
  kind: "text";
  text: string;
}

export interface GeminiDataPart {
  kind: "data";
  data: Record<string, unknown>;
}

export type GeminiPart = GeminiTextPart | GeminiDataPart;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface GeminiMessage {
  kind: "message";
  role: "user" | "agent";
  parts: GeminiPart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// SSE event result — discriminated union
// ---------------------------------------------------------------------------

export interface A2ATaskResult {
  kind: "task";
  id: string;
  contextId: string;
  status: {
    state: GeminiTaskState;
    timestamp: string;
  };
}

export interface A2AStatusUpdate {
  kind: "status-update";
  taskId: string;
  contextId: string;
  status: {
    state: GeminiTaskState;
    message?: GeminiMessage;
    timestamp?: string;
  };
  final?: boolean;
  metadata?: {
    coderAgent?: {
      kind: string;
    };
  };
}

export type A2AEventResult = A2ATaskResult | A2AStatusUpdate;

// ---------------------------------------------------------------------------
// SSE event wrapper (JSON-RPC 2.0)
// ---------------------------------------------------------------------------

export interface A2AStreamEvent {
  jsonrpc: "2.0";
  id: number | string;
  result?: A2AEventResult;
  error?: {
    code: number;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// ToolCall (development-tool extension)
// ---------------------------------------------------------------------------

export type ToolCallStatus = "PENDING" | "EXECUTING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface ToolCall {
  tool_call_id: string;
  status: ToolCallStatus;
  tool_name: string;
  description?: string;
  input_parameters?: Record<string, unknown>;
  live_content?: string;
  confirmation_request?: ConfirmationRequest;
  output?: { text?: string };
  error?: { message: string };
}

export interface ConfirmationRequest {
  options: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
}

export interface ToolCallConfirmation {
  tool_call_id: string;
  selected_option_id: string;
}

// ---------------------------------------------------------------------------
// CoderAgent metadata event kinds
// ---------------------------------------------------------------------------

export type CoderAgentEventKind =
  | "tool-call-confirmation"
  | "tool-call-update"
  | "text-content"
  | "state-change"
  | "thought"
  | "citation";
