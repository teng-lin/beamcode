import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpencodeHttpClient } from "./opencode-http-client.js";
import type { OpencodeHealthResponse, OpencodeSession } from "./opencode-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "http://localhost:4096";
const DIRECTORY = "/home/user/project";
const SESSION_ID = "sess-abc123";
const REQUEST_ID = "perm-001";

function makeSession(overrides?: Partial<OpencodeSession>): OpencodeSession {
  return {
    id: SESSION_ID,
    slug: "test-session",
    projectID: "proj-1",
    directory: DIRECTORY,
    title: "Test Session",
    version: "1.0.0",
    time: { created: 1000, updated: 2000 },
    ...overrides,
  };
}

function makeOkResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeOkTextResponse(text: string, init?: ResponseInit): Response {
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
    ...init,
  });
}

function makeEmptyOkResponse(): Response {
  return new Response("", { status: 200 });
}

function makeErrorResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

function makeSseResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: test\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function capturedUrl(fetchMock: ReturnType<typeof vi.fn>): string {
  return fetchMock.mock.calls[0][0] as string;
}

function capturedInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  return fetchMock.mock.calls[0][1] as RequestInit;
}

function capturedHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  return capturedInit(fetchMock).headers as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. createSession
// ---------------------------------------------------------------------------

describe("createSession", () => {
  it("sends POST /session with directory header and returns parsed session", async () => {
    const session = makeSession();
    fetchMock.mockResolvedValueOnce(makeOkResponse(session));

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    const result = await client.createSession();

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = capturedUrl(fetchMock);
    expect(url).toContain("/session");
    expect(url).toContain(`directory=${encodeURIComponent(DIRECTORY)}`);

    const init = capturedInit(fetchMock);
    expect(init.method).toBe("POST");

    const headers = capturedHeaders(fetchMock);
    expect(headers["X-Opencode-Directory"]).toBe(DIRECTORY);

    expect(result).toEqual(session);
  });

  it("sends custom session request body", async () => {
    const session = makeSession({ title: "Custom" });
    fetchMock.mockResolvedValueOnce(makeOkResponse(session));

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    await client.createSession({ title: "Custom", parentID: "parent-1" });

    const init = capturedInit(fetchMock);
    const body = JSON.parse(init.body as string);
    expect(body.title).toBe("Custom");
    expect(body.parentID).toBe("parent-1");
  });
});

// ---------------------------------------------------------------------------
// 2. promptAsync
// ---------------------------------------------------------------------------

describe("promptAsync", () => {
  it("sends POST /session/:id/prompt_async with body and returns void", async () => {
    fetchMock.mockResolvedValueOnce(makeEmptyOkResponse());

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    const result = await client.promptAsync(SESSION_ID, {
      parts: [{ type: "text", text: "Hello" }],
    });

    expect(result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();

    const url = capturedUrl(fetchMock);
    expect(url).toContain(`/session/${SESSION_ID}/prompt_async`);

    const init = capturedInit(fetchMock);
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(body.parts).toHaveLength(1);
    expect(body.parts[0].text).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// 3. abort
// ---------------------------------------------------------------------------

describe("abort", () => {
  it("sends POST /session/:id/abort", async () => {
    fetchMock.mockResolvedValueOnce(makeEmptyOkResponse());

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    await client.abort(SESSION_ID);

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = capturedUrl(fetchMock);
    expect(url).toContain(`/session/${SESSION_ID}/abort`);

    const init = capturedInit(fetchMock);
    expect(init.method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// 4. replyPermission
// ---------------------------------------------------------------------------

describe("replyPermission", () => {
  it("sends POST /permission/:id/reply with body", async () => {
    fetchMock.mockResolvedValueOnce(makeEmptyOkResponse());

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    await client.replyPermission(REQUEST_ID, { reply: "once" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = capturedUrl(fetchMock);
    expect(url).toContain(`/permission/${REQUEST_ID}/reply`);

    const init = capturedInit(fetchMock);
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(body.reply).toBe("once");
  });

  it("sends reply=always correctly", async () => {
    fetchMock.mockResolvedValueOnce(makeEmptyOkResponse());

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    await client.replyPermission(REQUEST_ID, { reply: "always" });

    const body = JSON.parse(capturedInit(fetchMock).body as string);
    expect(body.reply).toBe("always");
  });

  it("sends reply=reject correctly", async () => {
    fetchMock.mockResolvedValueOnce(makeEmptyOkResponse());

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    await client.replyPermission(REQUEST_ID, { reply: "reject" });

    const body = JSON.parse(capturedInit(fetchMock).body as string);
    expect(body.reply).toBe("reject");
  });
});

// ---------------------------------------------------------------------------
// 5. health
// ---------------------------------------------------------------------------

describe("health", () => {
  it("sends GET /global/health and returns parsed response", async () => {
    const healthResponse: OpencodeHealthResponse = { healthy: true, version: "1.2.3" };
    fetchMock.mockResolvedValueOnce(makeOkResponse(healthResponse));

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    const result = await client.health();

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = capturedUrl(fetchMock);
    expect(url).toContain("/global/health");

    const init = capturedInit(fetchMock);
    expect(init.method).toBe("GET");

    expect(result).toEqual(healthResponse);
  });

  it("handles healthy=false response", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse({ healthy: false }));

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    const result = await client.health();

    expect(result.healthy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. connectSse
// ---------------------------------------------------------------------------

describe("connectSse", () => {
  it("sends GET /event with Accept: text/event-stream and returns body stream", async () => {
    fetchMock.mockResolvedValueOnce(makeSseResponse());

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    const stream = await client.connectSse();

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = capturedUrl(fetchMock);
    expect(url).toContain("/event");

    const init = capturedInit(fetchMock);
    expect(init.method).toBe("GET");

    const headers = capturedHeaders(fetchMock);
    expect(headers["Accept"]).toBe("text/event-stream");

    expect(stream).toBeInstanceOf(ReadableStream);
  });

  it("passes AbortSignal through to fetch", async () => {
    fetchMock.mockResolvedValueOnce(makeSseResponse());

    const controller = new AbortController();
    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    await client.connectSse(controller.signal);

    const init = capturedInit(fetchMock);
    expect(init.signal).toBe(controller.signal);
  });

  it("throws when response has no body", async () => {
    const bodylessResponse = new Response(null, { status: 200 });
    fetchMock.mockResolvedValueOnce(bodylessResponse);

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    await expect(client.connectSse()).rejects.toThrow("SSE response has no body");
  });
});

// ---------------------------------------------------------------------------
// 7. Auth header — when password is set
// ---------------------------------------------------------------------------

describe("Auth header", () => {
  it("includes Authorization header when password is provided", async () => {
    fetchMock.mockResolvedValueOnce(makeEmptyOkResponse());

    const client = new OpencodeHttpClient({
      baseUrl: BASE_URL,
      directory: DIRECTORY,
      password: "secret123",
    });
    await client.abort(SESSION_ID);

    const headers = capturedHeaders(fetchMock);
    expect(headers["Authorization"]).toBeDefined();
    expect(headers["Authorization"]).toMatch(/^Basic /);
  });

  it("encodes credentials as base64 Basic auth with default username 'opencode'", async () => {
    fetchMock.mockResolvedValueOnce(makeEmptyOkResponse());

    const client = new OpencodeHttpClient({
      baseUrl: BASE_URL,
      directory: DIRECTORY,
      password: "mypassword",
    });
    await client.abort(SESSION_ID);

    const headers = capturedHeaders(fetchMock);
    const encoded = headers["Authorization"].replace("Basic ", "");
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    expect(decoded).toBe("opencode:mypassword");
  });

  it("uses custom username when provided", async () => {
    fetchMock.mockResolvedValueOnce(makeEmptyOkResponse());

    const client = new OpencodeHttpClient({
      baseUrl: BASE_URL,
      directory: DIRECTORY,
      username: "admin",
      password: "adminpass",
    });
    await client.abort(SESSION_ID);

    const headers = capturedHeaders(fetchMock);
    const encoded = headers["Authorization"].replace("Basic ", "");
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    expect(decoded).toBe("admin:adminpass");
  });

  // -------------------------------------------------------------------------
  // 8. Auth header — when no password
  // -------------------------------------------------------------------------

  it("does not include Authorization header when no password is provided", async () => {
    fetchMock.mockResolvedValueOnce(makeEmptyOkResponse());

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    await client.abort(SESSION_ID);

    const headers = capturedHeaders(fetchMock);
    expect(headers["Authorization"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. Directory scoping
// ---------------------------------------------------------------------------

describe("Directory scoping", () => {
  it("sets X-Opencode-Directory header on every request", async () => {
    fetchMock.mockResolvedValueOnce(makeEmptyOkResponse());

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    await client.abort(SESSION_ID);

    const headers = capturedHeaders(fetchMock);
    expect(headers["X-Opencode-Directory"]).toBe(DIRECTORY);
  });

  it("sets ?directory= query param on every request", async () => {
    fetchMock.mockResolvedValueOnce(makeEmptyOkResponse());

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    await client.abort(SESSION_ID);

    const url = new URL(capturedUrl(fetchMock));
    expect(url.searchParams.get("directory")).toBe(DIRECTORY);
  });

  it("strips trailing slash from baseUrl before constructing URL", async () => {
    fetchMock.mockResolvedValueOnce(makeEmptyOkResponse());

    const client = new OpencodeHttpClient({
      baseUrl: `${BASE_URL}/`,
      directory: DIRECTORY,
    });
    await client.abort(SESSION_ID);

    const url = capturedUrl(fetchMock);
    // Should not have double slashes in the path
    expect(url).not.toContain("//session");
  });
});

// ---------------------------------------------------------------------------
// 10. Error handling
// ---------------------------------------------------------------------------

describe("Error handling", () => {
  it("throws with status and error text on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(404, "not found"));

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    await expect(client.abort(SESSION_ID)).rejects.toThrow("404");
  });

  it("includes error body text in the thrown error", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(500, "internal server error"));

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    await expect(client.abort(SESSION_ID)).rejects.toThrow("internal server error");
  });

  it("includes HTTP method and path in the thrown error", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(403, "forbidden"));

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    await expect(client.abort(SESSION_ID)).rejects.toThrow("POST");
  });

  it("throws on 401 unauthorized", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(401, "unauthorized"));

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    await expect(client.health()).rejects.toThrow("401");
  });

  it("handles empty error body gracefully", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(503, ""));

    const client = new OpencodeHttpClient({ baseUrl: BASE_URL, directory: DIRECTORY });
    await expect(client.abort(SESSION_ID)).rejects.toThrow("503");
  });
});
