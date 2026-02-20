export function truncateLines(
  text: string,
  max: number,
): { text: string; truncated: boolean; totalLines: number } {
  const lines = text.split("\n");
  if (lines.length <= max) return { text, truncated: false, totalLines: lines.length };
  return { text: lines.slice(0, max).join("\n"), truncated: true, totalLines: lines.length };
}
