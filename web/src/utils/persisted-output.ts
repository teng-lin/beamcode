export interface ParsedPersistedOutput {
  /** Human-readable size string, e.g. "57.8KB" */
  size: string;
  /** File path where full output was saved */
  filePath: string;
  /** The truncated preview content */
  preview: string;
}

const PERSISTED_OUTPUT_RE = /^<persisted-output>\s*\n/;

/**
 * Returns true if the text is wrapped in `<persisted-output>` tags.
 */
export function isPersistedOutput(text: string): boolean {
  return PERSISTED_OUTPUT_RE.test(text);
}

/**
 * Parse a persisted-output block into its components.
 * Returns null if the text doesn't match the expected format.
 */
export function parsePersistedOutput(text: string): ParsedPersistedOutput | null {
  if (!isPersistedOutput(text)) return null;

  // Strip the wrapper tags
  const inner = text
    .replace(/^<persisted-output>\s*\n/, "")
    .replace(/\n<\/persisted-output>\s*$/, "");

  // Parse header line: "Output too large (57.8KB). Full output saved to: /path/to/file.txt"
  const headerMatch = inner.match(
    /^Output too large \(([^)]+)\)\.\s*Full output saved to:\s*(.+)/m,
  );

  const size = headerMatch?.[1] ?? "unknown";
  const filePath = headerMatch?.[2]?.trim() ?? "";

  // Extract preview content (everything after "Preview (first ...):\n")
  const previewMatch = inner.match(/Preview \(first [^)]*\):\s*\n([\s\S]*?)(?:\n\.\.\.\s*$|$)/);
  const preview = previewMatch?.[1] ?? "";

  return { size, filePath, preview };
}
