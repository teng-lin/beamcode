/**
 * ClaudeAdapter — BackendAdapter for the Claude (NDJSON over WebSocket) protocol.
 *
 * Uses an inverted connection pattern: connect() registers a pending socket,
 * and deliverSocket() is called later when the CLI connects back to our WS server.
 */

import type WebSocket from "ws";
import type {
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";
import type { InvertedConnectionAdapter } from "../../core/interfaces/inverted-connection-adapter.js";
import { ClaudeSession } from "./claude-session.js";
import { SocketRegistry } from "./socket-registry.js";

export class ClaudeAdapter implements InvertedConnectionAdapter {
  readonly name = "claude" as const;

  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: true,
    availability: "local",
    teams: true,
  };

  private readonly registry = new SocketRegistry();

  async connect(options: ConnectOptions): Promise<BackendSession> {
    const timeoutMs = (options.adapterOptions?.socketTimeoutMs as number | undefined) ?? 30_000;

    const socketPromise = this.registry.register(options.sessionId, timeoutMs);
    return new ClaudeSession({ sessionId: options.sessionId, socketPromise });
  }

  deliverSocket(sessionId: string, ws: WebSocket): boolean {
    return this.registry.deliverSocket(sessionId, ws);
  }

  cancelPending(sessionId: string): void {
    this.registry.cancel(sessionId);
  }
}
