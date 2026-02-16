import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

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
