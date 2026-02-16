// ── Flattened consumer-facing types ─────────────────────────────────────────
// Standalone file for the web frontend — NO imports from core/ or backend.
// Mirrors the relevant shapes from src/types/ without pulling in the full chain.

// ── Content Blocks ──────────────────────────────────────────────────────────

export type ConsumerContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ConsumerContentBlock[];
      is_error?: boolean;
    }
  | { type: "thinking"; thinking: string; budget_tokens?: number };

// ── Assistant Message ───────────────────────────────────────────────────────

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

// ── Result ──────────────────────────────────────────────────────────────────

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
}

// ── Permission Request ──────────────────────────────────────────────────────

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

// ── Command & Model metadata ────────────────────────────────────────────────

export interface InitializeCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface InitializeModel {
  value: string;
  displayName: string;
  description?: string;
}

export interface InitializeAccount {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
}

// ── Team Types (flattened for frontend) ──────────────────────────────────────

export interface ConsumerTeamMember {
  name: string;
  agentId: string;
  agentType: string;
  status: "active" | "idle" | "shutdown";
  model?: string;
  color?: string;
}

export interface ConsumerTeamTask {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  owner?: string;
  activeForm?: string;
  blockedBy: string[];
  blocks: string[];
}

export interface ConsumerTeamState {
  name: string;
  role: "lead" | "teammate";
  members: ConsumerTeamMember[];
  tasks: ConsumerTeamTask[];
}

// ── Consumer Session State (flattened subset) ───────────────────────────────

export interface ConsumerSessionState {
  session_id: string;
  model: string;
  cwd: string;
  total_cost_usd: number;
  num_turns: number;
  context_used_percent: number;
  is_compacting: boolean;
  // Optional fields from deeper state
  git_branch?: string;
  total_lines_added?: number;
  total_lines_removed?: number;
  tools?: string[];
  permissionMode?: string;
  mcp_servers?: { name: string; status: string }[];
  last_model_usage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      contextWindow: number;
      costUSD: number;
    }
  >;
  last_duration_ms?: number;
  last_duration_api_ms?: number;
  team?: ConsumerTeamState | null;
}

// ── Stream Events ──────────────────────────────────────────────────────────

export type StreamEvent =
  | { type: "message_start"; message?: Record<string, unknown> }
  | {
      type: "content_block_delta";
      index?: number;
      delta: { type: "text_delta"; text: string } | { type: string; [key: string]: unknown };
    }
  | { type: "content_block_start"; index?: number; content_block?: Record<string, unknown> }
  | { type: "content_block_stop"; index?: number }
  | { type: "message_delta"; delta?: Record<string, unknown>; usage?: { output_tokens: number } }
  | { type: "message_stop" }
  | { type: string; [key: string]: unknown };

// ── Connection Status ───────────────────────────────────────────────────────

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

// ── Consumer Role ───────────────────────────────────────────────────────────

export type ConsumerRole = "owner" | "operator" | "participant" | "observer";

// ── Outbound Messages (bridge → consumer) ───────────────────────────────────

export type ConsumerMessage =
  | { type: "session_init"; session: ConsumerSessionState & Record<string, unknown> }
  | { type: "session_update"; session: Partial<ConsumerSessionState> & Record<string, unknown> }
  | { type: "assistant"; message: AssistantContent; parent_tool_use_id: string | null }
  | { type: "stream_event"; event: StreamEvent; parent_tool_use_id: string | null }
  | { type: "result"; data: ResultData }
  | { type: "permission_request"; request: ConsumerPermissionRequest }
  | { type: "permission_cancelled"; request_id: string }
  | { type: "tool_progress"; tool_use_id: string; tool_name: string; elapsed_time_seconds: number }
  | { type: "tool_use_summary"; summary: string; tool_use_ids: string[] }
  | { type: "status_change"; status: "compacting" | "idle" | "running" | null }
  | { type: "auth_status"; isAuthenticating: boolean; output: string[]; error?: string }
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
      source: "emulated" | "pty";
    }
  | { type: "slash_command_error"; command: string; request_id?: string; error: string }
  | {
      type: "capabilities_ready";
      commands: InitializeCommand[];
      models: InitializeModel[];
      account: InitializeAccount | null;
      skills: string[];
    };

// ── Inbound Messages (consumer → bridge) ────────────────────────────────────

export type InboundMessage =
  | {
      type: "user_message";
      content: string;
      session_id?: string;
      images?: { media_type: string; data: string }[];
    }
  | {
      type: "permission_response";
      request_id: string;
      behavior: "allow" | "deny";
      updated_input?: Record<string, unknown>;
      message?: string;
    }
  | { type: "interrupt" }
  | { type: "set_model"; model: string }
  | { type: "set_permission_mode"; mode: string }
  | { type: "presence_query" }
  | { type: "slash_command"; command: string; request_id?: string };
