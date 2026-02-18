/**
 * SessionStore — extracted from SessionBridge (Phase 1).
 *
 * Manages the session map (CRUD) and persistence. Delegates session creation
 * factory concerns (TeamToolCorrelationBuffer, SlashCommandRegistry) to the
 * caller via constructor-injected factories.
 */

import type { ConsumerIdentity, ConsumerRole } from "../interfaces/auth.js";
import type { RateLimiter } from "../interfaces/rate-limiter.js";
import type { SessionStorage } from "../interfaces/storage.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import type { PermissionRequest } from "../types/cli-messages.js";
import type { ConsumerMessage } from "../types/consumer-messages.js";
import type { SessionSnapshot, SessionState } from "../types/session-state.js";
import type { BackendSession } from "./interfaces/backend-adapter.js";
import type { SlashCommandRegistry } from "./slash-command-registry.js";
import type { TeamToolCorrelationBuffer } from "./team-tool-correlation.js";

// ─── Session type (internal to the bridge + store) ───────────────────────────

export interface QueuedMessage {
  consumerId: string;
  displayName: string;
  content: string;
  images?: { media_type: string; data: string }[];
  queuedAt: number;
}

export interface Session {
  id: string;
  cliSocket: WebSocketLike | null;
  cliSessionId?: string;
  /** BackendSession from BackendAdapter (coexistence: set when adapter path is used). */
  backendSession: BackendSession | null;
  /** AbortController for the backend message consumption loop. */
  backendAbort: AbortController | null;
  consumerSockets: Map<WebSocketLike, ConsumerIdentity>;
  consumerRateLimiters: Map<WebSocketLike, RateLimiter>;
  anonymousCounter: number;
  state: SessionState;
  pendingPermissions: Map<string, PermissionRequest>;
  messageHistory: ConsumerMessage[];
  pendingMessages: string[];
  /** Single-slot queue: a user message waiting to be sent when the session becomes idle. */
  queuedMessage: QueuedMessage | null;
  /** Last known CLI status (idle, running, compacting, or null if unknown). */
  lastStatus: "compacting" | "idle" | "running" | null;
  lastActivity: number;
  pendingInitialize: {
    requestId: string;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  /** Per-session correlation buffer for team tool_use↔tool_result pairing. */
  teamCorrelationBuffer: TeamToolCorrelationBuffer;
  /** Per-session slash command registry. */
  registry: SlashCommandRegistry;
  /** Tracks a passthrough slash command awaiting CLI response. */
  pendingPassthrough: { command: string; requestId?: string } | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function makeDefaultState(sessionId: string): SessionState {
  return {
    session_id: sessionId,
    model: "",
    cwd: "",
    tools: [],
    permissionMode: "default",
    claude_code_version: "",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

/** Extract a plain presence entry from a ConsumerIdentity (defensive copy). */
export function toPresenceEntry(id: ConsumerIdentity): {
  userId: string;
  displayName: string;
  role: ConsumerRole;
} {
  return { userId: id.userId, displayName: id.displayName, role: id.role };
}

// ─── SessionStore ────────────────────────────────────────────────────────────

export interface SessionStoreFactories {
  createCorrelationBuffer: () => TeamToolCorrelationBuffer;
  createRegistry: () => SlashCommandRegistry;
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private storage: SessionStorage | null;
  private factories: SessionStoreFactories;

  constructor(storage: SessionStorage | null, factories: SessionStoreFactories) {
    this.storage = storage;
    this.factories = factories;
  }

  getStorage(): SessionStorage | null {
    return this.storage;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getOrCreate(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = this.createSession(id, makeDefaultState(id));
      this.sessions.set(id, session);
    }
    return session;
  }

  getSnapshot(id: string): SessionSnapshot | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    return {
      id: session.id,
      state: session.state,
      cliConnected: session.cliSocket !== null || session.backendSession !== null,
      consumerCount: session.consumerSockets.size,
      consumers: Array.from(session.consumerSockets.values()).map(toPresenceEntry),
      pendingPermissions: Array.from(session.pendingPermissions.values()),
      messageHistoryLength: session.messageHistory.length,
      lastActivity: session.lastActivity,
    };
  }

  getAllStates(): SessionState[] {
    return Array.from(this.sessions.values()).map((s) => s.state);
  }

  isCliConnected(id: string): boolean {
    const session = this.sessions.get(id);
    return !!(session?.cliSocket || session?.backendSession);
  }

  /** Remove a session from the map and storage (does NOT close sockets). */
  remove(id: string): void {
    this.sessions.delete(id);
    this.storage?.remove(id);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  keys(): IterableIterator<string> {
    return this.sessions.keys();
  }

  /** Create a new disconnected session with the given state. */
  private createSession(
    id: string,
    state: SessionState,
    overrides?: {
      pendingPermissions?: Map<string, PermissionRequest>;
      messageHistory?: ConsumerMessage[];
      pendingMessages?: string[];
    },
  ): Session {
    return {
      id,
      cliSocket: null,
      backendSession: null,
      backendAbort: null,
      consumerSockets: new Map(),
      consumerRateLimiters: new Map(),
      anonymousCounter: 0,
      state,
      pendingPermissions: overrides?.pendingPermissions ?? new Map(),
      messageHistory: overrides?.messageHistory ?? [],
      pendingMessages: overrides?.pendingMessages ?? [],
      queuedMessage: null,
      lastStatus: null,
      lastActivity: Date.now(),
      pendingInitialize: null,
      teamCorrelationBuffer: this.factories.createCorrelationBuffer(),
      registry: this.factories.createRegistry(),
      pendingPassthrough: null,
    };
  }

  /** Persist a session to disk. */
  persist(session: Session): void {
    if (!this.storage) return;
    this.storage.save({
      id: session.id,
      state: session.state,
      messageHistory: session.messageHistory,
      pendingMessages: session.pendingMessages,
      pendingPermissions: Array.from(session.pendingPermissions.entries()),
    });
  }

  /** Restore sessions from disk (call once at startup). Returns count restored. */
  restoreAll(): number {
    if (!this.storage) return 0;
    const persisted = this.storage.loadAll();
    let count = 0;
    for (const p of persisted) {
      if (this.sessions.has(p.id)) continue; // don't overwrite live sessions

      const session = this.createSession(p.id, p.state, {
        pendingPermissions: new Map(p.pendingPermissions || []),
        messageHistory: p.messageHistory || [],
        pendingMessages: p.pendingMessages || [],
      });

      // Populate registry from persisted state so slash commands work
      // before the CLI reconnects and sends a fresh system.init
      if (p.state.slash_commands?.length > 0) {
        session.registry.registerFromCLI(
          p.state.slash_commands.map((name: string) => ({ name, description: "" })),
        );
      }
      if (p.state.skills?.length > 0) {
        session.registry.registerSkills(p.state.skills);
      }
      this.sessions.set(p.id, session);
      count++;
    }
    return count;
  }
}
