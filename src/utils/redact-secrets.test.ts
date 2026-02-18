import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact-secrets.js";

describe("redactSecrets", () => {
  it("returns unchanged text when no secrets present", () => {
    expect(redactSecrets("hello world")).toBe("hello world");
  });

  it("redacts Anthropic API keys (sk-ant-*)", () => {
    expect(redactSecrets("key: sk-ant-abc123_DEF-456")).toBe("key: [REDACTED]");
  });

  it("redacts OpenAI-style keys (sk-*)", () => {
    expect(redactSecrets("key: sk-abcdefghijklmnopqrstuvwxyz")).toBe("key: [REDACTED]");
  });

  it("redacts GitHub personal access tokens (ghp_*)", () => {
    const token = "ghp_" + "a".repeat(36);
    expect(redactSecrets(`token: ${token}`)).toBe("token: [REDACTED]");
  });

  it("redacts GitHub OAuth tokens (gho_*)", () => {
    const token = "gho_" + "b".repeat(36);
    expect(redactSecrets(`token: ${token}`)).toBe("token: [REDACTED]");
  });

  it("redacts GitHub fine-grained PATs (github_pat_*)", () => {
    const token = "github_pat_" + "c".repeat(22);
    expect(redactSecrets(`token: ${token}`)).toBe("token: [REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    const bearer = "Bearer " + "x".repeat(30);
    expect(redactSecrets(`Authorization: ${bearer}`)).toBe("Authorization: [REDACTED]");
  });

  it("redacts ANTHROPIC_API_KEY env assignments", () => {
    expect(redactSecrets("ANTHROPIC_API_KEY=sk-ant-secret123")).toBe("[REDACTED]");
  });

  it("redacts OPENAI_API_KEY env assignments", () => {
    expect(redactSecrets("OPENAI_API_KEY=sk-openai-key")).toBe("[REDACTED]");
  });

  it("redacts AWS_SECRET_ACCESS_KEY env assignments", () => {
    expect(redactSecrets("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG")).toBe("[REDACTED]");
  });

  it("redacts PEM private keys", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(pem)).toBe("[REDACTED]");
  });

  it("redacts OPENSSH private keys", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\ndata\n-----END OPENSSH PRIVATE KEY-----";
    expect(redactSecrets(pem)).toBe("[REDACTED]");
  });

  it("redacts Slack bot tokens (xoxb-*)", () => {
    expect(redactSecrets("token: xoxb-123-456-abc")).toBe("token: [REDACTED]");
  });

  it("redacts Slack user tokens (xoxp-*)", () => {
    expect(redactSecrets("token: xoxp-123-456-abc")).toBe("token: [REDACTED]");
  });

  it("redacts multiple secrets in one string", () => {
    const input = "keys: sk-ant-abc123 and ghp_" + "d".repeat(36);
    const result = redactSecrets(input);
    expect(result).toBe("keys: [REDACTED] and [REDACTED]");
  });

  it("handles empty string", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("handles repeated calls (regex lastIndex reset)", () => {
    const secret = "sk-ant-abc123_DEF";
    expect(redactSecrets(secret)).toBe("[REDACTED]");
    expect(redactSecrets(secret)).toBe("[REDACTED]");
  });
});
