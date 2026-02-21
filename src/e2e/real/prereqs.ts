import { execFileSync } from "node:child_process";
import { isClaudeAvailable } from "../../utils/claude-detection.js";

// ---------------------------------------------------------------------------
// Shared prereq state type
// ---------------------------------------------------------------------------

export interface BackendPrereqState {
  ok: boolean;
  reason?: string;
  hasApiKey: boolean;
  canRunPromptTests: boolean;
}

// ---------------------------------------------------------------------------
// Claude (Real CLI)
// ---------------------------------------------------------------------------

export interface RealCliPrereqState extends BackendPrereqState {
  hasAuthSession: boolean;
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

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export function getCodexPrereqState(): BackendPrereqState {
  const hasApiKey = Boolean(process.env.OPENAI_API_KEY);
  const binaryOk = isBinaryAvailable("codex", ["--version"]);

  if (!binaryOk) {
    return {
      ok: false,
      reason: "codex binary is not available",
      hasApiKey,
      canRunPromptTests: false,
    };
  }

  return { ok: true, hasApiKey, canRunPromptTests: true };
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

export function getGeminiPrereqState(): BackendPrereqState {
  const hasApiKey = Boolean(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
  const binaryOk = isBinaryAvailable("gemini", ["--version"]);

  if (!binaryOk) {
    return {
      ok: false,
      reason: "gemini binary is not available",
      hasApiKey,
      canRunPromptTests: false,
    };
  }

  return { ok: true, hasApiKey, canRunPromptTests: true };
}

// ---------------------------------------------------------------------------
// Opencode
// ---------------------------------------------------------------------------

export function getOpencodePrereqState(): BackendPrereqState {
  const hasApiKey = Boolean(
    process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GOOGLE_API_KEY,
  );
  const binaryOk = isBinaryAvailable("opencode", ["version"]);

  if (!binaryOk) {
    return {
      ok: false,
      reason: "opencode binary is not available",
      hasApiKey,
      canRunPromptTests: false,
    };
  }

  return { ok: true, hasApiKey, canRunPromptTests: true };
}

// ---------------------------------------------------------------------------
// Agent SDK
// ---------------------------------------------------------------------------

export function getAgentSdkPrereqState(): BackendPrereqState {
  // The Agent SDK uses the Claude CLI under the hood — no separate API key needed.
  // Prereqs: Claude CLI available + logged in (SDK uses CLI's auth).
  const cliAvailable = isClaudeAvailable();
  const loggedIn = isClaudeLoggedIn();
  const sdkAvailable = isSdkPackageAvailable();

  if (!cliAvailable) {
    return {
      ok: false,
      reason: "Claude CLI is not available (needed by Agent SDK)",
      hasApiKey: false,
      canRunPromptTests: false,
    };
  }

  if (!sdkAvailable) {
    return {
      ok: false,
      reason: "@anthropic-ai/claude-agent-sdk package is not installed",
      hasApiKey: false,
      canRunPromptTests: false,
    };
  }

  return {
    ok: true,
    hasApiKey: false, // not needed — SDK uses CLI auth
    canRunPromptTests: loggedIn,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

function isBinaryAvailable(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function isSdkPackageAvailable(): boolean {
  try {
    require.resolve("@anthropic-ai/claude-agent-sdk");
    return true;
  } catch {
    return false;
  }
}
