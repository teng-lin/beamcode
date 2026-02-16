import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "./sanitize";

describe("sanitizeHtml", () => {
  it("passes through safe HTML", () => {
    expect(sanitizeHtml("<p>hello</p>")).toBe("<p>hello</p>");
  });

  it("strips script tags", () => {
    const result = sanitizeHtml('<p>ok</p><script>alert("xss")</script>');
    expect(result).not.toContain("<script");
    expect(result).toContain("<p>ok</p>");
  });

  it("strips event handlers", () => {
    const result = sanitizeHtml('<img src="x" onerror="alert(1)">');
    expect(result).not.toContain("onerror");
  });

  it("strips iframe tags", () => {
    const result = sanitizeHtml('<iframe src="https://evil.com"></iframe>');
    expect(result).not.toContain("<iframe");
  });

  it("preserves target and rel attributes on links", () => {
    const result = sanitizeHtml('<a href="https://example.com" target="_blank" rel="noopener">link</a>');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener"');
  });

  it("strips javascript: URLs", () => {
    const result = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(result).not.toContain("javascript:");
  });

  it("strips data: URIs in href", () => {
    const result = sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">click</a>');
    expect(result).not.toContain("data:");
  });
});
