import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

let cachedHtml: string | null = null;
let cachedGzip: Buffer | null = null;
let cachedCsp: string | null = null;

/** Compute SHA-256 hashes of inline <script> and <style> blocks for CSP. */
function computeInlineHashes(html: string): { scriptHashes: string[]; styleHashes: string[] } {
  const scriptHashes: string[] = [];
  const styleHashes: string[] = [];
  for (const [, content] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (content.trim()) {
      scriptHashes.push(`'sha256-${createHash("sha256").update(content).digest("base64")}'`);
    }
  }
  for (const [, content] of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    if (content.trim()) {
      styleHashes.push(`'sha256-${createHash("sha256").update(content).digest("base64")}'`);
    }
  }
  return { scriptHashes, styleHashes };
}

function buildCsp(html: string): string {
  const { scriptHashes, styleHashes } = computeInlineHashes(html);
  const scriptSrc = scriptHashes.length > 0 ? scriptHashes.join(" ") : "'none'";
  const styleSrc =
    styleHashes.length > 0 ? `${styleHashes.join(" ")} https://fonts.googleapis.com` : "'none'";
  return `default-src 'self'; script-src ${scriptSrc}; style-src ${styleSrc}; font-src https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data:;`;
}

export function loadConsumerHtml(): string {
  if (cachedHtml) return cachedHtml;

  // Resolves to dist/consumer/index.html (compiled) or src/consumer/index.html (dev via tsx)
  const htmlPath = join(dirname(fileURLToPath(import.meta.url)), "..", "consumer", "index.html");
  cachedHtml = readFileSync(htmlPath, "utf-8");
  cachedGzip = gzipSync(cachedHtml);
  cachedCsp = buildCsp(cachedHtml);

  return cachedHtml;
}

/** Inject API key as a <meta> tag and recompute cached gzip + CSP. */
export function injectApiKey(apiKey: string): void {
  const baseHtml = loadConsumerHtml();
  cachedHtml = baseHtml.replace(
    "<head>",
    `<head>\n  <meta name="beamcode-api-key" content="${apiKey}">`,
  );
  cachedGzip = gzipSync(cachedHtml);
  cachedCsp = buildCsp(cachedHtml);
}

export function handleConsumerHtml(req: IncomingMessage, res: ServerResponse): void {
  const html = loadConsumerHtml();

  const securityHeaders = {
    "Content-Type": "text/html; charset=utf-8",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": cachedCsp ?? "default-src 'self'",
  };

  const acceptEncoding = req.headers["accept-encoding"] ?? "";
  if (cachedGzip && acceptEncoding.includes("gzip")) {
    res.writeHead(200, {
      ...securityHeaders,
      "Content-Encoding": "gzip",
      "Content-Length": cachedGzip.length,
    });
    res.end(cachedGzip);
  } else {
    res.writeHead(200, securityHeaders);
    res.end(html);
  }
}
