import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_HTML = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
<script>console.log("hello");</script>
<style>body { color: red; }</style>
</body>
</html>`;

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => FAKE_HTML),
}));

function mockRes(): ServerResponse & {
  _status: number | null;
  _headers: Record<string, unknown>;
  _body: unknown;
} {
  const res = {
    _status: null as number | null,
    _headers: {} as Record<string, unknown>,
    _body: null as unknown,
    writeHead: vi.fn(function (
      this: typeof res,
      status: number,
      headers?: Record<string, unknown>,
    ) {
      this._status = status;
      if (headers) Object.assign(this._headers, headers);
    }),
    end: vi.fn(function (this: typeof res, body?: unknown) {
      if (body !== undefined) this._body = body;
    }),
  };
  return res as unknown as typeof res;
}

function mockReq(acceptEncoding?: string): IncomingMessage {
  return {
    headers: acceptEncoding !== undefined ? { "accept-encoding": acceptEncoding } : {},
  } as unknown as IncomingMessage;
}

// We need to reset modules between tests because of module-level caching
// in consumer-html.ts. Each describe block reimports the module fresh.

describe("consumer-html", () => {
  beforeEach(() => {
    vi.resetModules();
    // Re-register the mock after resetModules clears it
    vi.mock("node:fs", () => ({
      readFileSync: vi.fn(() => FAKE_HTML),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("loadConsumerHtml", () => {
    it("reads the HTML file and returns its content", async () => {
      const { loadConsumerHtml } = await import("./consumer-html.js");
      const html = loadConsumerHtml();
      expect(html).toBe(FAKE_HTML);
    });

    it("returns cached value on second call without re-reading", async () => {
      const { readFileSync } = await import("node:fs");
      const { loadConsumerHtml } = await import("./consumer-html.js");

      loadConsumerHtml();
      loadConsumerHtml();

      // readFileSync should only be called once due to caching
      expect(readFileSync).toHaveBeenCalledTimes(1);
    });

    it("resolves path relative to module at web/dist/index.html", async () => {
      const { readFileSync } = await import("node:fs");
      const { loadConsumerHtml } = await import("./consumer-html.js");

      loadConsumerHtml();

      const calledPath = vi.mocked(readFileSync).mock.calls[0][0] as string;
      expect(calledPath).toContain("web");
      expect(calledPath).toContain("dist");
      expect(calledPath).toContain("index.html");
    });
  });

  describe("handleConsumerHtml", () => {
    it("serves gzip when Accept-Encoding includes gzip", async () => {
      const { handleConsumerHtml } = await import("./consumer-html.js");
      const req = mockReq("gzip, deflate");
      const res = mockRes();

      handleConsumerHtml(req, res);

      expect(res._status).toBe(200);
      expect(res._headers["Content-Encoding"]).toBe("gzip");
      expect(res._headers["Content-Length"]).toBeDefined();
      // Verify the body is gzip-compressed FAKE_HTML
      const expected = gzipSync(FAKE_HTML);
      expect(Buffer.compare(res._body as Buffer, expected)).toBe(0);
    });

    it("serves plain HTML when no gzip accepted", async () => {
      const { handleConsumerHtml } = await import("./consumer-html.js");
      const req = mockReq("");
      const res = mockRes();

      handleConsumerHtml(req, res);

      expect(res._status).toBe(200);
      expect(res._headers["Content-Encoding"]).toBeUndefined();
      expect(res._body).toBe(FAKE_HTML);
    });

    it("serves plain HTML when accept-encoding header is absent", async () => {
      const { handleConsumerHtml } = await import("./consumer-html.js");
      const req = mockReq(undefined);
      const res = mockRes();

      handleConsumerHtml(req, res);

      expect(res._status).toBe(200);
      expect(res._body).toBe(FAKE_HTML);
    });

    it("includes security headers and CSP with sha256 hashes", async () => {
      const { handleConsumerHtml } = await import("./consumer-html.js");
      const req = mockReq("");
      const res = mockRes();

      handleConsumerHtml(req, res);

      expect(res._headers["X-Frame-Options"]).toBe("DENY");
      expect(res._headers["X-Content-Type-Options"]).toBe("nosniff");

      const csp = res._headers["Content-Security-Policy"] as string;
      expect(csp).toBeDefined();
      expect(csp).toContain("script-src");
      expect(csp).toContain("style-src");

      const scriptContent = 'console.log("hello");';
      const expectedScriptHash = createHash("sha256").update(scriptContent).digest("base64");
      expect(csp).toContain(`'sha256-${expectedScriptHash}'`);

      const styleContent = "body { color: red; }";
      const expectedStyleHash = createHash("sha256").update(styleContent).digest("base64");
      expect(csp).toContain(`'sha256-${expectedStyleHash}'`);
    });
  });

  describe("injectApiKey", () => {
    it("adds a meta tag with the api key", async () => {
      const { injectApiKey, loadConsumerHtml } = await import("./consumer-html.js");

      injectApiKey("test-key-123");
      const html = loadConsumerHtml();

      expect(html).toContain('<meta name="beamcode-api-key" content="test-key-123">');
    });

    it("escapes special HTML characters in the api key", async () => {
      const { injectApiKey, loadConsumerHtml } = await import("./consumer-html.js");

      injectApiKey('<script>"alert&xss"</script>');
      const html = loadConsumerHtml();

      // Verify characters are escaped
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("&quot;");
      expect(html).toContain("&amp;");
      expect(html).not.toContain('content="<script>');
    });

    it("recomputes gzip and CSP after injection", async () => {
      const { handleConsumerHtml, injectApiKey } = await import("./consumer-html.js");

      injectApiKey("my-key");

      const req = mockReq("gzip");
      const res = mockRes();
      handleConsumerHtml(req, res);

      // Verify gzip body can be decompressed to HTML containing the meta tag
      const { gunzipSync } = await import("node:zlib");
      const decompressed = gunzipSync(res._body as Buffer).toString();
      expect(decompressed).toContain('<meta name="beamcode-api-key" content="my-key">');
    });
  });
});
