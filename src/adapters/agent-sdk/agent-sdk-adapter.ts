/**
 * AgentSdkAdapter — BackendAdapter for the Claude Agent SDK.
 *
 * This is a forward-connection adapter (NOT an InvertedConnectionAdapter).
 * The Agent SDK runs in-process, communicating via typed async iterables
 * rather than over WebSocket.
 *
 * The adapter itself is lightweight — it holds no SDK dependencies.
 * The heavy `@anthropic-ai/claude-agent-sdk` module is loaded dynamically
 * inside `AgentSdkSession.create()` (called from `connect()`).
 */

import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";
import { AgentSdkSession } from "./agent-sdk-session.js";

export class AgentSdkAdapter implements BackendAdapter {
  readonly name = "agent-sdk" as const;

  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: true,
  };

  async connect(options: ConnectOptions): Promise<BackendSession> {
    return AgentSdkSession.create(options);
  }

  async stop(): Promise<void> {
    // No persistent resources to clean up — each session is independent.
  }
}
