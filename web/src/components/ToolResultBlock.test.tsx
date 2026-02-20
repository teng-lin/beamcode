import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolResultBlock } from "./ToolResultBlock";

// Must match MAX_LINES in ToolResultBlock.tsx
const MAX_LINES = 50;

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

function mockClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

describe("ToolResultBlock", () => {
  it("renders tool name in summary", () => {
    render(<ToolResultBlock toolName="Bash" content="hello" />);
    expect(screen.getByText("Bash")).toBeInTheDocument();
  });

  it("falls back to 'Tool result' when toolName is null", () => {
    render(<ToolResultBlock toolName={null} content="output" />);
    expect(screen.getByText("Tool result")).toBeInTheDocument();
  });

  it("shows (error) indicator when isError is true", () => {
    render(<ToolResultBlock toolName="Bash" content="fail" isError />);
    expect(screen.getByText("(error)")).toBeInTheDocument();
  });

  it("does not show (error) when isError is false", () => {
    render(<ToolResultBlock toolName="Bash" content="ok" />);
    expect(screen.queryByText("(error)")).not.toBeInTheDocument();
  });

  it("renders as a <details> element", () => {
    const { container } = render(<ToolResultBlock toolName="Bash" content="hi" />);
    expect(container.querySelector("details")).toBeInTheDocument();
  });

  describe("Bash", () => {
    it("strips ANSI escape codes", () => {
      render(<ToolResultBlock toolName="Bash" content={"\u001B[32mgreen\u001B[0m plain"} />);
      expect(screen.getByText("green plain")).toBeInTheDocument();
    });

    it("shows line numbers", () => {
      const { container } = render(<ToolResultBlock toolName="Bash" content={"first\nsecond"} />);
      const gutters = container.querySelectorAll(".select-none");
      expect(gutters[0]?.textContent).toBe("1");
      expect(gutters[1]?.textContent).toBe("2");
    });
  });

  describe("Read/Write/Edit", () => {
    it.each(["Read", "Write", "Edit"])("%s shows line numbers", (tool) => {
      const { container } = render(<ToolResultBlock toolName={tool} content={"a\nb\nc"} />);
      const gutters = container.querySelectorAll(".select-none");
      expect(gutters[0]?.textContent).toBe("1");
      expect(gutters[2]?.textContent).toBe("3");
    });

    it("preserves content verbatim (no ANSI stripping)", () => {
      const raw = "\u001B[31mred\u001B[0m";
      const { container } = render(<ToolResultBlock toolName="Read" content={raw} />);
      expect(container.querySelector("pre")?.textContent).toContain(raw);
    });
  });

  describe("Grep", () => {
    it("highlights file:line: prefix with muted styling", () => {
      render(<ToolResultBlock toolName="Grep" content="src/main.ts:42:  const x = 1;" />);
      const prefix = screen.getByText("src/main.ts:42:");
      expect(prefix).toBeInTheDocument();
      expect(prefix.className).toContain("text-bc-text-muted/50");
    });

    it("renders non-matching lines without highlight spans", () => {
      render(<ToolResultBlock toolName="Grep" content="no colon match here" />);
      expect(screen.getByText("no colon match here")).toBeInTheDocument();
    });

    it("does not show line numbers", () => {
      const { container } = render(<ToolResultBlock toolName="Grep" content={"a\nb"} />);
      expect(container.querySelectorAll(".select-none")).toHaveLength(0);
    });
  });

  describe("Glob", () => {
    it("renders plain text without line numbers", () => {
      const { container } = render(
        <ToolResultBlock toolName="Glob" content={"src/a.ts\nsrc/b.ts"} />,
      );
      expect(container.querySelector("pre")?.textContent).toContain("src/a.ts");
      expect(container.querySelector("pre")?.textContent).toContain("src/b.ts");
      expect(container.querySelectorAll(".select-none")).toHaveLength(0);
    });
  });

  describe("WebFetch/WebSearch", () => {
    it.each(["WebFetch", "WebSearch"])("%s renders content as markdown", (tool) => {
      const { container } = render(<ToolResultBlock toolName={tool} content="**bold text**" />);
      expect(container.querySelector("strong")?.textContent).toBe("bold text");
    });
  });

  describe("default / JSON", () => {
    it("pretty-prints valid JSON strings", () => {
      const { container } = render(
        <ToolResultBlock toolName="SomeUnknownTool" content='{"a":1}' />,
      );
      expect(container.querySelector("pre")?.textContent).toContain('"a": 1');
    });

    it("renders invalid JSON strings as-is", () => {
      const { container } = render(
        <ToolResultBlock toolName="SomeUnknownTool" content="not json" />,
      );
      expect(container.querySelector("pre")?.textContent).toContain("not json");
    });

    it("serializes ConsumerContentBlock[] to JSON", () => {
      const blocks = [{ type: "text" as const, text: "hello" }];
      const { container } = render(<ToolResultBlock toolName="SomeUnknownTool" content={blocks} />);
      const text = container.querySelector("pre")?.textContent;
      expect(text).toContain('"type": "text"');
      expect(text).toContain('"text": "hello"');
    });

    it("falls back to JSON for null toolName", () => {
      const { container } = render(<ToolResultBlock toolName={null} content='{"key":"val"}' />);
      expect(container.querySelector("pre")?.textContent).toContain('"key": "val"');
    });
  });

  describe("truncation", () => {
    it("does not truncate content at exactly MAX_LINES", () => {
      render(<ToolResultBlock toolName="Bash" content={lines(MAX_LINES)} />);
      expect(screen.getByText(`line ${MAX_LINES}`)).toBeInTheDocument();
      expect(screen.queryByText(/Show all/)).not.toBeInTheDocument();
    });

    it("truncates content beyond MAX_LINES and shows expand button", () => {
      render(<ToolResultBlock toolName="Bash" content={lines(100)} />);
      expect(screen.getByText(`line ${MAX_LINES}`)).toBeInTheDocument();
      expect(screen.queryByText(`line ${MAX_LINES + 1}`)).not.toBeInTheDocument();
      expect(screen.getByText("Show all (100 lines)")).toBeInTheDocument();
    });

    it("expands to full content when expand button is clicked", async () => {
      const user = userEvent.setup();
      render(<ToolResultBlock toolName="Bash" content={lines(80)} />);

      await user.click(screen.getByText("Show all (80 lines)"));

      expect(screen.getByText("line 80")).toBeInTheDocument();
      expect(screen.queryByText(/Show all/)).not.toBeInTheDocument();
    });
  });

  describe("copy", () => {
    const originalClipboard = navigator.clipboard;

    afterEach(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: originalClipboard,
        configurable: true,
      });
    });

    it("copies content to clipboard", async () => {
      const user = userEvent.setup();
      const writeText = mockClipboard();
      render(<ToolResultBlock toolName="Glob" content="file.ts" />);

      await user.click(screen.getByRole("button", { name: /copy to clipboard/i }));
      expect(writeText).toHaveBeenCalledWith("file.ts");
    });

    it("shows 'Copied' feedback after clicking", async () => {
      const user = userEvent.setup();
      mockClipboard();
      render(<ToolResultBlock toolName="Glob" content="file.ts" />);

      await user.click(screen.getByRole("button", { name: /copy to clipboard/i }));
      expect(screen.getByText("Copied")).toBeInTheDocument();
    });

    it("does not throw when clipboard API is unavailable", async () => {
      const user = userEvent.setup();
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
        configurable: true,
      });
      render(<ToolResultBlock toolName="Glob" content="file.ts" />);
      await expect(
        user.click(screen.getByRole("button", { name: /copy to clipboard/i })),
      ).resolves.not.toThrow();
    });

    it("copies full untruncated content even when display is truncated", async () => {
      const user = userEvent.setup();
      const writeText = mockClipboard();
      const fullContent = lines(100);
      render(<ToolResultBlock toolName="Bash" content={fullContent} />);

      await user.click(screen.getByRole("button", { name: /copy to clipboard/i }));
      expect(writeText).toHaveBeenCalledWith(fullContent);
    });
  });

  describe("error styling", () => {
    it("applies error class to summary", () => {
      const { container } = render(<ToolResultBlock toolName="Bash" content="fail" isError />);
      const summary = container.querySelector("summary");
      expect(summary?.className).toContain("text-bc-error");
    });

    it("applies error class to pre block for PreBlock tools", () => {
      const { container } = render(<ToolResultBlock toolName="Bash" content="err" isError />);
      const pre = container.querySelector("pre");
      expect(pre?.className).toContain("text-bc-error");
    });
  });
});
