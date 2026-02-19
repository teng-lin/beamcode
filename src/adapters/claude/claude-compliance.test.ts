/**
 * ClaudeAdapter compliance — runs the BackendAdapter compliance suite.
 *
 * Uses a wrapper adapter that immediately delivers a mock WebSocket
 * after connect(), enabling the compliance harness's synchronous
 * send/receive expectations to work.
 */

import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";
import { runBackendAdapterComplianceTests } from "../../core/interfaces/backend-adapter-compliance.js";
import { ClaudeSession } from "./claude-session.js";
import { SocketRegistry } from "./socket-registry.js";

// ---------------------------------------------------------------------------
// Mock WebSocket that auto-echoes user messages as system init responses
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  readyState = MockWebSocket.OPEN;

  send(data: string): void {
    // Auto-echo: when a user message arrives, respond with a system init message
    // that the message-translator can translate into a UnifiedMessage
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === "user") {
        setTimeout(() => {
          if (this.readyState !== MockWebSocket.OPEN) return;
          this.emit(
            "message",
            JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: "compliance",
              model: "test-model",
              cwd: "/tmp",
              tools: [],
              mcp_servers: [],
            }),
          );
        }, 0);
      }
    } catch {
      // ignore parse errors
    }
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.emit("close");
  }
}

// ---------------------------------------------------------------------------
// Compliance wrapper — creates ClaudeSession + delivers mock socket immediately
// ---------------------------------------------------------------------------

class ComplianceClaudeAdapter implements BackendAdapter {
  readonly name = "claude";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: true,
    availability: "local",
    teams: true,
  };

  private registry = new SocketRegistry();

  async connect(options: ConnectOptions): Promise<BackendSession> {
    const socketPromise = this.registry.register(options.sessionId);
    const session = new ClaudeSession({
      sessionId: options.sessionId,
      socketPromise,
    });

    // Immediately deliver a mock socket
    const ws = new MockWebSocket();
    this.registry.deliverSocket(options.sessionId, ws as unknown as WebSocket);

    return session;
  }
}

runBackendAdapterComplianceTests("ClaudeAdapter", () => new ComplianceClaudeAdapter());
