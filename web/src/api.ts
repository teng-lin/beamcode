import type { SessionInfo } from "./store";

const BASE = "/api";

function getApiKey(): string | null {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="beamcode-consumer-token"]')?.content ?? null
  );
}

function authHeaders(): Record<string, string> {
  const key = getApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export async function listSessions(): Promise<SessionInfo[]> {
  const res = await fetch(`${BASE}/sessions`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`);
  return res.json();
}

export async function createSession(options: {
  cwd?: string;
  model?: string;
  adapter?: string;
}): Promise<SessionInfo> {
  const res = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(options),
  });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  return res.json();
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`${BASE}/sessions/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to delete session: ${res.status}`);
}

export async function getSession(id: string): Promise<SessionInfo> {
  const res = await fetch(`${BASE}/sessions/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to get session: ${res.status}`);
  return res.json();
}

export async function archiveSession(id: string): Promise<void> {
  const res = await fetch(`${BASE}/sessions/${id}/archive`, {
    method: "PUT",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to archive session: ${res.status}`);
}

export async function unarchiveSession(id: string): Promise<void> {
  const res = await fetch(`${BASE}/sessions/${id}/unarchive`, {
    method: "PUT",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to unarchive session: ${res.status}`);
}

export async function renameSession(id: string, name: string): Promise<void> {
  const res = await fetch(`${BASE}/sessions/${id}/rename`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Failed to rename session: ${res.status}`);
}
