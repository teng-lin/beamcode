/**
 * GeminiAdapter compliance test — runs the BackendAdapter compliance suite
 * against a thin wrapper that constructs GeminiSessions directly with
 * a mock fetch, bypassing the launch+healthcheck flow.
 *
 * The mock fetch returns SSE responses that simulate A2A server behavior:
 * - task submitted event
 * - text delta event
 * - input-required final event (turn done)
 */

import { vi } from "vitest";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter-compliance.js";
import { runBackendAdapterComplianceTests } from "../../core/interfaces/backend-adapter-compliance.js";
import type { ProcessHandle, ProcessManager } from "../../interfaces/process-manager.js";
import { GeminiLauncher } from "./gemini-launcher.js";
import { GeminiSession } from "./gemini-session.js";

// ---------------------------------------------------------------------------
// Mock SSE response factory
// ---------------------------------------------------------------------------

function createMockSSEResponse(taskId: string): string {
  const taskEvent = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "task",
      id: taskId,
      contextId: "ctx-1",
      status: { state: "submitted", timestamp: new Date().toISOString() },
    },
  });

  const textEvent = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId,
      contextId: "ctx-1",
      status: {
        state: "working",
        message: {
          kind: "message",
          role: "agent",
          parts: [{ kind: "text", text: "echo" }],
          messageId: "msg-1",
        },
      },
      metadata: { coderAgent: { kind: "text-content" } },
    },
  });

  const doneEvent = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "status-update",
      taskId,
      contextId: "ctx-1",
      status: { state: "input-required" },
      final: true,
      metadata: { coderAgent: { kind: "state-change" } },
    },
  });

  return `data: ${taskEvent}\n\ndata: ${textEvent}\n\ndata: ${doneEvent}\n\n`;
}

function createMockFetch(): typeof fetch {
  let callCount = 0;
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    callCount++;
    const taskId = `task-${callCount}`;
    const sseBody = createMockSSEResponse(taskId);
    const encoder = new TextEncoder();

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseBody));
        controller.close();
      },
    });

    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
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
// Compliance wrapper adapter
// ---------------------------------------------------------------------------

class ComplianceGeminiAdapter implements BackendAdapter {
  readonly name = "gemini";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: false,
  };

  async connect(options: ConnectOptions): Promise<BackendSession> {
    const launcher = new GeminiLauncher({
      processManager: createMockProcessManager(),
    });

    return new GeminiSession({
      sessionId: options.sessionId,
      baseUrl: "http://localhost:0",
      launcher,
      fetchFn: createMockFetch(),
    });
  }
}

runBackendAdapterComplianceTests("GeminiAdapter", () => new ComplianceGeminiAdapter());
