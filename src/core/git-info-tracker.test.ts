import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitInfo, GitInfoResolver } from "../interfaces/git-resolver.js";
import type { SessionState } from "../types/session-state.js";
import { applyGitInfo, GitInfoTracker } from "./git-info-tracker.js";
import type { Session } from "./session-store.js";
import { makeDefaultState } from "./session-store.js";
import { SlashCommandRegistry } from "./slash-command-registry.js";
import { TeamToolCorrelationBuffer } from "./team-tool-correlation.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSession(id: string, overrides?: Partial<SessionState>): Session {
  const state = { ...makeDefaultState(id), ...overrides };
  return {
    id,
    cliSocket: null,
    backendSession: null,
    backendAbort: null,
    consumerSockets: new Map(),
    consumerRateLimiters: new Map(),
    anonymousCounter: 0,
    state,
    pendingPermissions: new Map(),
    messageHistory: [],
    pendingMessages: [],
    queuedMessage: null,
    lastStatus: null,
    lastActivity: Date.now(),
    pendingInitialize: null,
    teamCorrelationBuffer: new TeamToolCorrelationBuffer(),
    registry: new SlashCommandRegistry(),
  };
}

function makeMockResolver(returnValue: GitInfo | null = null): GitInfoResolver & {
  resolve: ReturnType<typeof vi.fn>;
} {
  return { resolve: vi.fn().mockReturnValue(returnValue) };
}

const defaultGitInfo: GitInfo = {
  branch: "main",
  isWorktree: false,
  repoRoot: "/repo",
  ahead: 0,
  behind: 0,
};

// ─── applyGitInfo (standalone helper) ───────────────────────────────────────

describe("applyGitInfo", () => {
  it("copies all git fields to session state", () => {
    const session = makeSession("s1", { cwd: "/repo" });
    applyGitInfo(session, {
      branch: "feat/test",
      isWorktree: true,
      repoRoot: "/project",
      ahead: 3,
      behind: 2,
    });
    expect(session.state.git_branch).toBe("feat/test");
    expect(session.state.is_worktree).toBe(true);
    expect(session.state.repo_root).toBe("/project");
    expect(session.state.git_ahead).toBe(3);
    expect(session.state.git_behind).toBe(2);
  });

  it("defaults ahead and behind to 0 when undefined", () => {
    const session = makeSession("s1", { cwd: "/repo" });
    applyGitInfo(session, {
      branch: "main",
      isWorktree: false,
      repoRoot: "/repo",
    });
    expect(session.state.git_ahead).toBe(0);
    expect(session.state.git_behind).toBe(0);
  });
});

// ─── GitInfoTracker ─────────────────────────────────────────────────────────

describe("GitInfoTracker", () => {
  let resolver: ReturnType<typeof makeMockResolver>;
  let tracker: GitInfoTracker;

  beforeEach(() => {
    resolver = makeMockResolver(defaultGitInfo);
    tracker = new GitInfoTracker(resolver);
  });

  // ── resolveGitInfo ──────────────────────────────────────────────────────

  describe("resolveGitInfo", () => {
    it("resolves git info and applies to session state", () => {
      resolver.resolve.mockReturnValue({
        branch: "feat/test",
        isWorktree: true,
        repoRoot: "/repo",
        ahead: 2,
        behind: 1,
      });
      const session = makeSession("s1", { cwd: "/repo" });

      tracker.resolveGitInfo(session);

      expect(resolver.resolve).toHaveBeenCalledWith("/repo");
      expect(session.state.git_branch).toBe("feat/test");
      expect(session.state.is_worktree).toBe(true);
      expect(session.state.repo_root).toBe("/repo");
      expect(session.state.git_ahead).toBe(2);
      expect(session.state.git_behind).toBe(1);
    });

    it("is a no-op when cwd is empty", () => {
      const session = makeSession("s1", { cwd: "" });
      tracker.resolveGitInfo(session);
      expect(resolver.resolve).not.toHaveBeenCalled();
    });

    it("is a no-op when gitResolver is null", () => {
      const nullTracker = new GitInfoTracker(null);
      const session = makeSession("s1", { cwd: "/repo" });
      nullTracker.resolveGitInfo(session);
      expect(session.state.git_branch).toBe("");
    });

    it("skips if git_branch is already set", () => {
      const session = makeSession("s1", { cwd: "/repo", git_branch: "already-set" });
      tracker.resolveGitInfo(session);
      expect(resolver.resolve).not.toHaveBeenCalled();
    });

    it("is idempotent: second call does not re-resolve after successful resolve", () => {
      resolver.resolve.mockReturnValue({
        branch: "main",
        isWorktree: false,
        repoRoot: "/repo",
      });
      const session = makeSession("s1", { cwd: "/repo" });

      tracker.resolveGitInfo(session);
      tracker.resolveGitInfo(session);

      // resolve called only once — second call skips due to git_branch already set
      expect(resolver.resolve).toHaveBeenCalledTimes(1);
    });

    it("does not spawn subprocesses repeatedly for non-git directories", () => {
      resolver.resolve.mockReturnValue(null);
      const session = makeSession("s1", { cwd: "/tmp" });

      tracker.resolveGitInfo(session);
      tracker.resolveGitInfo(session);

      // resolve called only once — second call skipped due to attempt tracking
      expect(resolver.resolve).toHaveBeenCalledTimes(1);
    });

    it("does not crash when gitResolver.resolve() throws", () => {
      resolver.resolve.mockImplementation(() => {
        throw new Error("git not found");
      });
      const session = makeSession("s1", { cwd: "/repo" });

      expect(() => tracker.resolveGitInfo(session)).not.toThrow();
      expect(session.state.git_branch).toBe("");
    });

    it("tracks attempts per session independently", () => {
      resolver.resolve.mockReturnValue(null);
      const s1 = makeSession("s1", { cwd: "/tmp" });
      const s2 = makeSession("s2", { cwd: "/tmp" });

      tracker.resolveGitInfo(s1);
      tracker.resolveGitInfo(s2);

      // Each session gets its own attempt
      expect(resolver.resolve).toHaveBeenCalledTimes(2);
    });
  });

  // ── refreshGitInfo ──────────────────────────────────────────────────────

  describe("refreshGitInfo", () => {
    it("returns null when cwd is empty", () => {
      const session = makeSession("s1", { cwd: "" });
      expect(tracker.refreshGitInfo(session)).toBeNull();
    });

    it("returns null when gitResolver is null", () => {
      const nullTracker = new GitInfoTracker(null);
      const session = makeSession("s1", { cwd: "/repo" });
      expect(nullTracker.refreshGitInfo(session)).toBeNull();
    });

    it("returns null when resolver returns null", () => {
      resolver.resolve.mockReturnValue(null);
      const session = makeSession("s1", { cwd: "/repo" });
      expect(tracker.refreshGitInfo(session)).toBeNull();
    });

    it("returns null when git info is unchanged", () => {
      const session = makeSession("s1", {
        cwd: "/repo",
        git_branch: "main",
        is_worktree: false,
        git_ahead: 0,
        git_behind: 0,
      });
      resolver.resolve.mockReturnValue(defaultGitInfo);
      expect(tracker.refreshGitInfo(session)).toBeNull();
    });

    it("returns partial state update when branch changes", () => {
      const session = makeSession("s1", {
        cwd: "/repo",
        git_branch: "main",
        is_worktree: false,
        git_ahead: 0,
        git_behind: 0,
      });
      resolver.resolve.mockReturnValue({
        branch: "feat/new",
        isWorktree: false,
        repoRoot: "/repo",
        ahead: 0,
        behind: 0,
      });

      const result = tracker.refreshGitInfo(session);

      expect(result).toEqual({
        git_branch: "feat/new",
        git_ahead: 0,
        git_behind: 0,
        is_worktree: false,
      });
    });

    it("returns partial state update when ahead count changes", () => {
      const session = makeSession("s1", {
        cwd: "/repo",
        git_branch: "main",
        is_worktree: false,
        git_ahead: 0,
        git_behind: 0,
      });
      resolver.resolve.mockReturnValue({
        branch: "main",
        isWorktree: false,
        repoRoot: "/repo",
        ahead: 3,
        behind: 0,
      });

      const result = tracker.refreshGitInfo(session);

      expect(result).toEqual({
        git_branch: "main",
        git_ahead: 3,
        git_behind: 0,
        is_worktree: false,
      });
      // Also verify session state was mutated
      expect(session.state.git_ahead).toBe(3);
    });

    it("returns partial state update when worktree status changes", () => {
      const session = makeSession("s1", {
        cwd: "/repo",
        git_branch: "main",
        is_worktree: false,
        git_ahead: 0,
        git_behind: 0,
      });
      resolver.resolve.mockReturnValue({
        branch: "main",
        isWorktree: true,
        repoRoot: "/repo",
        ahead: 0,
        behind: 0,
      });

      const result = tracker.refreshGitInfo(session);

      expect(result).not.toBeNull();
      expect(result!.is_worktree).toBe(true);
      expect(session.state.is_worktree).toBe(true);
    });

    it("mutates session state when changes are detected", () => {
      const session = makeSession("s1", {
        cwd: "/repo",
        git_branch: "old",
        is_worktree: false,
        repo_root: "/old",
        git_ahead: 0,
        git_behind: 0,
      });
      resolver.resolve.mockReturnValue({
        branch: "new",
        isWorktree: true,
        repoRoot: "/new",
        ahead: 5,
        behind: 2,
      });

      tracker.refreshGitInfo(session);

      expect(session.state.git_branch).toBe("new");
      expect(session.state.is_worktree).toBe(true);
      expect(session.state.repo_root).toBe("/new");
      expect(session.state.git_ahead).toBe(5);
      expect(session.state.git_behind).toBe(2);
    });
  });

  // ── resetAttempt ────────────────────────────────────────────────────────

  describe("resetAttempt", () => {
    it("allows re-resolve after reset for non-git directories", () => {
      resolver.resolve.mockReturnValue(null);
      const session = makeSession("s1", { cwd: "/tmp" });

      tracker.resolveGitInfo(session);
      expect(resolver.resolve).toHaveBeenCalledTimes(1);

      tracker.resetAttempt("s1");
      tracker.resolveGitInfo(session);
      expect(resolver.resolve).toHaveBeenCalledTimes(2);
    });

    it("is a no-op for sessions that were never attempted", () => {
      // Should not throw
      expect(() => tracker.resetAttempt("nonexistent")).not.toThrow();
    });

    it("only resets the specified session", () => {
      resolver.resolve.mockReturnValue(null);
      const s1 = makeSession("s1", { cwd: "/tmp" });
      const s2 = makeSession("s2", { cwd: "/tmp" });

      tracker.resolveGitInfo(s1);
      tracker.resolveGitInfo(s2);
      expect(resolver.resolve).toHaveBeenCalledTimes(2);

      tracker.resetAttempt("s1");
      tracker.resolveGitInfo(s1);
      tracker.resolveGitInfo(s2);

      // s1 re-resolved (3rd call), s2 still skipped (still at 2 from before + 1 = 3)
      expect(resolver.resolve).toHaveBeenCalledTimes(3);
    });
  });
});
