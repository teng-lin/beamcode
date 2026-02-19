import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  archiveSession,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  unarchiveSession,
} from "./api";

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  document.head.innerHTML = '<meta name="beamcode-consumer-token" content="test-key">';
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
        status: 200,
      }),
    ),
  );
});

afterEach(() => {
  document.head.innerHTML = "";
  vi.restoreAllMocks();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch() {
  return fetch as ReturnType<typeof vi.fn>;
}

function mockResponse(body: unknown, ok = true, status = ok ? 200 : 404) {
  mockFetch().mockResolvedValueOnce({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("API functions", () => {
  describe("listSessions", () => {
    it("uses GET /api/sessions with auth header", async () => {
      mockResponse([]);
      await listSessions();
      expect(mockFetch()).toHaveBeenCalledWith("/api/sessions", {
        headers: { Authorization: "Bearer test-key" },
      });
    });
  });

  describe("createSession", () => {
    it("uses POST /api/sessions with JSON body", async () => {
      mockResponse({ sessionId: "s1" });
      await createSession({ cwd: "/test", model: "opus" });
      expect(mockFetch()).toHaveBeenCalledWith("/api/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        },
        body: JSON.stringify({ cwd: "/test", model: "opus" }),
      });
    });
  });

  describe("deleteSession", () => {
    it("uses DELETE /api/sessions/:id", async () => {
      mockResponse(null);
      await deleteSession("sess-1");
      expect(mockFetch()).toHaveBeenCalledWith("/api/sessions/sess-1", {
        method: "DELETE",
        headers: { Authorization: "Bearer test-key" },
      });
    });
  });

  describe("getSession", () => {
    it("uses GET /api/sessions/:id", async () => {
      mockResponse({ sessionId: "s1" });
      await getSession("sess-1");
      expect(mockFetch()).toHaveBeenCalledWith("/api/sessions/sess-1", {
        headers: { Authorization: "Bearer test-key" },
      });
    });
  });

  describe("archiveSession", () => {
    it("uses PUT /api/sessions/:id/archive", async () => {
      mockResponse(null);
      await archiveSession("sess-1");
      expect(mockFetch()).toHaveBeenCalledWith("/api/sessions/sess-1/archive", {
        method: "PUT",
        headers: { Authorization: "Bearer test-key" },
      });
    });
  });

  describe("unarchiveSession", () => {
    it("uses PUT /api/sessions/:id/unarchive", async () => {
      mockResponse(null);
      await unarchiveSession("sess-1");
      expect(mockFetch()).toHaveBeenCalledWith("/api/sessions/sess-1/unarchive", {
        method: "PUT",
        headers: { Authorization: "Bearer test-key" },
      });
    });
  });

  // ─── Auth header ────────────────────────────────────────────────────

  describe("auth", () => {
    it("includes Bearer token when meta tag present", async () => {
      mockResponse([]);
      await listSessions();
      const [, opts] = mockFetch().mock.calls[0];
      expect(opts.headers.Authorization).toBe("Bearer test-key");
    });

    it("no Authorization header when meta tag absent", async () => {
      document.head.innerHTML = "";
      mockResponse([]);
      await listSessions();
      const [, opts] = mockFetch().mock.calls[0];
      expect(opts.headers.Authorization).toBeUndefined();
    });
  });

  // ─── Error handling ─────────────────────────────────────────────────

  describe("error handling", () => {
    it("throws on non-OK response", async () => {
      mockResponse(null, false, 404);
      await expect(listSessions()).rejects.toThrow("Failed to list sessions: 404");
    });

    it("network error propagates", async () => {
      mockFetch().mockRejectedValueOnce(new Error("network error"));
      await expect(listSessions()).rejects.toThrow("network error");
    });

    it("each function throws with descriptive message on non-OK", async () => {
      mockResponse(null, false, 500);
      await expect(createSession({})).rejects.toThrow("Failed to create session: 500");

      mockResponse(null, false, 403);
      await expect(deleteSession("x")).rejects.toThrow("Failed to delete session: 403");

      mockResponse(null, false, 404);
      await expect(getSession("x")).rejects.toThrow("Failed to get session: 404");

      mockResponse(null, false, 500);
      await expect(archiveSession("x")).rejects.toThrow("Failed to archive session: 500");

      mockResponse(null, false, 500);
      await expect(unarchiveSession("x")).rejects.toThrow("Failed to unarchive session: 500");
    });
  });
});
