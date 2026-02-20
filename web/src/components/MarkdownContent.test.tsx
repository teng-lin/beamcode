import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fixNestedCodeFences, MarkdownContent } from "./MarkdownContent";

describe("MarkdownContent", () => {
  it("renders markdown as HTML", () => {
    render(<MarkdownContent content="**bold text**" />);
    const bold = screen.getByText("bold text");
    expect(bold.tagName).toBe("STRONG");
  });

  it("renders code blocks", () => {
    render(<MarkdownContent content={"`inline code`"} />);
    const code = screen.getByText("inline code");
    expect(code.tagName).toBe("CODE");
  });

  it("renders links", () => {
    render(<MarkdownContent content="[click](https://example.com)" />);
    const link = screen.getByRole("link", { name: "click" });
    expect(link).toHaveAttribute("href", "https://example.com");
  });

  it("sanitizes dangerous HTML in markdown", () => {
    render(<MarkdownContent content='<script>alert("xss")</script>safe text' />);
    expect(screen.getByText("safe text")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });

  it("renders plain text when given no markdown", () => {
    render(<MarkdownContent content="just plain text" />);
    expect(screen.getByText("just plain text")).toBeInTheDocument();
  });
});

describe("fixNestedCodeFences", () => {
  it("leaves content with no code fences unchanged", () => {
    const content = "Just some plain text\nwith no code blocks";
    expect(fixNestedCodeFences(content)).toBe(content);
  });

  it("leaves a single well-formed code block unchanged", () => {
    const content = "Intro:\n```\nfoo\nbar\n```";
    expect(fixNestedCodeFences(content)).toBe(content);
  });

  it("leaves a language-tagged code block unchanged", () => {
    const content = "```typescript\nconst x = 1;\n```";
    expect(fixNestedCodeFences(content)).toBe(content);
  });

  it("leaves two separate language-tagged code blocks unchanged", () => {
    const content = "```python\nprint('hi')\n```\n\nSome text.\n\n```js\nconsole.log('hi');\n```";
    expect(fixNestedCodeFences(content)).toBe(content);
  });

  it("fixes broken fence from inner fence markers (README case)", () => {
    // Simulates Claude wrapping file content that itself contains ``` fences
    const content = [
      "Here are the first 10 lines of README.md:",
      "",
      "```",
      "# Title",
      "",
      "Intro text",
      "",
      "```",
      "  ASCII art diagram",
      "```",
      "## Section heading",
    ].join("\n");

    const fixed = fixNestedCodeFences(content);

    // Extended fence marker should be present
    expect(fixed).toContain("````");
    // Inner ``` markers should still be there (not removed)
    expect(fixed).toContain("```");
    // All content should be in one extended fence block
    const fenceCount = fixed.split("\n").filter((l) => /^````\s*$/.test(l)).length;
    expect(fenceCount).toBe(2); // one open, one close
  });

  it("preserves language identifier when extending the opening fence", () => {
    const content = "```python\ncode here\n```\ninner\n```\nmore\n";
    const fixed = fixNestedCodeFences(content);
    expect(fixed).toContain("````python");
  });

  it("appends closing fence when content follows the last fence marker", () => {
    const content = ["```", "# Title", "```", "  ASCII art", "```", "## Heading at end"].join("\n");

    const fixed = fixNestedCodeFences(content);
    const fixedLines = fixed.split("\n");
    // Last line should be the extended closing fence
    expect(fixedLines[fixedLines.length - 1]).toBe("````");
    // All content including the trailing heading should be inside the block
    expect(fixed).toContain("## Heading at end");
  });

  it("does not merge intentional separate bare code blocks with prose between them", () => {
    // Two code blocks separated by a second language-tagged opener — left alone
    const content = "```python\ncode1\n```\n\nText.\n\n```js\ncode2\n```";
    expect(fixNestedCodeFences(content)).toBe(content);
  });
});
