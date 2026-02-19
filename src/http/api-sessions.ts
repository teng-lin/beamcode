import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";
import { CLI_ADAPTER_NAMES, type CliAdapterName } from "../adapters/create-adapter.js";
import type { SessionManager } from "../core/session-manager.js";
import type { SdkSessionInfo } from "../types/session-state.js";

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

function toSyntheticSessionInfo(
  snapshot: ReturnType<SessionManager["bridge"]["getSession"]>,
): SdkSessionInfo | null {
  if (!snapshot) return null;
  return {
    sessionId: snapshot.id,
    state: snapshot.cliConnected ? "connected" : "starting",
    cwd: snapshot.state.cwd || process.cwd(),
    model: snapshot.state.model || undefined,
    permissionMode: snapshot.state.permissionMode || undefined,
    cliSessionId: snapshot.state.session_id || undefined,
    createdAt: snapshot.lastActivity || Date.now(),
  };
}

function listAllSessionInfos(sessionManager: SessionManager): SdkSessionInfo[] {
  const launcherSessions = sessionManager.launcher.listSessions();
  const byId = new Map<string, SdkSessionInfo>();
  for (const session of launcherSessions) {
    byId.set(session.sessionId, session);
  }

  for (const state of sessionManager.bridge.getAllSessions()) {
    const sessionId = state.session_id;
    if (!sessionId || byId.has(sessionId)) continue;
    const synthetic = toSyntheticSessionInfo(sessionManager.bridge.getSession(sessionId));
    if (synthetic) {
      byId.set(sessionId, synthetic);
    }
  }

  return Array.from(byId.values());
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
    const sessions = listAllSessionInfos(sessionManager);
    json(res, 200, sessions);
    return;
  }

  // POST /api/sessions — create new session
  if (segments.length === 2 && method === "POST") {
    readBody(req)
      .then(async (body) => {
        let opts: Record<string, unknown> = {};
        if (body) {
          try {
            opts = JSON.parse(body) as Record<string, unknown>;
          } catch {
            json(res, 400, { error: "Invalid JSON" });
            return;
          }
        }

        const cwd = opts.cwd as string | undefined;
        if (cwd) {
          const resolved = resolvePath(cwd);
          if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
            json(res, 400, { error: "Invalid cwd: not an existing directory" });
            return;
          }
        }

        const adapterName = opts.adapter as string | undefined;
        if (adapterName && !CLI_ADAPTER_NAMES.includes(adapterName as CliAdapterName)) {
          json(res, 400, {
            error: `Invalid adapter "${adapterName}". Valid: ${CLI_ADAPTER_NAMES.join(", ")}`,
          });
          return;
        }

        try {
          const result = await sessionManager.createSession({
            cwd,
            model: opts.model as string | undefined,
            adapterName: adapterName as CliAdapterName | undefined,
          });
          json(res, 201, result);
        } catch (err) {
          json(res, 500, {
            error: `Failed to create session: ${err instanceof Error ? err.message : err}`,
          });
        }
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
    const session =
      sessionManager.launcher.getSession(sessionId) ??
      toSyntheticSessionInfo(sessionManager.bridge.getSession(sessionId));
    if (!session) {
      json(res, 404, { error: "Session not found" });
      return;
    }
    json(res, 200, session);
    return;
  }

  // DELETE /api/sessions/:id — delete session (kill + remove from storage)
  if (method === "DELETE" && segments.length === 3) {
    sessionManager
      .deleteSession(sessionId)
      .then((deleted) => {
        if (deleted) {
          json(res, 200, { status: "deleted" });
        } else {
          json(res, 404, { error: "Session not found" });
        }
      })
      .catch((err) => {
        json(res, 500, { error: err instanceof Error ? err.message : "Internal error" });
      });
    return;
  }

  // PUT /api/sessions/:id/archive — archive a session
  // PUT /api/sessions/:id/unarchive — unarchive a session
  const action = segments[3];
  if (method === "PUT" && (action === "archive" || action === "unarchive")) {
    const session = sessionManager.launcher.getSession(sessionId);
    if (!session) {
      json(res, 404, { error: "Session not found" });
      return;
    }
    sessionManager.launcher.setArchived(sessionId, action === "archive");
    json(res, 200, { ...session, archived: action === "archive" });
    return;
  }

  // PUT /api/sessions/:id/rename — rename a session
  if (method === "PUT" && action === "rename") {
    readBody(req)
      .then((body) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          json(res, 400, { error: "Invalid JSON" });
          return;
        }

        if (typeof parsed.name !== "string" || !parsed.name.trim()) {
          json(res, 400, { error: "name is required and must be a non-empty string" });
          return;
        }

        const name = parsed.name.trim().slice(0, 100);

        const session = sessionManager.launcher.getSession(sessionId);
        if (!session) {
          json(res, 404, { error: "Session not found" });
          return;
        }

        sessionManager.launcher.setSessionName(sessionId, name);
        sessionManager.bridge.broadcastNameUpdate(sessionId, name);
        json(res, 200, { ...session, name });
      })
      .catch((err) => {
        const status = err instanceof Error && err.message === "Request body too large" ? 413 : 400;
        json(res, status, { error: err instanceof Error ? err.message : "Bad request" });
      });
    return;
  }

  json(res, 405, { error: "Method not allowed" });
}
