import type { SessionInfo } from "../store";
import { cwdBasename } from "./format";

/** Type guard that validates a session object has the required fields. */
export function isValidSession(s: unknown): s is SessionInfo {
  return (
    s != null &&
    typeof (s as SessionInfo).sessionId === "string" &&
    typeof (s as SessionInfo).createdAt === "number"
  );
}

/** Sort sessions by most recently created first, filtering out invalid entries. */
export function sortedSessions(sessions: Record<string, SessionInfo>): SessionInfo[] {
  return Object.values(sessions)
    .filter(isValidSession)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Filter sessions by a case-insensitive query against name or cwd basename. */
export function filterSessionsByQuery(sessions: SessionInfo[], query: string): SessionInfo[] {
  if (!query) return sessions;
  const q = query.toLowerCase();
  return sessions.filter((s) => {
    const name = s.name ?? cwdBasename(s.cwd ?? "");
    return name.toLowerCase().includes(q);
  });
}

/** Update the browser URL's `session` query param without a full navigation. */
export function updateSessionUrl(
  sessionId: string | null,
  method: "push" | "replace" = "replace",
): void {
  const url = new URL(window.location.href);
  if (sessionId) {
    url.searchParams.set("session", sessionId);
  } else {
    url.searchParams.delete("session");
  }
  if (method === "push") {
    window.history.pushState({}, "", url);
  } else {
    window.history.replaceState({}, "", url);
  }
}
