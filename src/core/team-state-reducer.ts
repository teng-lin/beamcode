/**
 * Team State Reducer — pure TeamState builder from correlated tool pairs.
 *
 * Pure function that builds/updates TeamState from correlated team tool pairs.
 * All operations are idempotent — applying the same update twice produces the
 * same state (critical for reconnection replay scenarios).
 *
 * Returns:
 * - New TeamState on state-changing operations
 * - The input state unchanged on read-only operations (TaskGet, TaskList, most SendMessage)
 * - undefined when team is dissolved (TeamDelete)
 *
 * @module MessagePlane
 */

import type { CorrelatedToolUse } from "./team-tool-correlation.js";
import type { TeamMember, TeamState, TeamTask } from "./types/team-types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reduces a correlated team tool pair into an updated TeamState.
 *
 * Returns the new TeamState, or undefined if the team was dissolved (TeamDelete).
 * Returns the input state unchanged if the tool doesn't produce a state change.
 *
 * All mutations are idempotent — duplicate tool_use applications are safe.
 */
export function reduceTeamState(
  state: TeamState | undefined,
  correlated: CorrelatedToolUse,
): TeamState | undefined {
  // Skip state mutation on error results
  if (correlated.result?.is_error) {
    return state;
  }

  const { toolName, input } = correlated.recognized;

  switch (toolName) {
    case "TeamCreate":
      return reduceTeamCreate(state, input);
    case "TeamDelete":
      return undefined;
    case "Task":
      return reduceTaskSpawn(state, input);
    case "TaskCreate":
      return reduceTaskCreate(state, input, correlated);
    case "TaskUpdate":
      return reduceTaskUpdate(state, input);
    case "TaskGet":
    case "TaskList":
      return state;
    case "SendMessage":
      return reduceSendMessage(state, input);
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Individual reducers
// ---------------------------------------------------------------------------

function reduceTeamCreate(state: TeamState | undefined, input: Record<string, unknown>): TeamState {
  // Idempotency: skip if team already exists
  if (state !== undefined) return state;

  return {
    name: (input.team_name as string) ?? "",
    role: "lead", // D7: TeamCreate observed → this session is the lead
    members: [],
    tasks: [],
  };
}

function reduceTaskSpawn(
  state: TeamState | undefined,
  input: Record<string, unknown>,
): TeamState | undefined {
  if (state === undefined) return undefined;

  const name = input.name as string;

  // Idempotency: skip if member already exists
  if (state.members.some((m) => m.name === name)) {
    return state;
  }

  const teamName = (input.team_name as string) ?? state.name;
  const member: TeamMember = {
    name,
    agentId: `${name}@${teamName}`,
    agentType: (input.agentType as string) ?? "general-purpose",
    status: "active",
    model: input.model as string | undefined,
    color: input.color as string | undefined,
  };

  return {
    ...state,
    members: [...state.members, member],
  };
}

function reduceTaskCreate(
  state: TeamState | undefined,
  input: Record<string, unknown>,
  correlated: CorrelatedToolUse,
): TeamState | undefined {
  if (state === undefined) return undefined;

  // Extract task ID from tool_result content (or synthetic from toolUseId)
  const taskId = extractTaskId(correlated);
  if (!taskId) return state; // Can't create task without ID

  // Idempotency: skip if task already exists with this exact ID
  if (state.tasks.some((t) => t.id === taskId)) {
    return state;
  }

  const task: TeamTask = {
    id: taskId,
    subject: (input.subject as string) ?? "",
    description: input.description as string | undefined,
    status: "pending",
    activeForm: input.activeForm as string | undefined,
    blockedBy: [],
    blocks: [],
  };

  // When a real ID arrives via tool_result, replace the synthetic entry
  // (created by optimistic apply) rather than appending a duplicate.
  const syntheticId = `tu-${correlated.recognized.toolUseId}`;
  const tasksWithoutSynthetic = state.tasks.filter((t) => t.id !== syntheticId);

  return {
    ...state,
    tasks: [...tasksWithoutSynthetic, task],
  };
}

function reduceTaskUpdate(
  state: TeamState | undefined,
  input: Record<string, unknown>,
): TeamState | undefined {
  if (state === undefined) return undefined;

  const taskId = input.taskId as string;
  const taskIndex = state.tasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) return state; // No-op if task not found

  const status = input.status as string | undefined;

  // Handle task deletion
  if (status === "deleted") {
    return {
      ...state,
      tasks: state.tasks.filter((t) => t.id !== taskId),
    };
  }

  const existing = state.tasks[taskIndex];
  if (!existing) return state;
  const updated: TeamTask = { ...existing };

  // Update fields that are present in input
  if (status !== undefined) {
    updated.status = status as TeamTask["status"];
  }
  if (input.owner !== undefined) {
    updated.owner = input.owner as string;
  }
  if (input.subject !== undefined) {
    updated.subject = input.subject as string;
  }
  if (input.description !== undefined) {
    updated.description = input.description as string;
  }
  if (input.activeForm !== undefined) {
    updated.activeForm = input.activeForm as string;
  }

  // Merge dependency arrays (additive, deduplicated)
  if (Array.isArray(input.addBlockedBy)) {
    updated.blockedBy = [...new Set([...existing.blockedBy, ...(input.addBlockedBy as string[])])];
  }
  if (Array.isArray(input.addBlocks)) {
    updated.blocks = [...new Set([...existing.blocks, ...(input.addBlocks as string[])])];
  }

  const tasks = [...state.tasks];
  tasks[taskIndex] = updated;

  return { ...state, tasks };
}

function reduceSendMessage(
  state: TeamState | undefined,
  input: Record<string, unknown>,
): TeamState | undefined {
  if (state === undefined) return undefined;

  const msgType = input.type as string;

  // Only shutdown_response with approve=true changes state
  if (msgType === "shutdown_response" && input.approve === true) {
    return reduceShutdownResponse(state);
  }

  // All other SendMessage types: no state change
  return state;
}

/**
 * Handle approved shutdown response.
 *
 * Marks the last active/idle member as "shutdown" (heuristic — the
 * integration layer has more context to identify the exact member).
 */
function reduceShutdownResponse(state: TeamState): TeamState {
  let memberIndex = -1;
  for (let i = state.members.length - 1; i >= 0; i--) {
    const status = state.members[i]?.status;
    if (status === "active" || status === "idle") {
      memberIndex = i;
      break;
    }
  }

  if (memberIndex === -1) return state;

  const members = [...state.members];
  const member = members[memberIndex];
  if (!member) return state;
  members[memberIndex] = { ...member, status: "shutdown" };

  return { ...state, members };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract task ID from a TaskCreate tool_result.
 * The result content is typically JSON like `{"id": "3"}` or a plain string.
 */
function extractTaskId(correlated: CorrelatedToolUse): string | undefined {
  const result = correlated.result;
  if (result) {
    try {
      const parsed = JSON.parse(result.content);
      if (typeof parsed === "object" && parsed !== null) {
        if (typeof parsed.id === "string") return parsed.id;
        if (typeof parsed.id === "number") return String(parsed.id);
      }
    } catch {
      // Not JSON — try treating content as a plain numeric ID
      const trimmed = result.content.trim();
      if (/^\d+$/.test(trimmed)) return trimmed;
    }
    return undefined;
  }

  // Fallback: synthetic ID from tool_use_id for optimistic (no-result) applies.
  // Tagged with the full toolUseId so the correlation path can find and replace
  // the synthetic entry when a real ID arrives (see reduceTaskCreate).
  return `tu-${correlated.recognized.toolUseId}`;
}
