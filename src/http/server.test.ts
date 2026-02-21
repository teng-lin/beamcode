import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./health.js", () => ({
  handleHealth: vi.fn((_req, res) => {
    res.writeHead(200);
    res.end("health-ok");
  }),
}));

vi.mock("./api-sessions.js", () => ({
  handleApiSessions: vi.fn((_req, res) => {
    res.writeHead(200);
    res.end("api-sessions-ok");
  }),
}));

vi.mock("./consumer-html.js", () => ({
  handleConsumerHtml: vi.fn((_req, res) => {
    res.writeHead(200);
    res.end("consumer-html-ok");
  }),
}));

import type { SessionCoordinator } from "../core/session-coordinator.js";
import { handleApiSessions } from "./api-sessions.js";
import { handleConsumerHtml } from "./consumer-html.js";
import { handleHealth } from "./health.js";
import { createBeamcodeServer } from "./server.js";

function mockSessionCoordinator(): SessionCoordinator {
  return {
    launcher: {
      listSessions: vi.fn(() => []),
      getSession: vi.fn(),
      launch: vi.fn(),
      kill: vi.fn(),
    },
  } as unknown as SessionCoordinator;
}

function getBaseUrl(server: http.Server): string {
  const addr = server.address();
  if (typeof addr === "string" || addr === null) {
    throw new Error("Expected AddressInfo");
  }
  return `http://127.0.0.1:${addr.port}`;
}

describe("createBeamcodeServer", () => {
  let server: ReturnType<typeof createBeamcodeServer>;
  let baseUrl: string;
  let sc: SessionCoordinator;

  beforeEach(async () => {
    vi.clearAllMocks();
    sc = mockSessionCoordinator();
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function startServer(opts?: { apiKey?: string; activeSessionId?: string }) {
    server = createBeamcodeServer({
      sessionCoordinator: sc,
      activeSessionId: opts?.activeSessionId ?? "sess-1",
      apiKey: opts?.apiKey,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = getBaseUrl(server);
  }

  // ---- Route delegation ----

  it("/health delegates to handleHealth", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(handleHealth).toHaveBeenCalled();
  });

  it("/api/sessions delegates to handleApiSessions", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(200);
    expect(handleApiSessions).toHaveBeenCalled();
  });

  // ---- API key gate ----

  it("returns 401 for /api/* when apiKey is set and auth header is missing", async () => {
    await startServer({ apiKey: "secret-key" });
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for /api/* when apiKey is set and auth header is wrong", async () => {
    await startServer({ apiKey: "secret-key" });
    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  it("allows /api/* through when auth header matches apiKey", async () => {
    await startServer({ apiKey: "secret-key" });
    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: "Bearer secret-key" },
    });
    expect(res.status).toBe(200);
    expect(handleApiSessions).toHaveBeenCalled();
  });

  it("does not require auth for /api/* when apiKey is not set", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(200);
    expect(handleApiSessions).toHaveBeenCalled();
  });

  // ---- Redirect bare / ----

  it("redirects bare / to /?session=<activeSessionId>", async () => {
    await startServer({ activeSessionId: "my-session" });
    const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?session=my-session");
  });

  // ---- Consumer HTML ----

  it("/ with ?session= param serves consumer HTML", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/?session=sess-1`);
    expect(res.status).toBe(200);
    expect(handleConsumerHtml).toHaveBeenCalled();
  });

  it("/index.html serves consumer HTML", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/index.html`);
    expect(res.status).toBe(200);
    expect(handleConsumerHtml).toHaveBeenCalled();
  });

  // ---- 404 ----

  it("returns 404 for unknown paths", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/unknown/path`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toBe("Not Found");
  });

  // ---- setActiveSessionId ----

  it("setActiveSessionId updates the redirect target", async () => {
    await startServer({ activeSessionId: "old-session" });

    // Verify initial redirect
    let res = await fetch(`${baseUrl}/`, { redirect: "manual" });
    expect(res.headers.get("location")).toBe("/?session=old-session");

    // Update active session
    server.setActiveSessionId("new-session");

    // Verify updated redirect
    res = await fetch(`${baseUrl}/`, { redirect: "manual" });
    expect(res.headers.get("location")).toBe("/?session=new-session");
  });

  it("throws when sessionCoordinator is not provided", () => {
    expect(() =>
      createBeamcodeServer({
        // @ts-expect-error validating runtime guard
        activeSessionId: "sess-1",
      }),
    ).toThrow("createBeamcodeServer requires sessionCoordinator");
  });
});
