/**
 * CodexAdapter compliance test — runs the BackendAdapter compliance suite
 * against a thin wrapper that constructs CodexSessions directly with
 * MockWebSocket, bypassing the launch+connect+handshake flow.
 *
 * Uses the same MockWebSocket pattern from codex-adapter.test.ts.
 * The mock WebSocket echoes turn.create requests as text delta notifications.
 */

import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type WebSocket from "ws";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";
import { runBackendAdapterComplianceTests } from "../../core/interfaces/backend-adapter-compliance.js";
import type { ProcessHandle, ProcessManager } from "../../interfaces/process-manager.js";
import { CodexLauncher } from "./codex-launcher.js";
import { CodexSession } from "./codex-session.js";

// ---------------------------------------------------------------------------
// Mock WebSocket (mirrored from codex-adapter.test.ts)
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);

    // Echo turn.create requests as text delta notifications
    try {
      const parsed = JSON.parse(data);
      if (parsed.method === "turn.create") {
        setTimeout(() => {
          this.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "response.output_text.delta",
                params: { delta: "echo", output_index: 0 },
              }),
            ),
          );
        }, 0);
      }
    } catch {
      // ignore
    }
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.emit("close");
  }
}

// ---------------------------------------------------------------------------
// Mock ProcessManager
// ---------------------------------------------------------------------------

function createMockProcessManager(): ProcessManager {
  const exitPromise = new Promise<number | null>(() => {});
  return {
    spawn: vi.fn().mockReturnValue({
      pid: 12345,
      exited: exitPromise,
      kill: vi.fn(),
      stdout: null,
      stderr: null,
    } satisfies ProcessHandle),
    isAlive: vi.fn().mockReturnValue(true),
  };
}

// ---------------------------------------------------------------------------
// Compliance wrapper adapter — constructs CodexSessions directly
// ---------------------------------------------------------------------------

class ComplianceCodexAdapter implements BackendAdapter {
  readonly name = "codex";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: false,
  };

  async connect(options: ConnectOptions): Promise<BackendSession> {
    const ws = new MockWebSocket();
    const launcher = new CodexLauncher({
      processManager: createMockProcessManager(),
    });

    return new CodexSession({
      sessionId: options.sessionId,
      ws: ws as unknown as WebSocket,
      launcher,
    });
  }
}

runBackendAdapterComplianceTests("CodexAdapter", () => new ComplianceCodexAdapter());
