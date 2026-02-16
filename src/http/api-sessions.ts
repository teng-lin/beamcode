import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";
import type { SessionManager } from "../core/session-manager.js";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        rejected = true;
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString());
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function handleApiSessions(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessionManager: SessionManager,
): void {
  const segments = url.pathname.split("/").filter(Boolean); // ["api", "sessions", ...]
  const method = req.method ?? "GET";

  // GET /api/sessions — list all sessions
  if (segments.length === 2 && method === "GET") {
    const sessions = sessionManager.launcher.listSessions();
    json(res, 200, sessions);
    return;
  }

  // POST /api/sessions — create new session
  if (segments.length === 2 && method === "POST") {
    readBody(req)
      .then((body) => {
        let opts: Record<string, unknown> = {};
        if (body) {
          try {
            opts = JSON.parse(body) as Record<string, unknown>;
          } catch {
            json(res, 400, { error: "Invalid JSON" });
            return;
          }
        }
        // Validate cwd: must resolve to an existing directory.
        // Note: path.resolve() normalizes ".." segments, so checking the
        // resolved string for ".." would be ineffective. Instead we verify
        // the path exists and is a real directory on the filesystem.
        const cwd = opts.cwd as string | undefined;
        if (cwd) {
          const resolved = resolvePath(cwd);
          if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
            json(res, 400, { error: "Invalid cwd: not an existing directory" });
            return;
          }
        }
        const session = sessionManager.launcher.launch({
          cwd,
          model: opts.model as string | undefined,
        });
        json(res, 201, session);
      })
      .catch((err) => {
        const status = err instanceof Error && err.message === "Request body too large" ? 413 : 400;
        json(res, status, { error: err instanceof Error ? err.message : "Bad request" });
      });
    return;
  }

  // /api/sessions/:id
  const sessionId = segments[2];
  if (!sessionId) {
    json(res, 404, { error: "Not found" });
    return;
  }

  // GET /api/sessions/:id — get session info
  if (method === "GET") {
    const session = sessionManager.launcher.getSession(sessionId);
    if (!session) {
      json(res, 404, { error: "Session not found" });
      return;
    }
    json(res, 200, session);
    return;
  }

  // DELETE /api/sessions/:id — stop session
  if (method === "DELETE") {
    sessionManager.launcher
      .kill(sessionId)
      .then((killed) => {
        if (killed) {
          json(res, 200, { status: "stopped" });
        } else {
          json(res, 404, { error: "Session not found" });
        }
      })
      .catch((err) => {
        json(res, 500, { error: err instanceof Error ? err.message : "Internal error" });
      });
    return;
  }

  json(res, 405, { error: "Method not allowed" });
}
