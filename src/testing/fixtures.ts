/**
 * Shared test fixtures for session state and team tools.
 *
 * Provides factory functions used across adapter and core test files
 * to avoid duplicating default state construction.
 */

import { createUnifiedMessage } from "../core/types/unified-message.js";
import type { SessionState } from "../types/session-state.js";

/**
 * Create a default SessionState with all required fields initialized to
 * sensible zero-values. Callers can spread overrides on top.
 */
export function makeDefaultSessionState(): SessionState {
  return {
    session_id: "sess-1",
    model: "",
    cwd: "",
    tools: [],
    permissionMode: "default",
    claude_code_version: "",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

/**
 * Create a UnifiedMessage containing a single tool_use content block.
 * Reduces boilerplate in tests that construct team tool messages.
 */
export function makeToolUseMessage(
  toolName: string,
  toolUseId: string,
  input: Record<string, unknown>,
) {
  return createUnifiedMessage({
    type: "assistant",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: toolUseId,
        name: toolName,
        input,
      },
    ],
  });
}

/**
 * Create a UnifiedMessage containing a single tool_result content block.
 * Reduces boilerplate in tests that construct tool result messages.
 */
export function makeToolResultMessage(toolUseId: string, content: string, isError = false) {
  return createUnifiedMessage({
    type: "assistant",
    role: "assistant",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content,
        ...(isError ? { is_error: true } : {}),
      },
    ],
  });
}
