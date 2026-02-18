import { execSync } from "node:child_process";

/**
 * Detects if the Claude CLI is available in the environment.
 *
 * Checks one condition:
 * 1. The 'claude' command is available in PATH
 *
 * @returns true if Claude CLI is available, false otherwise
 */
export function isClaudeAvailable(): boolean {
  try {
    // Check if claude command exists and can be executed
    execSync("claude --version", {
      stdio: "pipe",
      timeout: 3000,
      encoding: "utf-8",
    });
    return true;
  } catch {
    // Command failed or doesn't exist
    return false;
  }
}
