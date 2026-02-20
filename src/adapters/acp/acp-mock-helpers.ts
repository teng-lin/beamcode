/**
 * Shared mock subprocess helpers for ACP-based adapter tests.
 *
 * Used by acp-adapter.test.ts, acp-compliance.test.ts,
 * gemini-adapter.test.ts, and gemini-compliance.test.ts.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { vi } from "vitest";

export class MockStream extends EventEmitter {
  readonly chunks: string[] = [];

  write(data: string): boolean {
    this.chunks.push(data);
    return true;
  }
}

export interface MockChild {
  child: ChildProcess;
  stdin: MockStream;
  stdout: MockStream;
  stderr: MockStream;
}

export function createMockChild(): MockChild {
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

export function respondToRequest(stdout: MockStream, id: number, result: unknown): void {
  const response = `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
  stdout.emit("data", Buffer.from(response));
}

export function sendNotification(stdout: MockStream, method: string, params: unknown): void {
  const notification = `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
  stdout.emit("data", Buffer.from(notification));
}

export function sendRequest(stdout: MockStream, id: number, method: string, params: unknown): void {
  const request = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
  stdout.emit("data", Buffer.from(request));
}

/**
 * Auto-responder: watches stdin for JSON-RPC requests and responds to
 * initialize + session/new|session/load automatically.
 *
 * Optionally responds to session/prompt with a text echo notification
 * when `echoPrompts` is true (used by compliance tests).
 */
export function autoRespond(
  stdin: MockStream,
  stdout: MockStream,
  options?: {
    initResult?: Record<string, unknown>;
    sessionResult?: Record<string, unknown>;
    echoPrompts?: boolean;
  },
): void {
  const defaultInit = {
    protocolVersion: 1,
    agentCapabilities: { streaming: true },
    agentInfo: { name: "test-agent", version: "1.0" },
    ...options?.initResult,
  };
  const defaultSession = { sessionId: "sess-1", ...options?.sessionResult };

  const origWrite = stdin.write.bind(stdin);
  stdin.write = (data: string): boolean => {
    origWrite(data);
    try {
      const parsed = JSON.parse(data.trim());
      if (parsed.method === "initialize") {
        setTimeout(() => respondToRequest(stdout, parsed.id, defaultInit), 0);
      } else if (parsed.method === "session/new" || parsed.method === "session/load") {
        const sessionId = parsed.params?.sessionId ?? defaultSession.sessionId;
        setTimeout(() => respondToRequest(stdout, parsed.id, { sessionId }), 0);
      } else if (options?.echoPrompts && parsed.method === "session/prompt") {
        const sessionId = parsed.params?.sessionId ?? "compliance";
        setTimeout(
          () =>
            sendNotification(stdout, "session/update", {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "echo" },
              },
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
