import { marked } from "marked";
import { memo, useMemo } from "react";
import { sanitizeHtml } from "../utils/sanitize";

interface MarkdownContentProps {
  content: string;
}

/**
 * Fixes markdown where a code fence is broken by inner fence markers.
 *
 * When Claude wraps file content in ``` backticks, and the file itself
 * contains ``` fence markers, those inner fences prematurely close the
 * outer fence — causing fragmented rendering (multiple boxes instead of one).
 *
 * The fix: extend the outer fence to use more backticks than any inner fence.
 * Per CommonMark spec, a closing fence must be >= the opening fence length,
 * so a ```` outer fence is never closed by a ``` inner fence.
 */
export function fixNestedCodeFences(content: string): string {
  const lines = content.split("\n");

  // Collect all fence-only lines (lines consisting of only 3+ backticks)
  const fenceOnlyLines: Array<{ idx: number; len: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(`{3,})\s*$/);
    if (m) fenceOnlyLines.push({ idx: i, len: m[1].length });
  }

  // Find the first fence line (may have a language identifier)
  const firstFenceIdx = lines.findIndex((line) => /^`{3,}[a-zA-Z0-9-]*\s*$/.test(line));
  if (firstFenceIdx === -1) return content;

  const hasLangOpener = /^`{3,}[a-zA-Z0-9-]+\s*$/.test(lines[firstFenceIdx]);
  const totalFences = fenceOnlyLines.length + (hasLangOpener ? 1 : 0);

  // Only fix when there are 3+ total fence lines (clearly broken structure)
  if (totalFences <= 2) return content;

  // If there's a second fence opener with a language identifier after the first,
  // assume the structure is intentional multiple code blocks — leave it alone
  const hasSecondLangOpener = lines.some(
    (line, idx) => idx > firstFenceIdx && /^`{3,}[a-zA-Z0-9-]+\s*$/.test(line),
  );
  if (hasSecondLangOpener) return content;

  // Compute the minimum fence length that's longer than all inner fences
  const openingLen = lines[firstFenceIdx].match(/^(`+)/)?.[1].length ?? 3;
  const openingLang = lines[firstFenceIdx].match(/^`+([a-zA-Z0-9-]*)/)?.[1] ?? "";
  const maxFenceLen = Math.max(openingLen, ...fenceOnlyLines.map((f) => f.len));
  const neededLen = maxFenceLen + 1;
  const newFence = "`".repeat(neededLen);

  const result = [...lines];

  // Extend the opening fence, preserving any language identifier
  result[firstFenceIdx] = newFence + openingLang;

  // Place the closing fence:
  // - If content follows the last fence-only line, append a new close at the end
  //   so that trailing content (e.g. headings after the diagram) stays in the block
  // - Otherwise replace the last fence-only line with the extended close
  const lastFenceOnly = fenceOnlyLines[fenceOnlyLines.length - 1];
  const hasContentAfterLast =
    lastFenceOnly && lines.slice(lastFenceOnly.idx + 1).some((l) => l.trim().length > 0);

  if (!lastFenceOnly || lastFenceOnly.idx === firstFenceIdx || hasContentAfterLast) {
    result.push(newFence);
  } else {
    result[lastFenceOnly.idx] = newFence;
  }

  return result.join("\n");
}

export const MarkdownContent = memo(function MarkdownContent({ content }: MarkdownContentProps) {
  const html = useMemo(() => {
    try {
      const fixed = fixNestedCodeFences(content);
      const raw = marked.parse(fixed, { async: false }) as string;
      return sanitizeHtml(raw);
    } catch {
      // Fallback to escaped plain text if markdown parsing fails
      return content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
  }, [content]);

  return (
    <div
      className="prose-bc"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized by DOMPurify
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
