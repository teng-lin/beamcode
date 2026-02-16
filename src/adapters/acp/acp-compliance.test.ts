/**
 * AcpAdapter compliance test — runs the BackendAdapter compliance suite
 * against AcpAdapter with mock subprocess infrastructure.
 *
 * Uses the same mock patterns as acp-adapter.test.ts: createMockChild,
 * autoRespond, and mock SpawnFn. The auto-responder handles:
 * - initialize handshake
 * - session/new and session/load (with dynamic sessionId)
 * - session/prompt echo (responds with session/update notification)
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import { runBackendAdapterComplianceTests } from "../../core/interfaces/backend-adapter-compliance.js";
import type { SpawnFn } from "./acp-adapter.js";
import { AcpAdapter } from "./acp-adapter.js";

// ---------------------------------------------------------------------------
// Mock subprocess helpers (mirrored from acp-adapter.test.ts)
// ---------------------------------------------------------------------------

class MockStream extends EventEmitter {
  readonly chunks: string[] = [];

  write(data: string): boolean {
    this.chunks.push(data);
    return true;
  }
}

function createMockChild() {
  const stdin = new MockStream();
  const stdout = new MockStream();
  const stderr = new MockStream();
  const child = new EventEmitter() as ChildProcess;

  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    killed: false,
    kill: vi.fn((_signal?: string) => {
      (child as unknown as { killed: boolean }).killed = true;
      child.emit("exit", 0, null);
      return true;
    }),
  });

  return { child, stdin, stdout, stderr };
}

function respondToRequest(stdout: MockStream, id: number, result: unknown) {
  const response = `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
  stdout.emit("data", Buffer.from(response));
}

function sendNotification(stdout: MockStream, method: string, params: unknown) {
  const notification = `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
  stdout.emit("data", Buffer.from(notification));
}

/**
 * Auto-responder for compliance: watches stdin for JSON-RPC requests and
 * responds to initialize, session/new, session/load, and session/prompt.
 */
function autoRespondCompliance(stdin: MockStream, stdout: MockStream): void {
  const origWrite = stdin.write.bind(stdin);
  stdin.write = (data: string): boolean => {
    origWrite(data);
    try {
      const parsed = JSON.parse(data.trim());
      if (parsed.method === "initialize") {
        setTimeout(
          () =>
            respondToRequest(stdout, parsed.id, {
              protocolVersion: 1,
              agentCapabilities: { streaming: true },
              agentInfo: { name: "compliance-agent", version: "1.0" },
            }),
          0,
        );
      } else if (parsed.method === "session/new" || parsed.method === "session/load") {
        const sessionId = parsed.params?.sessionId ?? "unknown";
        setTimeout(() => respondToRequest(stdout, parsed.id, { sessionId }), 0);
      } else if (parsed.method === "session/prompt") {
        setTimeout(
          () =>
            sendNotification(stdout, "session/update", {
              sessionId: "compliance",
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "echo" },
            }),
          0,
        );
      }
    } catch {
      // ignore non-JSON
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// Compliance factory — creates a fresh AcpAdapter per test group
// with a mock SpawnFn that auto-responds to handshake and echoes prompts.
// ---------------------------------------------------------------------------

function createComplianceAcpAdapter() {
  const spawnFn: SpawnFn = ((_command: string, _args: string[]) => {
    const { child, stdin, stdout } = createMockChild();
    autoRespondCompliance(stdin, stdout);
    return child;
  }) as unknown as SpawnFn;

  return new AcpAdapter(spawnFn);
}

runBackendAdapterComplianceTests("AcpAdapter", createComplianceAcpAdapter);
