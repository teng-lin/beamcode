export type UnifiedDiffLineType =
  | "header"
  | "file-header"
  | "hunk-header"
  | "added"
  | "removed"
  | "context";

export interface UnifiedDiffLine {
  type: UnifiedDiffLineType;
  text: string;
}

export type UnifiedDiffSegment =
  | { kind: "text"; content: string }
  | { kind: "diff"; filePath?: string; lines: UnifiedDiffLine[] };

const HUNK_HEADER_RE = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/;
const FILE_HEADER_MINUS_RE = /^---\s+\S/;
const FILE_HEADER_PLUS_RE = /^\+\+\+\s+(\S.*)/;

/**
 * Fast check for whether text contains unified diff output.
 * Requires both a `--- `/`+++ ` file header pair AND at least one `@@ ... @@` hunk header.
 */
export function containsUnifiedDiff(text: string): boolean {
  if (!text.includes("@@")) return false;

  const lines = text.split("\n");
  let sawFileHeaders = false;
  let sawMinus = false;

  for (const line of lines) {
    if (FILE_HEADER_MINUS_RE.test(line)) {
      sawMinus = true;
    } else if (sawMinus && FILE_HEADER_PLUS_RE.test(line)) {
      sawFileHeaders = true;
    }

    if (sawFileHeaders && HUNK_HEADER_RE.test(line)) {
      return true;
    }
  }

  return false;
}

/**
 * Parse text into alternating text/diff segments.
 * Non-diff content (e.g. git log preamble) becomes `{ kind: "text" }` segments.
 * Diff hunks are parsed into typed lines within `{ kind: "diff" }` segments.
 */
export function parseUnifiedDiff(text: string): UnifiedDiffSegment[] {
  const inputLines = text.split("\n");
  const segments: UnifiedDiffSegment[] = [];
  let textBuffer: string[] = [];
  let diffLines: UnifiedDiffLine[] = [];
  let currentFilePath: string | undefined;
  let inDiff = false;

  function flushText() {
    if (textBuffer.length > 0) {
      segments.push({ kind: "text", content: textBuffer.join("\n") });
      textBuffer = [];
    }
  }

  function flushDiff() {
    if (diffLines.length > 0) {
      segments.push({ kind: "diff", filePath: currentFilePath, lines: diffLines });
      diffLines = [];
      currentFilePath = undefined;
    }
  }

  for (let i = 0; i < inputLines.length; i++) {
    const line = inputLines[i];

    // Detect start of a new diff file: `--- a/...` followed by `+++ b/...`
    if (FILE_HEADER_MINUS_RE.test(line) && i + 1 < inputLines.length) {
      const nextLine = inputLines[i + 1];
      if (FILE_HEADER_PLUS_RE.test(nextLine)) {
        if (!inDiff) {
          flushText();
          inDiff = true;
        }
        // Set file path (within an existing diff segment, this updates it)
        const rawPath = nextLine.match(FILE_HEADER_PLUS_RE)?.[1];
        currentFilePath = rawPath?.startsWith("b/") ? rawPath.slice(2) : rawPath;

        diffLines.push({ type: "file-header", text: line });
        diffLines.push({ type: "file-header", text: nextLine });
        i++; // skip the +++ line
        continue;
      }
    }

    if (inDiff) {
      if (HUNK_HEADER_RE.test(line)) {
        diffLines.push({ type: "hunk-header", text: line });
      } else if (line.startsWith("+")) {
        diffLines.push({ type: "added", text: line });
      } else if (line.startsWith("-")) {
        diffLines.push({ type: "removed", text: line });
      } else if (line.startsWith(" ") || line === "") {
        diffLines.push({ type: "context", text: line });
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file"
        diffLines.push({ type: "header", text: line });
      } else if (
        line.startsWith("diff ") ||
        line.startsWith("index ") ||
        line.startsWith("Binary ")
      ) {
        // Git diff metadata headers
        if (line.startsWith("diff ")) {
          // New file in a multi-file diff — flush previous diff segment
          flushDiff();
        }
        diffLines.push({ type: "header", text: line });
      } else {
        // Not a diff line — end of diff section
        flushDiff();
        inDiff = false;
        textBuffer.push(line);
      }
    } else {
      // Check for git diff header starting a new diff
      if (line.startsWith("diff ")) {
        flushText();
        inDiff = true;
        diffLines.push({ type: "header", text: line });
      } else {
        textBuffer.push(line);
      }
    }
  }

  // Flush remaining
  if (inDiff) {
    flushDiff();
  } else {
    flushText();
  }

  return segments;
}
