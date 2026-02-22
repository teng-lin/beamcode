/**
 * Git repository metadata and resolution.
 * Used to display branch/worktree info in the consumer UI.
 * @module
 */

/** Snapshot of the current git repository state for a working directory. */
export interface GitInfo {
  branch: string;
  isWorktree: boolean;
  repoRoot: string;
  /** Undefined when no upstream is configured */
  ahead?: number;
  /** Undefined when no upstream is configured */
  behind?: number;
}

/** Resolves git metadata for a given working directory. Returns null if not a git repo. */
export interface GitInfoResolver {
  resolve(cwd: string): GitInfo | null;
}
