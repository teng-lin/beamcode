/**
 * SdkUrl State Reducer — Phase 1a.1
 *
 * Pure function that applies a UnifiedMessage to SessionState, returning a new
 * state object. Extracted from SessionBridge handler methods.
 *
 * No side effects — does not emit events, persist, or broadcast.
 */

import type { UnifiedMessage } from "../../core/types/unified-message.js";
import type { SessionState } from "../../types/session-state.js";

/**
 * Apply a UnifiedMessage to session state, returning a new state.
 * Returns the original state reference if no fields changed.
 */
export function reduce(state: SessionState, message: UnifiedMessage): SessionState {
  switch (message.type) {
    case "session_init":
      return reduceSessionInit(state, message);
    case "status_change":
      return reduceStatusChange(state, message);
    case "result":
      return reduceResult(state, message);
    case "control_response":
      return reduceControlResponse(state, message);
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Individual reducers
// ---------------------------------------------------------------------------

function reduceSessionInit(state: SessionState, msg: UnifiedMessage): SessionState {
  const m = msg.metadata;
  return {
    ...state,
    model: asString(m.model, state.model),
    cwd: asString(m.cwd, state.cwd),
    tools: asStringArray(m.tools, state.tools),
    permissionMode: asString(m.permissionMode, state.permissionMode),
    claude_code_version: asString(m.claude_code_version, state.claude_code_version),
    mcp_servers: asMcpServers(m.mcp_servers, state.mcp_servers),
    agents: asStringArray(m.agents, state.agents),
    slash_commands: asStringArray(m.slash_commands, state.slash_commands),
    skills: asStringArray(m.skills, state.skills),
  };
}

function reduceStatusChange(state: SessionState, msg: UnifiedMessage): SessionState {
  const m = msg.metadata;
  const status = m.status as string | null | undefined;
  const newState = {
    ...state,
    is_compacting: status === "compacting",
  };

  if (m.permissionMode !== undefined && m.permissionMode !== null) {
    newState.permissionMode = m.permissionMode as string;
  }

  return newState;
}

function reduceResult(state: SessionState, msg: UnifiedMessage): SessionState {
  const m = msg.metadata;
  const newState = { ...state };

  if (typeof m.total_cost_usd === "number") {
    newState.total_cost_usd = m.total_cost_usd;
  }
  if (typeof m.num_turns === "number") {
    newState.num_turns = m.num_turns;
  }
  if (typeof m.total_lines_added === "number") {
    newState.total_lines_added = m.total_lines_added;
  }
  if (typeof m.total_lines_removed === "number") {
    newState.total_lines_removed = m.total_lines_removed;
  }
  if (typeof m.duration_ms === "number") {
    newState.last_duration_ms = m.duration_ms;
  }
  if (typeof m.duration_api_ms === "number") {
    newState.last_duration_api_ms = m.duration_api_ms;
  }

  // Compute context usage from modelUsage — mirrors SessionBridge.handleResultMessage
  const modelUsage = m.modelUsage as
    | Record<
        string,
        {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens: number;
          cacheCreationInputTokens: number;
          contextWindow: number;
          costUSD: number;
        }
      >
    | undefined;

  if (modelUsage) {
    newState.last_model_usage = modelUsage;
    for (const usage of Object.values(modelUsage)) {
      if (usage.contextWindow > 0) {
        newState.context_used_percent = Math.round(
          ((usage.inputTokens + usage.outputTokens) / usage.contextWindow) * 100,
        );
      }
    }
  }

  return newState;
}

function reduceControlResponse(state: SessionState, msg: UnifiedMessage): SessionState {
  const m = msg.metadata;

  if (m.subtype === "error") {
    return state;
  }

  const response = m.response as
    | {
        commands?: unknown[];
        models?: unknown[];
        account?: unknown;
      }
    | undefined;

  if (!response) {
    return state;
  }

  const commands = Array.isArray(response.commands) ? response.commands : [];
  const models = Array.isArray(response.models) ? response.models : [];
  const account = (response.account as Record<string, unknown> | null) ?? null;

  return {
    ...state,
    capabilities: {
      commands,
      models,
      account,
      receivedAt: Date.now(),
    } as SessionState["capabilities"],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? (value as string[]) : fallback;
}

function asMcpServers(
  value: unknown,
  fallback: { name: string; status: string }[],
): { name: string; status: string }[] {
  return Array.isArray(value) ? (value as { name: string; status: string }[]) : fallback;
}
