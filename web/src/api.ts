import type { SessionInfo } from "./store";

const BASE = "/api";

export class AuthRequiredError extends Error {
  readonly validationLink?: string;
  readonly validationDescription?: string;
  readonly learnMoreUrl?: string;

  constructor(
    message: string,
    {
      validationLink,
      validationDescription,
      learnMoreUrl,
    }: {
      validationLink?: string;
      validationDescription?: string;
      learnMoreUrl?: string;
    },
  ) {
    super(message);
    this.name = "AuthRequiredError";
    this.validationLink = validationLink;
    this.validationDescription = validationDescription;
    this.learnMoreUrl = learnMoreUrl;
  }
}

function getApiKey(): string | null {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="beamcode-api-token"]')?.content ??
    // Backward-compatible fallback for pages that only inject the legacy meta tag.
    document.querySelector<HTMLMetaElement>('meta[name="beamcode-consumer-token"]')?.content ??
    null
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
  if (!res.ok) {
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}));
      if (body.authRequired) {
        const rawLink: unknown = body.validationLink;
        const safeLink =
          typeof rawLink === "string" && /^https?:\/\//i.test(rawLink) ? rawLink : undefined;
        throw new AuthRequiredError(body.error ?? "Authentication required", {
          ...body,
          validationLink: safeLink,
        });
      }
      throw new Error(body.error ?? `Failed to create session: ${res.status}`);
    }
    throw new Error(`Failed to create session: ${res.status}`);
  }
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
