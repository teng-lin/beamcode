import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnifiedDiffBlock } from "./UnifiedDiffBlock";

const SIMPLE_DIFF = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
-removed line`;

const MULTI_FILE_DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-old
+new
 same
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-remove
+add`;

const MIXED_OUTPUT = `commit abc123
Author: Test

diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -1 +1 @@
-old
+new`;

function lines(n: number, prefix = "ctx "): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join("\n");
}

function mockClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

describe("UnifiedDiffBlock", () => {
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
    });
  });

  it("renders added lines with data-diff='added'", () => {
    const { container } = render(<UnifiedDiffBlock text={SIMPLE_DIFF} />);
    const added = container.querySelector('[data-diff="added"]');
    expect(added).toBeInTheDocument();
    expect(added?.textContent).toBe("+added line");
  });

  it("renders removed lines with data-diff='removed'", () => {
    const { container } = render(<UnifiedDiffBlock text={SIMPLE_DIFF} />);
    const removed = container.querySelector('[data-diff="removed"]');
    expect(removed).toBeInTheDocument();
    expect(removed?.textContent).toBe("-removed line");
  });

  it("renders context lines with data-diff='context'", () => {
    const { container } = render(<UnifiedDiffBlock text={SIMPLE_DIFF} />);
    const ctxLines = container.querySelectorAll('[data-diff="context"]');
    expect(ctxLines.length).toBeGreaterThan(0);
  });

  it("renders hunk headers with data-diff='hunk-header'", () => {
    const { container } = render(<UnifiedDiffBlock text={SIMPLE_DIFF} />);
    const hunk = container.querySelector('[data-diff="hunk-header"]');
    expect(hunk).toBeInTheDocument();
    expect(hunk?.textContent).toContain("@@");
  });

  it("renders file path sub-header for each diff file", () => {
    render(<UnifiedDiffBlock text={SIMPLE_DIFF} />);
    expect(screen.getByText("file.ts")).toBeInTheDocument();
  });

  it("renders multiple file headers for multi-file diffs", () => {
    render(<UnifiedDiffBlock text={MULTI_FILE_DIFF} />);
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
  });

  it("renders text segments as plain text for mixed output", () => {
    render(<UnifiedDiffBlock text={MIXED_OUTPUT} />);
    expect(screen.getByText(/commit abc123/)).toBeInTheDocument();
  });

  it("applies isError styling to text segments", () => {
    const { container } = render(<UnifiedDiffBlock text={MIXED_OUTPUT} isError />);
    const textDiv = container.querySelector(".text-bc-error\\/80");
    expect(textDiv).toBeInTheDocument();
  });

  it("does not apply isError to diff lines (diff colors always override)", () => {
    const { container } = render(<UnifiedDiffBlock text={SIMPLE_DIFF} isError />);
    const added = container.querySelector('[data-diff="added"]');
    expect(added?.className).toContain("text-bc-success");
    expect(added?.className).not.toContain("text-bc-error/80");
  });

  describe("truncation", () => {
    it("truncates long diffs and shows expand button", () => {
      const longDiff = `--- a/f.ts\n+++ b/f.ts\n@@ -1,60 +1,60 @@\n${lines(60)}`;
      render(<UnifiedDiffBlock text={longDiff} />);
      expect(screen.getByText(/Show all/)).toBeInTheDocument();
    });

    it("expands to full content when button is clicked", async () => {
      const user = userEvent.setup();
      const longDiff = `--- a/f.ts\n+++ b/f.ts\n@@ -1,60 +1,60 @@\n${lines(60)}`;
      render(<UnifiedDiffBlock text={longDiff} />);

      await user.click(screen.getByText(/Show all/));
      expect(screen.queryByText(/Show all/)).not.toBeInTheDocument();
    });
  });

  describe("copy", () => {
    it("renders a copy button", () => {
      render(<UnifiedDiffBlock text={SIMPLE_DIFF} />);
      expect(screen.getByRole("button", { name: /copy to clipboard/i })).toBeInTheDocument();
    });

    it("copies full text to clipboard", async () => {
      const user = userEvent.setup();
      const writeText = mockClipboard();
      render(<UnifiedDiffBlock text={SIMPLE_DIFF} />);

      await user.click(screen.getByRole("button", { name: /copy to clipboard/i }));
      expect(writeText).toHaveBeenCalledWith(SIMPLE_DIFF);
    });
  });
});
