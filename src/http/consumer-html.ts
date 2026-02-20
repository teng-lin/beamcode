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
  const styleSrc = styleHashes.length > 0 ? styleHashes.join(" ") : "'none'";
  return `default-src 'self'; script-src ${scriptSrc}; style-src ${styleSrc}; connect-src 'self' ws: wss:; img-src 'self' data:;`;
}

/** Resolve web/dist/index.html relative to this module (works in both dev and prod). */
const consumerHtmlPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "web",
  "dist",
  "index.html",
);

export function loadConsumerHtml(): string {
  if (cachedHtml) return cachedHtml;

  cachedHtml = readFileSync(consumerHtmlPath, "utf-8");
  cachedGzip = gzipSync(cachedHtml);
  cachedCsp = buildCsp(cachedHtml);

  return cachedHtml;
}

/**
 * Inject a consumer token as a <meta> tag and recompute cached gzip + CSP.
 * This should be a scoped consumer token, NOT the master API key,
 * so that consumer page access does not grant full API access.
 */
export function injectConsumerToken(token: string): void {
  const baseHtml = loadConsumerHtml();
  const escaped = token
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  cachedHtml = baseHtml.replace(
    "<head>",
    `<head>\n  <meta name="beamcode-consumer-token" content="${escaped}">`,
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
