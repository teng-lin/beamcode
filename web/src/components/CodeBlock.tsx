import { useState } from "react";

interface CodeBlockProps {
  language: string;
  code: string;
}

export function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-lg border border-bc-border/40 bg-bc-surface/50 overflow-hidden text-xs">
      <div className="flex items-center justify-between px-3 py-1.5 bg-bc-surface/80 border-b border-bc-border/30">
        <span className="font-mono-code text-bc-text-muted opacity-70">{language || "code"}</span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? "Copied" : "Copy code"}
          className="text-bc-text-muted opacity-50 hover:opacity-100 transition-opacity text-xs"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="p-3 font-mono-code leading-relaxed overflow-auto max-h-80 text-bc-text-muted/80">
        <code>{code}</code>
      </pre>
    </div>
  );
}
