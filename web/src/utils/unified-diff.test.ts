import { describe, expect, it } from "vitest";
import { containsUnifiedDiff, parseUnifiedDiff } from "./unified-diff";

const SIMPLE_DIFF = `diff --git a/file.ts b/file.ts
index abc1234..def5678 100644
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3`;

const DIFF_U = `--- a/old.txt
+++ b/new.txt
@@ -1,2 +1,3 @@
 hello
+world
 bye`;

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

const GIT_LOG_P = `commit abc1234
Author: Test <test@test.com>
Date:   Mon Jan 1 00:00:00 2024

    fix something

diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,2 @@
-old
+new
 ctx`;

describe("containsUnifiedDiff", () => {
  it("detects git diff output", () => {
    expect(containsUnifiedDiff(SIMPLE_DIFF)).toBe(true);
  });

  it("detects diff -u output", () => {
    expect(containsUnifiedDiff(DIFF_U)).toBe(true);
  });

  it("detects multi-file diffs", () => {
    expect(containsUnifiedDiff(MULTI_FILE_DIFF)).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(containsUnifiedDiff("hello world\nfoo bar")).toBe(false);
  });

  it("returns false for text containing @@ without file headers", () => {
    expect(containsUnifiedDiff("some text\n@@ -1,3 +1,4 @@\nmore")).toBe(false);
  });

  it("returns false for diff --stat (no @@ headers)", () => {
    const stat = " file.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)";
    expect(containsUnifiedDiff(stat)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(containsUnifiedDiff("")).toBe(false);
  });

  it("returns false for --- without matching +++", () => {
    expect(containsUnifiedDiff("--- some text\nnot a diff\n@@ -1 +1 @@")).toBe(false);
  });
});

describe("parseUnifiedDiff", () => {
  it("parses a simple git diff into a single diff segment", () => {
    const segments = parseUnifiedDiff(SIMPLE_DIFF);
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("diff");
  });

  it("extracts file path from +++ header", () => {
    const segments = parseUnifiedDiff(SIMPLE_DIFF);
    const diff = segments[0] as Extract<(typeof segments)[0], { kind: "diff" }>;
    expect(diff.filePath).toBe("file.ts");
  });

  it("classifies line types correctly", () => {
    const segments = parseUnifiedDiff(SIMPLE_DIFF);
    const diff = segments[0] as Extract<(typeof segments)[0], { kind: "diff" }>;

    const types = diff.lines.map((l) => l.type);
    expect(types).toContain("header"); // diff --git
    expect(types).toContain("file-header"); // --- and +++
    expect(types).toContain("hunk-header"); // @@
    expect(types).toContain("added");
    expect(types).toContain("context");
  });

  it("parses removed lines", () => {
    const segments = parseUnifiedDiff(MULTI_FILE_DIFF);
    const diff = segments[0] as Extract<(typeof segments)[0], { kind: "diff" }>;
    const removed = diff.lines.filter((l) => l.type === "removed");
    expect(removed).toHaveLength(1);
    expect(removed[0].text).toBe("-old");
  });

  it("parses multi-file diffs into separate segments", () => {
    const segments = parseUnifiedDiff(MULTI_FILE_DIFF);
    const diffs = segments.filter((s) => s.kind === "diff");
    expect(diffs).toHaveLength(2);

    const paths = diffs.map((s) => (s as Extract<(typeof segments)[0], { kind: "diff" }>).filePath);
    expect(paths).toEqual(["a.ts", "b.ts"]);
  });

  it("separates text preamble from diff content (git log -p)", () => {
    const segments = parseUnifiedDiff(GIT_LOG_P);

    expect(segments[0].kind).toBe("text");
    const text = segments[0] as Extract<(typeof segments)[0], { kind: "text" }>;
    expect(text.content).toContain("commit abc1234");
    expect(text.content).toContain("fix something");

    expect(segments[1].kind).toBe("diff");
  });

  it("handles diff -u without git metadata", () => {
    const segments = parseUnifiedDiff(DIFF_U);
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("diff");

    const diff = segments[0] as Extract<(typeof segments)[0], { kind: "diff" }>;
    expect(diff.filePath).toBe("new.txt");
  });

  it("handles binary file diffs", () => {
    const binary = `diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ`;
    const segments = parseUnifiedDiff(binary);
    expect(segments).toHaveLength(1);
    const diff = segments[0] as Extract<(typeof segments)[0], { kind: "diff" }>;
    const binaryLine = diff.lines.find((l) => l.text.startsWith("Binary"));
    expect(binaryLine).toBeDefined();
    expect(binaryLine?.type).toBe("header");
  });

  it("handles '\\ No newline at end of file'", () => {
    const diff = `--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new`;
    const segments = parseUnifiedDiff(diff);
    const diffSeg = segments[0] as Extract<(typeof segments)[0], { kind: "diff" }>;
    const noNewline = diffSeg.lines.find((l) => l.text.includes("No newline"));
    expect(noNewline).toBeDefined();
    expect(noNewline?.type).toBe("header");
  });

  it("returns a single text segment for non-diff input", () => {
    const segments = parseUnifiedDiff("just some\nplain text");
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("text");
    expect((segments[0] as Extract<(typeof segments)[0], { kind: "text" }>).content).toBe(
      "just some\nplain text",
    );
  });

  it("strips b/ prefix from file paths", () => {
    const segments = parseUnifiedDiff(SIMPLE_DIFF);
    const diff = segments[0] as Extract<(typeof segments)[0], { kind: "diff" }>;
    expect(diff.filePath).toBe("file.ts");
    expect(diff.filePath).not.toContain("b/");
  });
});
