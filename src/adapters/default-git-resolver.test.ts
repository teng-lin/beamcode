import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

import { DefaultGitResolver } from "./default-git-resolver.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DefaultGitResolver", () => {
  let resolver: DefaultGitResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new DefaultGitResolver();
  });

  // -----------------------------------------------------------------------
  // Successful resolution
  // -----------------------------------------------------------------------

  describe("successful resolution", () => {
    it("returns full GitInfo when all git commands succeed", () => {
      mockExecFileSync
        .mockReturnValueOnce("main\n") // rev-parse --abbrev-ref HEAD
        .mockReturnValueOnce("/path/to/repo/.git\n") // rev-parse --git-dir
        .mockReturnValueOnce("/path/to/repo\n") // rev-parse --show-toplevel
        .mockReturnValueOnce("2\t3\n"); // rev-list --left-right --count

      const result = resolver.resolve("/path/to/repo");

      expect(result).toEqual({
        branch: "main",
        isWorktree: false,
        repoRoot: "/path/to/repo",
        ahead: 3,
        behind: 2,
      });
    });

    it("detects worktree when git-dir includes '/worktrees/'", () => {
      mockExecFileSync
        .mockReturnValueOnce("feature-branch\n")
        .mockReturnValueOnce("/path/to/repo/.git/worktrees/feature-branch\n")
        .mockReturnValueOnce("/path/to/worktree\n")
        .mockReturnValueOnce("0\t5\n");

      const result = resolver.resolve("/path/to/worktree");

      expect(result).not.toBeNull();
      expect(result!.isWorktree).toBe(true);
      expect(result!.branch).toBe("feature-branch");
    });

    it("returns isWorktree=false for normal repos", () => {
      mockExecFileSync
        .mockReturnValueOnce("main\n")
        .mockReturnValueOnce(".git\n")
        .mockReturnValueOnce("/normal/repo\n")
        .mockReturnValueOnce("0\t0\n");

      const result = resolver.resolve("/normal/repo");

      expect(result).not.toBeNull();
      expect(result!.isWorktree).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Not a git repo
  // -----------------------------------------------------------------------

  describe("not a git repo", () => {
    it("returns null when the first git command throws", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("not a git repository");
      });

      const result = resolver.resolve("/not/a/repo");

      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Graceful degradation
  // -----------------------------------------------------------------------

  describe("graceful degradation", () => {
    it("leaves ahead/behind undefined when no upstream exists", () => {
      mockExecFileSync
        .mockReturnValueOnce("main\n")
        .mockReturnValueOnce(".git\n")
        .mockReturnValueOnce("/repo\n")
        .mockImplementationOnce(() => {
          throw new Error("no upstream");
        });

      const result = resolver.resolve("/repo");

      expect(result).not.toBeNull();
      expect(result!.ahead).toBeUndefined();
      expect(result!.behind).toBeUndefined();
    });

    it("handles git-dir failure gracefully (isWorktree defaults to false)", () => {
      mockExecFileSync
        .mockReturnValueOnce("main\n")
        .mockImplementationOnce(() => {
          throw new Error("git-dir failed");
        })
        .mockReturnValueOnce("/repo\n")
        .mockReturnValueOnce("1\t0\n");

      const result = resolver.resolve("/repo");

      expect(result).not.toBeNull();
      expect(result!.isWorktree).toBe(false);
      expect(result!.branch).toBe("main");
    });

    it("handles show-toplevel failure gracefully (repoRoot defaults to empty string)", () => {
      mockExecFileSync
        .mockReturnValueOnce("main\n")
        .mockReturnValueOnce(".git\n")
        .mockImplementationOnce(() => {
          throw new Error("show-toplevel failed");
        })
        .mockReturnValueOnce("0\t0\n");

      const result = resolver.resolve("/repo");

      expect(result).not.toBeNull();
      expect(result!.repoRoot).toBe("");
    });
  });

  // -----------------------------------------------------------------------
  // Custom timeout
  // -----------------------------------------------------------------------

  describe("custom timeout", () => {
    it("passes custom timeout to execFileSync", () => {
      const customResolver = new DefaultGitResolver(5000);

      mockExecFileSync
        .mockReturnValueOnce("main\n")
        .mockReturnValueOnce(".git\n")
        .mockReturnValueOnce("/repo\n")
        .mockReturnValueOnce("0\t0\n");

      customResolver.resolve("/repo");

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        expect.objectContaining({ timeout: 5000 }),
      );
    });

    it("uses default timeout of 3000ms", () => {
      mockExecFileSync
        .mockReturnValueOnce("main\n")
        .mockReturnValueOnce(".git\n")
        .mockReturnValueOnce("/repo\n")
        .mockReturnValueOnce("0\t0\n");

      resolver.resolve("/repo");

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        expect.objectContaining({ timeout: 3000 }),
      );
    });
  });
});
