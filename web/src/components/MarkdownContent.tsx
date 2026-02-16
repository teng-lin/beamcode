import { marked } from "marked";
import { memo, useMemo } from "react";
import { sanitizeHtml } from "../utils/sanitize";

interface MarkdownContentProps {
  content: string;
}

export const MarkdownContent = memo(function MarkdownContent({ content }: MarkdownContentProps) {
  const html = useMemo(() => {
    try {
      const raw = marked.parse(content, { async: false }) as string;
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
