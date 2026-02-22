/**
 * Team Tool Recognizer — identifies team-related tool_use blocks in messages.
 *
 * Pure function that inspects UnifiedMessage content blocks for team-related
 * tool_use blocks and identifies team operations.
 *
 * Team tools are recognized by name:
 * - Unambiguous: TeamCreate, TeamDelete, TaskCreate, TaskUpdate, TaskList, TaskGet, SendMessage
 * - Compound discriminator: Task (only when BOTH team_name AND name are present)
 *
 * @module MessagePlane
 */

import type { ToolUseContent, UnifiedMessage } from "./types/unified-message.js";
import { isToolUseContent } from "./types/unified-message.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecognizedTeamToolUse {
  toolName: string;
  toolUseId: string;
  category: "team_state_change" | "team_task_update" | "team_message";
  input: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tool recognition sets
// ---------------------------------------------------------------------------

/** Team tools that are always recognized (no ambiguity). */
const UNAMBIGUOUS_TEAM_TOOLS = new Set([
  "TeamCreate",
  "TeamDelete",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "SendMessage",
]);

/** Categorization of each recognized tool. */
const TOOL_CATEGORIES: Record<string, RecognizedTeamToolUse["category"]> = {
  TeamCreate: "team_state_change",
  TeamDelete: "team_state_change",
  Task: "team_state_change",
  TaskCreate: "team_task_update",
  TaskUpdate: "team_task_update",
  TaskList: "team_task_update",
  TaskGet: "team_task_update",
  SendMessage: "team_message",
};

/**
 * Required input fields for each recognized tool.
 * Empty array means no required fields.
 */
const REQUIRED_FIELDS: Record<string, string[]> = {
  TeamCreate: ["team_name"],
  TeamDelete: [],
  Task: ["team_name", "name"],
  TaskCreate: ["subject"],
  TaskUpdate: ["taskId"],
  TaskList: [],
  TaskGet: ["taskId"],
  SendMessage: ["type"],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspects a UnifiedMessage for team-related tool_use blocks.
 * Returns recognized team operations, or empty array if none found.
 *
 * For the `Task` tool: only recognized as team-related when BOTH
 * `team_name` AND `name` parameters are present in input (compound
 * discriminator — teammates always have both, subagents have neither).
 */
export function recognizeTeamToolUses(msg: UnifiedMessage): RecognizedTeamToolUse[] {
  const results: RecognizedTeamToolUse[] = [];

  for (const block of msg.content) {
    if (!isToolUseContent(block)) continue;

    const recognized = recognizeBlock(block);
    if (recognized) {
      results.push(recognized);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function recognizeBlock(block: ToolUseContent): RecognizedTeamToolUse | undefined {
  const { name, id, input } = block;

  // Task tool uses a compound discriminator: only team-related when
  // both team_name and name are present (subagents have neither)
  if (name === "Task") {
    if (!validateRequiredFields(name, input)) return undefined;
    return { toolName: name, toolUseId: id, category: "team_state_change", input };
  }

  // Check unambiguous team tools
  if (!UNAMBIGUOUS_TEAM_TOOLS.has(name)) {
    return undefined;
  }

  const category = TOOL_CATEGORIES[name];
  if (!category || !validateRequiredFields(name, input)) {
    return undefined;
  }
  return { toolName: name, toolUseId: id, category, input };
}

/**
 * Validates that all required fields for a tool are present as non-empty strings.
 * Returns true if valid, false if any required field is missing.
 */
function validateRequiredFields(toolName: string, input: Record<string, unknown>): boolean {
  const required = REQUIRED_FIELDS[toolName];
  if (!required || required.length === 0) return true;

  for (const field of required) {
    const value = input[field];
    if (typeof value !== "string" || value.length === 0) {
      return false;
    }
  }
  return true;
}
