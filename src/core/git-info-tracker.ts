/**
 * GitInfoTracker — extracted from SessionBridge.
 *
 * Manages git info resolution for sessions: initial resolve with idempotency
 * guard, refresh with change detection, and attempt tracking to avoid repeated
 * subprocess spawns for non-git directories.
 */

import type { GitInfo, GitInfoResolver } from "../interfaces/git-resolver.js";
import type { SessionState } from "../types/session-state.js";
import type { Session } from "./session-repository.js";

// ─── Standalone helper ──────────────────────────────────────────────────────

/** Return a new state with resolved git info fields applied. */
export function applyGitInfo(state: SessionState, gitInfo: GitInfo): SessionState {
  return {
    ...state,
    git_branch: gitInfo.branch,
    is_worktree: gitInfo.isWorktree,
    repo_root: gitInfo.repoRoot,
    git_ahead: gitInfo.ahead ?? 0,
    git_behind: gitInfo.behind ?? 0,
  };
}

// ─── GitInfoTracker ─────────────────────────────────────────────────────────

type GitStateAccessors = {
  getState: (session: Session) => Session["state"];
  setState: (session: Session, state: Session["state"]) => void;
};

export class GitInfoTracker {
  private resolveAttempted = new Set<string>();
  private readonly stateAccessors: GitStateAccessors;

  constructor(gitResolver: GitInfoResolver | null, stateAccessors: GitStateAccessors) {
    this.gitResolver = gitResolver;
    this.stateAccessors = stateAccessors;
  }

  private readonly gitResolver: GitInfoResolver | null;

  private getState(session: Session): Session["state"] {
    return this.stateAccessors.getState(session);
  }

  private setState(session: Session, state: Session["state"]): void {
    this.stateAccessors.setState(session, state);
  }

  /**
   * Resolve git info from cwd if not already attempted (no broadcast).
   * Skips if git_branch is already set or if this session was already attempted.
   */
  resolveGitInfo(session: Session): void {
    const state = this.getState(session);
    if (!state.cwd || !this.gitResolver) return;
    if (state.git_branch || this.resolveAttempted.has(session.id)) return;
    this.resolveAttempted.add(session.id);
    try {
      const gitInfo = this.gitResolver.resolve(state.cwd);
      if (gitInfo) this.setState(session, applyGitInfo(this.getState(session), gitInfo));
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
    const state = this.getState(session);
    if (!state.cwd || !this.gitResolver) return null;

    const gitInfo = this.gitResolver.resolve(state.cwd);
    if (!gitInfo) return null;

    const changed =
      state.git_branch !== gitInfo.branch ||
      state.git_ahead !== (gitInfo.ahead ?? 0) ||
      state.git_behind !== (gitInfo.behind ?? 0) ||
      state.is_worktree !== gitInfo.isWorktree;

    if (!changed) return null;

    const nextState = applyGitInfo(state, gitInfo);
    this.setState(session, nextState);

    return {
      git_branch: nextState.git_branch,
      git_ahead: nextState.git_ahead,
      git_behind: nextState.git_behind,
      is_worktree: nextState.is_worktree,
    };
  }

  /** Reset attempt tracking for a session (called on re-init). */
  resetAttempt(sessionId: string): void {
    this.resolveAttempted.delete(sessionId);
  }
}
