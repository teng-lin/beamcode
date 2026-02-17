/**
 * Redact common secret patterns from text.
 * Used by session auto-naming and process log forwarding to prevent
 * leaking API keys, tokens, and credentials to consumers.
 */

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[a-zA-Z0-9_-]+/g,
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /ghp_[a-zA-Z0-9_]{36,}/g,
  /gho_[a-zA-Z0-9_]{36,}/g,
  /github_pat_[a-zA-Z0-9_]{22,}/g,
  /Bearer\s+[a-zA-Z0-9._\-/+=]{20,}/g,
  /ANTHROPIC_API_KEY=[^\s]+/g,
  /OPENAI_API_KEY=[^\s]+/g,
  /AWS_SECRET_ACCESS_KEY=[^\s]+/g,
  /-----BEGIN\s+(RSA|EC|DSA|OPENSSH)?\s*PRIVATE KEY-----[\s\S]*?-----END\s+(RSA|EC|DSA|OPENSSH)?\s*PRIVATE KEY-----/g,
  /xoxb-[a-zA-Z0-9-]+/g,
  /xoxp-[a-zA-Z0-9-]+/g,
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}
