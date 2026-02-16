import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { ChildProcessSupervisor, CreateSessionOptions } from "./child-process-supervisor.js";

export interface ControlApiOptions {
  supervisor: ChildProcessSupervisor;
  token: string;
  startedAt?: number;
}

/**
 * HTTP control API for the daemon.
 * Binds to 127.0.0.1:0 (random port, localhost only).
 * All endpoints require Bearer token authentication.
 */
export class ControlApi {
  private server: Server;
  private supervisor: ChildProcessSupervisor;
  private token: string;
  private startedAt: number;

  constructor(options: ControlApiOptions) {
    this.supervisor = options.supervisor;
    this.token = options.token;
    this.startedAt = options.startedAt ?? Date.now();
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve(port);
      });
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authenticate(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/health") {
      this.handleHealth(res);
    } else if (method === "GET" && path === "/sessions") {
      this.handleListSessions(res);
    } else if (method === "POST" && path === "/sessions") {
      this.handleCreateSession(req, res);
    } else if (method === "DELETE" && path.startsWith("/sessions/")) {
      const id = path.slice("/sessions/".length);
      this.handleDeleteSession(id, res);
    } else if (method === "POST" && path === "/revoke-device") {
      sendJson(res, 501, { error: "Not implemented" });
    } else {
      sendJson(res, 404, { error: "Not found" });
    }
  }

  private authenticate(req: IncomingMessage): boolean {
    const authHeader = req.headers.authorization;
    if (!authHeader) return false;
    const [scheme, value] = authHeader.split(" ", 2);
    if (scheme !== "Bearer" || !value) return false;
    const a = createHash("sha256").update(value).digest();
    const b = createHash("sha256").update(this.token).digest();
    return timingSafeEqual(a, b);
  }

  private handleHealth(res: ServerResponse): void {
    sendJson(res, 200, {
      status: "ok",
      uptime: Date.now() - this.startedAt,
      sessions: this.supervisor.sessionCount,
    });
  }

  private handleListSessions(res: ServerResponse): void {
    sendJson(res, 200, this.supervisor.listSessions());
  }

  private handleCreateSession(req: IncomingMessage, res: ServerResponse): void {
    const contentType = req.headers["content-type"];
    if (!contentType || !contentType.includes("application/json")) {
      sendJson(res, 400, { error: "Content-Type must be application/json" });
      return;
    }

    readBody(req)
      .then((body) => {
        let parsed: CreateSessionOptions;
        try {
          parsed = JSON.parse(body) as CreateSessionOptions;
        } catch {
          sendJson(res, 400, { error: "Invalid JSON" });
          return;
        }

        if (!parsed.cwd || typeof parsed.cwd !== "string") {
          sendJson(res, 400, { error: "Missing required field: cwd" });
          return;
        }

        const session = this.supervisor.createSession(parsed);
        sendJson(res, 201, session);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message === "Request body too large") {
          sendJson(res, 413, { error: "Request body too large" });
        } else {
          sendJson(res, 500, { error: "Failed to read request body" });
        }
      });
  }

  private handleDeleteSession(id: string, res: ServerResponse): void {
    const session = this.supervisor.getSession(id);
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    this.supervisor
      .stopSession(id)
      .then(() => {
        sendJson(res, 200, { status: "stopped", sessionId: id });
      })
      .catch(() => {
        sendJson(res, 500, { error: "Failed to stop session" });
      });
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const MAX_BODY_SIZE = 65_536; // 64 KB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let destroyed = false;
    req.on("data", (chunk: Buffer) => {
      if (destroyed) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_SIZE) {
        destroyed = true;
        req.destroy(new Error("Request body too large"));
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!destroyed) resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (err) => {
      if (!destroyed) reject(err);
    });
  });
}
