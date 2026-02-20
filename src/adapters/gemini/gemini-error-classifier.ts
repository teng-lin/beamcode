/**
 * Gemini-specific JSON-RPC error classifier.
 *
 * Maps Gemini CLI error codes and messages to UnifiedErrorCode values.
 * Injected into AcpSession so the generic ACP layer stays backend-agnostic.
 */
import type { ErrorClassifier } from "../acp/outbound-translator.js";

export const classifyGeminiError: ErrorClassifier = (code: number, message: string): string => {
  const lower = message.toLowerCase();

  if (
    code === 403 ||
    code === 401 ||
    lower.includes("verify your account") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication")
  ) {
    return "provider_auth";
  }

  if (code === 429 || lower.includes("rate limit") || lower.includes("quota")) {
    return "rate_limit";
  }

  if (lower.includes("context") && lower.includes("overflow")) {
    return "context_overflow";
  }

  return "api_error";
};
