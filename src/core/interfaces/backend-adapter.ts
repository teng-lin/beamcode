/**
 * BackendAdapter — the contract every coding-agent backend must implement.
 *
 * Adapters translate between BeamCode's UnifiedMessage envelope and a
 * specific CLI protocol (SdkUrl / NDJSON, ACP, Codex, etc.).
 */

import type { UnifiedMessage } from "../types/unified-message.js";

// ---------------------------------------------------------------------------
// AdapterSlashExecutor
// ---------------------------------------------------------------------------

/** Duck-typed interface for adapter-specific slash command executors. */
export interface AdapterSlashExecutor {
  handles(command: string): boolean;
  execute(
    command: string,
  ): Promise<{ content: string; source: "emulated"; durationMs: number } | null>;
  supportedCommands(): string[];
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Declares what a backend adapter supports. */
export interface BackendCapabilities {
  /** Whether the backend streams partial responses (SdkUrl: true, ACP: false). */
  streaming: boolean;
  /** Whether the backend handles permission requests natively. */
  permissions: boolean;
  /** Whether the backend supports slash commands. */
  slashCommands: boolean;
  /** Where the backend can run. */
  availability: "local" | "remote" | "both";
  /** Whether the backend supports agent team coordination. */
  teams: boolean;
}

// ---------------------------------------------------------------------------
// ConnectOptions
// ---------------------------------------------------------------------------

/** Adapter-agnostic options for establishing a session. */
export interface ConnectOptions {
  /** Target session ID to connect to (or create). */
  sessionId: string;
  /** If true, attempt to resume an existing session. */
  resume?: boolean;
  /** Adapter-specific options — each adapter defines its own shape. */
  adapterOptions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// BackendSession
// ---------------------------------------------------------------------------

/** A live connection to a single backend session. */
export interface BackendSession {
  /** The session identifier. */
  readonly sessionId: string;
  /** Send a message to the backend. */
  send(message: UnifiedMessage): void;
  /** Send a raw NDJSON string to the backend (bypass UnifiedMessage translation). */
  sendRaw(ndjson: string): void;
  /** Incoming messages from the backend as an async iterable. */
  readonly messages: AsyncIterable<UnifiedMessage>;
  /** Gracefully close the session. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// BackendAdapter
// ---------------------------------------------------------------------------

/** A backend adapter that can create sessions. */
export interface BackendAdapter {
  /** Human-readable adapter identifier (e.g. "sdk-url", "acp", "codex"). */
  readonly name: string;
  /** What this adapter supports. */
  readonly capabilities: BackendCapabilities;
  /** Open a new session (or resume an existing one). */
  connect(options: ConnectOptions): Promise<BackendSession>;
  /** Optionally create an adapter-specific slash command executor for a session. */
  createSlashExecutor?(session: BackendSession): AdapterSlashExecutor | null;
}
