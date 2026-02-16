import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

let cachedHtml: string | null = null;
let cachedGzip: Buffer | null = null;

export function loadConsumerHtml(): string {
  if (cachedHtml) return cachedHtml;

  // Resolves to dist/consumer/index.html (compiled) or src/consumer/index.html (dev via tsx)
  const htmlPath = join(dirname(fileURLToPath(import.meta.url)), "..", "consumer", "index.html");
  cachedHtml = readFileSync(htmlPath, "utf-8");
  cachedGzip = gzipSync(cachedHtml);
  return cachedHtml;
}

export function handleConsumerHtml(req: IncomingMessage, res: ServerResponse): void {
  const html = loadConsumerHtml();

  const securityHeaders = {
    "Content-Type": "text/html; charset=utf-8",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:;",
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
