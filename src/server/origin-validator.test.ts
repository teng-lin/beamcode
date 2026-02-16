import { describe, expect, it } from "vitest";
import { OriginValidator } from "./origin-validator.js";

describe("OriginValidator", () => {
  // ── Localhost origins ───────────────────────────────────────────────

  it("accepts http://localhost", () => {
    const v = new OriginValidator();
    expect(v.isAllowed("http://localhost")).toBe(true);
  });

  it("accepts https://localhost", () => {
    const v = new OriginValidator();
    expect(v.isAllowed("https://localhost")).toBe(true);
  });

  it("accepts http://127.0.0.1", () => {
    const v = new OriginValidator();
    expect(v.isAllowed("http://127.0.0.1")).toBe(true);
  });

  it("accepts https://127.0.0.1", () => {
    const v = new OriginValidator();
    expect(v.isAllowed("https://127.0.0.1")).toBe(true);
  });

  it("accepts http://[::1]", () => {
    const v = new OriginValidator();
    expect(v.isAllowed("http://[::1]")).toBe(true);
  });

  it("accepts https://[::1]", () => {
    const v = new OriginValidator();
    expect(v.isAllowed("https://[::1]")).toBe(true);
  });

  // ── Localhost with ports ────────────────────────────────────────────

  it("accepts localhost with port", () => {
    const v = new OriginValidator();
    expect(v.isAllowed("http://localhost:3000")).toBe(true);
    expect(v.isAllowed("https://localhost:8080")).toBe(true);
  });

  it("accepts 127.0.0.1 with port", () => {
    const v = new OriginValidator();
    expect(v.isAllowed("http://127.0.0.1:5173")).toBe(true);
  });

  it("accepts [::1] with port", () => {
    const v = new OriginValidator();
    expect(v.isAllowed("http://[::1]:4000")).toBe(true);
  });

  // ── Custom allowlisted origins ──────────────────────────────────────

  it("accepts custom allowlisted origins", () => {
    const v = new OriginValidator({
      allowedOrigins: ["https://example.com"],
    });
    expect(v.isAllowed("https://example.com")).toBe(true);
  });

  it("rejects origins not in allowlist", () => {
    const v = new OriginValidator({
      allowedOrigins: ["https://example.com"],
    });
    expect(v.isAllowed("https://evil.com")).toBe(false);
  });

  // ── Unknown origins rejected ────────────────────────────────────────

  it("rejects unknown origins", () => {
    const v = new OriginValidator();
    expect(v.isAllowed("https://attacker.com")).toBe(false);
    expect(v.isAllowed("http://malicious.example.org")).toBe(false);
  });

  // ── Missing origin ─────────────────────────────────────────────────

  it("accepts missing origin by default", () => {
    const v = new OriginValidator();
    expect(v.isAllowed(undefined)).toBe(true);
  });

  it("rejects missing origin when allowMissingOrigin is false", () => {
    const v = new OriginValidator({ allowMissingOrigin: false });
    expect(v.isAllowed(undefined)).toBe(false);
  });

  // ── Case insensitivity ─────────────────────────────────────────────

  it("performs case-insensitive origin comparison", () => {
    const v = new OriginValidator({
      allowedOrigins: ["https://Example.COM"],
    });
    expect(v.isAllowed("https://example.com")).toBe(true);
    expect(v.isAllowed("HTTPS://EXAMPLE.COM")).toBe(true);
  });

  it("handles case-insensitive localhost", () => {
    const v = new OriginValidator();
    expect(v.isAllowed("HTTP://LOCALHOST")).toBe(true);
    expect(v.isAllowed("Http://Localhost:3000")).toBe(true);
  });

  // ── Empty string ───────────────────────────────────────────────────

  it("rejects empty string origin", () => {
    const v = new OriginValidator();
    expect(v.isAllowed("")).toBe(false);
  });

  // ── Invalid origins ────────────────────────────────────────────────

  it("rejects invalid origin strings", () => {
    const v = new OriginValidator();
    expect(v.isAllowed("not-a-url")).toBe(false);
  });
});
