import { execFileSync } from "node:child_process";
import type { GitInfo, GitInfoResolver } from "../interfaces/git-resolver.js";

/**
 * Default git info resolver using execFileSync.
 * Uses execFileSync instead of execSync to prevent command injection.
 */
export class DefaultGitResolver implements GitInfoResolver {
  private timeoutMs: number;

  constructor(timeoutMs = 3000) {
    this.timeoutMs = timeoutMs;
  }

  resolve(cwd: string): GitInfo | null {
    const execOpts = { cwd, encoding: "utf-8" as const, timeout: this.timeoutMs };

    try {
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], execOpts).trim();

      let isWorktree = false;
      try {
        const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], execOpts).trim();
        isWorktree = gitDir.includes("/worktrees/");
      } catch {
        /* ignore */
      }

      let repoRoot = "";
      try {
        repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], execOpts).trim();
      } catch {
        /* ignore */
      }

      let ahead: number | undefined;
      let behind: number | undefined;
      try {
        const counts = execFileSync(
          "git",
          ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
          execOpts,
        ).trim();
        const [b, a] = counts.split(/\s+/).map(Number);
        ahead = a || 0;
        behind = b || 0;
      } catch {
        // No upstream configured — leave ahead/behind undefined
      }

      return { branch, isWorktree, repoRoot, ahead, behind };
    } catch {
      // Not a git repo or git not available
      return null;
    }
  }
}
