/**
 * OpenCode HTTP Client -- typed wrapper around fetch for the opencode serve API.
 */

import type {
  OpencodeCreateSessionRequest,
  OpencodeHealthResponse,
  OpencodePermissionReply,
  OpencodePromptRequest,
  OpencodeSession,
} from "./opencode-types.js";

export interface OpencodeHttpClientOptions {
  baseUrl: string;
  directory: string;
  password?: string;
  username?: string;
}

export class OpencodeHttpClient {
  private readonly baseUrl: string;
  private readonly directory: string;
  private readonly authHeader?: string;

  constructor(options: OpencodeHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.directory = options.directory;

    if (options.password) {
      const username = options.username ?? "opencode";
      const encoded = Buffer.from(`${username}:${options.password}`).toString("base64");
      this.authHeader = `Basic ${encoded}`;
    }
  }

  async createSession(request?: OpencodeCreateSessionRequest): Promise<OpencodeSession> {
    const res = await this.post("/session", request ?? {});
    return res as OpencodeSession;
  }

  async promptAsync(sessionId: string, request: OpencodePromptRequest): Promise<void> {
    await this.fetch(`/session/${sessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async abort(sessionId: string): Promise<void> {
    await this.fetch(`/session/${sessionId}/abort`, { method: "POST" });
  }

  async replyPermission(requestId: string, reply: OpencodePermissionReply): Promise<void> {
    await this.fetch(`/permission/${requestId}/reply`, {
      method: "POST",
      body: JSON.stringify(reply),
    });
  }

  async health(): Promise<OpencodeHealthResponse> {
    const res = await this.fetch("/global/health", { method: "GET" });
    return (await res.json()) as OpencodeHealthResponse;
  }

  async connectSse(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await this.fetch("/event", {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal,
    });

    if (!res.body) {
      throw new Error("SSE response has no body");
    }
    return res.body;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetch(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set("directory", this.directory);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Opencode-Directory": this.directory,
      ...(init.headers as Record<string, string>),
    };

    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }

    const res = await globalThis.fetch(url.toString(), {
      ...init,
      headers,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`opencode API ${init.method} ${path} failed: ${res.status} ${errorText}`);
    }

    return res;
  }
}
