import { execSync } from "node:child_process";

/**
 * Detects if the Claude CLI is available in the environment.
 *
 * Checks two conditions:
 * 1. The 'claude' command is available in PATH
 * 2. An ANTHROPIC_API_KEY is set in the environment
 *
 * @returns true if Claude CLI is available and properly configured, false otherwise
 */
export function isClaudeAvailable(): boolean {
  try {
    // Check if claude command exists and can be executed
    execSync("claude --version", {
      stdio: "pipe",
      timeout: 3000,
      encoding: "utf-8",
    });

    // Check if API key is available
    const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

    return hasApiKey;
  } catch {
    // Command failed or doesn't exist
    return false;
  }
}
