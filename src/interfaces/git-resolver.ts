export interface GitInfo {
  branch: string;
  isWorktree: boolean;
  repoRoot: string;
  /** Undefined when no upstream is configured */
  ahead?: number;
  /** Undefined when no upstream is configured */
  behind?: number;
}

export interface GitInfoResolver {
  resolve(cwd: string): GitInfo | null;
}
