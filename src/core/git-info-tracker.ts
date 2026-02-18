/**
 * GitInfoTracker — extracted from SessionBridge.
 *
 * Manages git info resolution for sessions: initial resolve with idempotency
 * guard, refresh with change detection, and attempt tracking to avoid repeated
 * subprocess spawns for non-git directories.
 */

import type { GitInfo, GitInfoResolver } from "../interfaces/git-resolver.js";
import type { SessionState } from "../types/session-state.js";
import type { Session } from "./session-store.js";

// ─── Standalone helper ──────────────────────────────────────────────────────

/** Apply resolved git info fields to session state. */
export function applyGitInfo(session: Session, gitInfo: GitInfo): void {
  session.state.git_branch = gitInfo.branch;
  session.state.is_worktree = gitInfo.isWorktree;
  session.state.repo_root = gitInfo.repoRoot;
  session.state.git_ahead = gitInfo.ahead ?? 0;
  session.state.git_behind = gitInfo.behind ?? 0;
}

// ─── GitInfoTracker ─────────────────────────────────────────────────────────

export class GitInfoTracker {
  private resolveAttempted = new Set<string>();

  constructor(private gitResolver: GitInfoResolver | null) {}

  /**
   * Resolve git info from cwd if not already attempted (no broadcast).
   * Skips if git_branch is already set or if this session was already attempted.
   */
  resolveGitInfo(session: Session): void {
    if (!session.state.cwd || !this.gitResolver) return;
    if (session.state.git_branch || this.resolveAttempted.has(session.id)) return;
    this.resolveAttempted.add(session.id);
    try {
      const gitInfo = this.gitResolver.resolve(session.state.cwd);
      if (gitInfo) applyGitInfo(session, gitInfo);
    } catch {
      // Best-effort: git resolution failure should never crash consumer connections
    }
  }

  /**
   * Re-resolve git info and return a partial state update if anything changed,
   * or null if nothing changed (or no resolver/cwd/info available).
   *
   * Mutates session state via applyGitInfo when changes are detected.
   * The caller is responsible for broadcasting the returned update.
   */
  refreshGitInfo(session: Session): Partial<SessionState> | null {
    if (!session.state.cwd || !this.gitResolver) return null;

    const gitInfo = this.gitResolver.resolve(session.state.cwd);
    if (!gitInfo) return null;

    const changed =
      session.state.git_branch !== gitInfo.branch ||
      session.state.git_ahead !== (gitInfo.ahead ?? 0) ||
      session.state.git_behind !== (gitInfo.behind ?? 0) ||
      session.state.is_worktree !== gitInfo.isWorktree;

    if (!changed) return null;

    applyGitInfo(session, gitInfo);

    return {
      git_branch: session.state.git_branch,
      git_ahead: session.state.git_ahead,
      git_behind: session.state.git_behind,
      is_worktree: session.state.is_worktree,
    };
  }

  /** Reset attempt tracking for a session (called on re-init). */
  resetAttempt(sessionId: string): void {
    this.resolveAttempted.delete(sessionId);
  }
}
