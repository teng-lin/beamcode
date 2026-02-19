/**
 * Session State Reducer
 *
 * Pure function that applies a UnifiedMessage to SessionState, returning a new
 * state object. Operates only on core types — no adapter dependencies.
 *
 * Team tool_use blocks are buffered on arrival; tool_result blocks
 * are correlated with buffered tool_uses to drive team state transitions.
 *
 * No side effects — does not emit events, persist, or broadcast.
 */

import type { SessionState } from "../types/session-state.js";
import { reduceTeamState } from "./team-state-reducer.js";
import type { CorrelatedToolUse } from "./team-tool-correlation.js";
import { TeamToolCorrelationBuffer } from "./team-tool-correlation.js";
import { recognizeTeamToolUses } from "./team-tool-recognizer.js";
import type { TeamState } from "./types/team-types.js";
import type { UnifiedMessage } from "./types/unified-message.js";
import { isToolResultContent } from "./types/unified-message.js";

/**
 * Apply a UnifiedMessage to session state, returning a new state.
 * Returns the original state reference if no fields changed.
 *
 * @param correlationBuffer — required; callers must provide a per-session buffer
 *   to prevent cross-session state corruption.
 */
export function reduce(
  state: SessionState,
  message: UnifiedMessage,
  correlationBuffer: TeamToolCorrelationBuffer = new TeamToolCorrelationBuffer(),
): SessionState {
  switch (message.type) {
    case "session_init":
      return reduceSessionInit(state, message);
    case "status_change":
      return reduceStatusChange(state, message);
    case "result":
      return reduceResult(state, message);
    case "control_response":
      return reduceControlResponse(state, message);
    case "configuration_change":
      return reduceConfigurationChange(state, message);
    default:
      break;
  }

  // Process team tool_use and tool_result in any message
  return reduceTeamTools(state, message, correlationBuffer);
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

function reduceConfigurationChange(state: SessionState, msg: UnifiedMessage): SessionState {
  const m = msg.metadata;
  const newState = { ...state };
  let changed = false;

  if (typeof m.model === "string" && m.model !== state.model) {
    newState.model = m.model;
    changed = true;
  }
  if (typeof m.permissionMode === "string" && m.permissionMode !== state.permissionMode) {
    newState.permissionMode = m.permissionMode;
    changed = true;
  }

  return changed ? newState : state;
}

function reduceControlResponse(state: SessionState, _msg: UnifiedMessage): SessionState {
  // Capabilities are applied by the handler (applyCapabilities) which also
  // registers commands and broadcasts capabilities_ready. The reducer must
  // not mutate capabilities here to avoid setting state for messages with
  // unknown request_ids that the handler will ignore.
  return state;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : fallback;
}

function asMcpServers(
  value: unknown,
  fallback: { name: string; status: string }[],
): { name: string; status: string }[] {
  return Array.isArray(value) ? (value as { name: string; status: string }[]) : fallback;
}

// ---------------------------------------------------------------------------
// Team tool integration
// ---------------------------------------------------------------------------

/**
 * Apply a reduced TeamState to the session, updating backward-compat agents[].
 * Returns the original state if the team state is unchanged (reference equality).
 */
function applyTeamState(
  currentState: SessionState,
  newTeamState: TeamState | undefined,
): SessionState {
  if (newTeamState === undefined) {
    if (currentState.team === undefined) return currentState;
    const { team: _team, ...rest } = currentState;
    return { ...rest, agents: [] } as SessionState;
  }
  if (newTeamState === currentState.team) {
    return currentState;
  }
  return {
    ...currentState,
    team: newTeamState,
    agents: newTeamState.members.map((m) => m.name),
  };
}

/**
 * Process team-related tool_use and tool_result content blocks.
 *
 * 1. Scans for team tool_use blocks → buffers and optimistically applies them
 * 2. Scans for tool_result blocks → correlates with buffered tool_uses
 * 3. When correlated, applies reduceTeamState and updates backward-compat agents[]
 * 4. Flushes stale correlation buffer entries (30s TTL)
 */
function reduceTeamTools(
  state: SessionState,
  message: UnifiedMessage,
  correlationBuffer: TeamToolCorrelationBuffer,
): SessionState {
  let currentState = state;

  // 1. Buffer + optimistic apply: apply team state immediately on tool_use
  //    without waiting for tool_result (which the CLI stream may never send).
  //    The correlation path (step 2) remains as a secondary mechanism for
  //    environments where tool_result blocks do arrive.
  const teamUses = recognizeTeamToolUses(message);
  for (const use of teamUses) {
    correlationBuffer.onToolUse(use);
    const optimistic: CorrelatedToolUse = { recognized: use, result: undefined };
    currentState = applyTeamState(currentState, reduceTeamState(currentState.team, optimistic));
  }

  // 2. Correlate any tool_result blocks with buffered team tool_uses
  for (const block of message.content) {
    if (!isToolResultContent(block)) continue;
    const correlated = correlationBuffer.onToolResult(block);
    if (!correlated) continue;
    currentState = applyTeamState(currentState, reduceTeamState(currentState.team, correlated));
  }

  // 3. Flush stale entries (30s TTL)
  correlationBuffer.flush(30_000);

  return currentState;
}
