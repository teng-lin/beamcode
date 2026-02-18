import { execSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

describe("isClaudeAvailable", () => {
  afterEach(() => {
    vi.resetModules();
    mockedExecSync.mockReset();
  });

  async function loadModule() {
    return import("./claude-detection.js");
  }

  it("returns true when claude command exists", async () => {
    mockedExecSync.mockReturnValue("claude 1.0.0");

    const { isClaudeAvailable } = await loadModule();
    expect(isClaudeAvailable()).toBe(true);
  });

  it("returns true when claude command exists without API key", async () => {
    mockedExecSync.mockReturnValue("claude 1.0.0");

    const { isClaudeAvailable } = await loadModule();
    expect(isClaudeAvailable()).toBe(true);
  });

  it("returns false when claude command is not found", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("command not found: claude");
    });

    const { isClaudeAvailable } = await loadModule();
    expect(isClaudeAvailable()).toBe(false);
  });

  it("calls execSync with correct arguments", async () => {
    mockedExecSync.mockReturnValue("claude 1.0.0");

    const { isClaudeAvailable } = await loadModule();
    isClaudeAvailable();

    expect(mockedExecSync).toHaveBeenCalledWith("claude --version", {
      stdio: "pipe",
      timeout: 3000,
      encoding: "utf-8",
    });
  });
});
