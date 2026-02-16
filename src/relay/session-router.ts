import type { IncomingMessage } from "node:http";
import type { ChildProcessSupervisor } from "../daemon/child-process-supervisor.js";

/**
 * Extracts a session ID from a WebSocket upgrade request path.
 * Expects paths like `/ws/consumer/:sessionId`.
 * Returns null if the path doesn't match.
 */
export function extractSessionId(url: string): string | null {
  const match = url.match(/^\/ws\/consumer\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Validate that a session exists and is active in the supervisor.
 * Returns the session info or null.
 */
export function routeSession(
  req: IncomingMessage,
  supervisor: ChildProcessSupervisor,
): { sessionId: string } | { error: string; statusCode: number } {
  const url = req.url ?? "/";
  const sessionId = extractSessionId(url);

  if (!sessionId) {
    return { error: "Invalid path: expected /ws/consumer/:sessionId", statusCode: 400 };
  }

  const session = supervisor.getSession(sessionId);
  if (!session) {
    return { error: `Session not found: ${sessionId}`, statusCode: 404 };
  }

  if (session.status !== "running") {
    return { error: `Session ${sessionId} is not running`, statusCode: 410 };
  }

  return { sessionId };
}
