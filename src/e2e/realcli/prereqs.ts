import { execFileSync } from "node:child_process";
import { isClaudeAvailable } from "../../utils/claude-detection.js";

export interface RealCliPrereqState {
  ok: boolean;
  reason?: string;
  hasApiKey: boolean;
  hasAuthSession: boolean;
  canRunPromptTests: boolean;
}

export function getRealCliPrereqState(): RealCliPrereqState {
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasAuthSession = isClaudeLoggedIn();

  if (!isClaudeAvailable()) {
    return {
      ok: false,
      reason: "Claude CLI is not available",
      hasApiKey,
      hasAuthSession,
      canRunPromptTests: false,
    };
  }

  return {
    ok: true,
    hasApiKey,
    hasAuthSession,
    canRunPromptTests: hasApiKey || hasAuthSession,
  };
}

function isClaudeLoggedIn(): boolean {
  try {
    const raw = execFileSync("claude", ["auth", "status"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    const parsed = JSON.parse(raw) as { loggedIn?: unknown };
    return parsed.loggedIn === true;
  } catch {
    return false;
  }
}
