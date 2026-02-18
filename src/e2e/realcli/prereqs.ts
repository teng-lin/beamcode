import { isClaudeAvailable } from "../../utils/claude-detection.js";

export interface RealCliPrereqState {
  ok: boolean;
  reason?: string;
}

export function getRealCliPrereqState(): RealCliPrereqState {
  if (!isClaudeAvailable()) {
    return { ok: false, reason: "Claude CLI or API key is not available" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, reason: "ANTHROPIC_API_KEY is not set" };
  }
  return { ok: true };
}
