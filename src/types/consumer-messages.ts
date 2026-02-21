import type { ConsumerRole } from "./auth.js";
import type { SessionState } from "./session-state.js";

/** Version for bridge -> consumer protocol envelopes. */
export const CONSUMER_PROTOCOL_VERSION = 1 as const;

// ── Consumer-facing normalized types (adapter-agnostic) ──────────────────────
// These types decouple consumer-facing APIs from any specific backend (e.g. CLI).
// They mirror the relevant data shapes without importing backend-specific modules.

/** Content block in an assistant message. */
export type ConsumerContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ConsumerContentBlock[];
      is_error?: boolean;
    }
  | { type: "thinking"; thinking: string; budget_tokens?: number }
  | { type: "code"; language: string; code: string }
  | { type: "image"; media_type: string; data: string }
  | { type: "refusal"; refusal: string };

/** The assistant message payload (adapter-agnostic). */
export interface AssistantContent {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ConsumerContentBlock[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

/**
 * Result data from a completed turn (adapter-agnostic).
 *
 * Shape change: `uuid`, `session_id`, and `type` fields from CLIResultMessage
 * are no longer included — these are backend transport concerns.
 */
export interface ResultData {
  subtype:
    | "success"
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries";
  is_error: boolean;
  result?: string;
  errors?: string[];
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  modelUsage?: Record<
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
  >;
  total_lines_added?: number;
  total_lines_removed?: number;
  error_code?: string;
  error_message?: string;
  error_data?: Record<string, unknown>;
}

/** Permission request surfaced to consumers (adapter-agnostic). */
export interface ConsumerPermissionRequest {
  request_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  permission_suggestions?: unknown[];
  description?: string;
  tool_use_id: string;
  agent_id?: string;
  timestamp: number;
}

/** Command metadata for /slash commands. */
interface InitializeCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/** Model metadata. */
interface InitializeModel {
  value: string;
  displayName: string;
  description?: string;
}

/** Account metadata. */
interface InitializeAccount {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
}

/** Messages the bridge sends to consumers (browser, agent, etc.) */
export type ConsumerMessage =
  | {
      type: "session_init";
      session: SessionState;
      protocol_version?: typeof CONSUMER_PROTOCOL_VERSION;
    }
  | { type: "session_update"; session: Partial<SessionState> }
  | {
      type: "assistant";
      message: AssistantContent;
      parent_tool_use_id: string | null;
    }
  | {
      type: "stream_event";
      event: unknown;
      parent_tool_use_id: string | null;
    }
  | { type: "result"; data: ResultData }
  | { type: "permission_request"; request: ConsumerPermissionRequest }
  | { type: "permission_cancelled"; request_id: string }
  | {
      type: "tool_progress";
      tool_use_id: string;
      tool_name: string;
      elapsed_time_seconds: number;
    }
  | {
      type: "tool_use_summary";
      summary: string;
      tool_use_ids: string[];
      tool_use_id?: string;
      tool_name?: string;
      status?: string;
      is_error?: boolean;
      input?: unknown;
      output?: unknown;
      error?: unknown;
    }
  | {
      type: "status_change";
      status: "compacting" | "idle" | "running" | null;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "auth_status";
      isAuthenticating: boolean;
      output: string[];
      error?: string;
      validationLink?: string;
    }
  | { type: "error"; message: string }
  | { type: "cli_disconnected" }
  | { type: "cli_connected" }
  | { type: "user_message"; content: string; timestamp: number }
  | { type: "message_history"; messages: ConsumerMessage[] }
  | { type: "session_name_update"; name: string }
  | { type: "identity"; userId: string; displayName: string; role: ConsumerRole }
  | {
      type: "presence_update";
      consumers: Array<{ userId: string; displayName: string; role: ConsumerRole }>;
    }
  | {
      type: "slash_command_result";
      command: string;
      request_id?: string;
      content: string;
      source: "emulated" | "cli";
    }
  | {
      type: "slash_command_error";
      command: string;
      request_id?: string;
      error: string;
    }
  | {
      type: "capabilities_ready";
      commands: InitializeCommand[];
      models: InitializeModel[];
      account: InitializeAccount | null;
      skills: string[];
    }
  | { type: "resume_failed"; sessionId: string }
  | {
      type: "process_output";
      stream: "stdout" | "stderr";
      data: string;
    }
  | {
      type: "message_queued";
      consumer_id: string;
      display_name: string;
      content: string;
      images?: { media_type: string; data: string }[];
      queued_at: number;
    }
  | {
      type: "queued_message_updated";
      content: string;
      images?: { media_type: string; data: string }[];
    }
  | { type: "queued_message_cancelled" }
  | { type: "queued_message_sent" }
  | {
      type: "configuration_change";
      subtype: string;
      metadata: Record<string, unknown>;
    }
  | {
      type: "session_lifecycle";
      subtype: string;
      metadata: Record<string, unknown>;
    };
