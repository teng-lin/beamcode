import { execSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

describe("isClaudeAvailable", () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    vi.resetModules();
    mockedExecSync.mockReset();
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  async function loadModule() {
    return import("./claude-detection.js");
  }

  it("returns true when claude command exists and API key is set", async () => {
    mockedExecSync.mockReturnValue("claude 1.0.0");
    process.env.ANTHROPIC_API_KEY = "sk-test-key";

    const { isClaudeAvailable } = await loadModule();
    expect(isClaudeAvailable()).toBe(true);
  });

  it("returns false when claude command exists but API key is missing", async () => {
    mockedExecSync.mockReturnValue("claude 1.0.0");
    delete process.env.ANTHROPIC_API_KEY;

    const { isClaudeAvailable } = await loadModule();
    expect(isClaudeAvailable()).toBe(false);
  });

  it("returns false when claude command is not found", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("command not found: claude");
    });
    process.env.ANTHROPIC_API_KEY = "sk-test-key";

    const { isClaudeAvailable } = await loadModule();
    expect(isClaudeAvailable()).toBe(false);
  });

  it("calls execSync with correct arguments", async () => {
    mockedExecSync.mockReturnValue("claude 1.0.0");
    process.env.ANTHROPIC_API_KEY = "sk-test-key";

    const { isClaudeAvailable } = await loadModule();
    isClaudeAvailable();

    expect(mockedExecSync).toHaveBeenCalledWith("claude --version", {
      stdio: "pipe",
      timeout: 3000,
      encoding: "utf-8",
    });
  });
});
