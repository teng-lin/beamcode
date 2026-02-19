/**
 * Adapter-agnostic session state — the minimal state any backend adapter
 * must track. This is the foundation for all session state hierarchies.
 */
export interface CoreSessionState {
  session_id: string;
  total_cost_usd: number;
  num_turns: number;
  context_used_percent: number;
  is_compacting: boolean;
}

/**
 * Development-tool-specific session state — shared by CLI-based adapters
 * that work with source code repositories (e.g., Claude, future LSP adapters).
 */
export interface DevToolSessionState extends CoreSessionState {
  git_branch: string;
  is_worktree: boolean;
  repo_root: string;
  git_ahead: number;
  git_behind: number;
  total_lines_added: number;
  total_lines_removed: number;
}
