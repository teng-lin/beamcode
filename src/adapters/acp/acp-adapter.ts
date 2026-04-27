/**
 * AcpAdapter — BackendAdapter for ACP (Agent Client Protocol) agents over stdio.
 *
 * Wraps any ACP-compliant CLI (e.g. Goose, Gemini CLI) by spawning a subprocess
 * and communicating via newline-delimited JSON-RPC 2.0 on stdin/stdout.
 *
 * T2 (outbound): handled by AcpSession.send() → inbound-translator.ts
 * T3 (inbound):  handled by AcpSession.messages → outbound-translator.ts
 * Native protocol: JSON-RPC 2.0 over stdio (newline-delimited)
 */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";
import type { MessageTracer } from "../../core/messaging/message-tracer.js";
import { AcpSession } from "./acp-session.js";
import { JsonRpcCodec } from "./json-rpc.js";
import { killProcessGroup } from "./kill-process-group.js";
import type { AcpInitializeResult, ErrorClassifier } from "./outbound-translator.js";

const PROTOCOL_VERSION = 1;

/** Error thrown when an ACP JSON-RPC response contains an error object. Preserves code and data. */
export class AcpError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(`ACP error: ${message}`);
    this.name = "AcpError";
  }
}

/** Spawn function signature matching child_process.spawn. */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export class AcpAdapter implements BackendAdapter {
  readonly name = "acp" as const;

  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: true,
    availability: "local",
    teams: false,
  };

  private readonly spawnFn: SpawnFn;
  private readonly errorClassifier?: ErrorClassifier;

  constructor(spawnFn?: SpawnFn, errorClassifier?: ErrorClassifier) {
    this.spawnFn = spawnFn ?? spawn;
    this.errorClassifier = errorClassifier;
  }

  async connect(options: ConnectOptions): Promise<BackendSession> {
    const command = (options.adapterOptions?.command as string) ?? "goose";
    const args = (options.adapterOptions?.args as string[]) ?? [];
    const cwd = options.adapterOptions?.cwd as string | undefined;
    const tracer = options.adapterOptions?.tracer as MessageTracer | undefined;
    const initializeTimeoutMs = options.adapterOptions?.initializeTimeoutMs as number | undefined;
    const killGracePeriodMs = (options.adapterOptions?.killGracePeriodMs as number) ?? 5000;

    const child = this.spawnFn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      // Create a new process group so we can kill all descendant processes
      // (e.g. subprocesses spawned by the ACP agent that inherit the stdout
      // pipe, which would otherwise keep the pipe alive after the main
      // process exits and prevent backend-disconnected detection).
      detached: true,
    });

    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new Error("Failed to open stdio pipes for ACP subprocess");
    }

    try {
      const codec = new JsonRpcCodec();

      // Initialize handshake
      const { id: initId, raw: initReq } = codec.createRequest("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "beamcode", version: "0.1.0" },
      });

      tracer?.send("backend", "native_outbound", initReq, {
        sessionId: options.sessionId,
        phase: "handshake_send",
      });
      child.stdin.write(codec.encode(initReq));

      const { result: initResult, leftover: initLeftover } =
        await waitForResponse<AcpInitializeResult>(
          child.stdout,
          codec,
          initId,
          tracer,
          options.sessionId,
          initializeTimeoutMs,
        );

      // Create or resume session
      const sessionMethod = options.resume ? "session/load" : "session/new";
      const { id: sessionReqId, raw: sessionReq } = codec.createRequest(sessionMethod, {
        sessionId: options.sessionId,
        cwd: cwd ?? process.cwd(),
        mcpServers: (options.adapterOptions?.mcpServers as unknown[]) ?? [],
      });

      tracer?.send("backend", "native_outbound", sessionReq, {
        sessionId: options.sessionId,
        phase: "handshake_send",
      });
      child.stdin.write(codec.encode(sessionReq));

      const { result: sessionResult, leftover: sessionLeftover } = await waitForResponse<{
        sessionId: string;
      }>(
        child.stdout,
        codec,
        sessionReqId,
        tracer,
        options.sessionId,
        initializeTimeoutMs,
        initLeftover,
      );

      const sessionId = sessionResult.sessionId ?? options.sessionId;

      return new AcpSession(
        sessionId,
        child,
        codec,
        initResult,
        tracer,
        this.errorClassifier,
        sessionLeftover,
      );
    } catch (err) {
      killProcessGroup(child, "SIGTERM");
      const killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), killGracePeriodMs);
      child.once("exit", () => clearTimeout(killTimer));
      killTimer.unref();
      throw err;
    }
  }
}

/**
 * Read lines from stdout until we get a JSON-RPC response matching the given ID.
 *
 * Returns the decoded result and any raw data that arrived after the matched
 * response in the same read chunk (leftover), so the caller can replay it
 * rather than silently losing messages (e.g. a session/request_permission that
 * Gemini sends in the same chunk as the session/new response).
 *
 * @param initialBuffer - Optional pre-existing data to process before listening
 *   for new chunks (used to pass leftover from a prior waitForResponse call).
 */
async function waitForResponse<T>(
  stdout: NodeJS.ReadableStream,
  codec: JsonRpcCodec,
  expectedId: number | string,
  tracer?: MessageTracer,
  sessionId?: string,
  timeoutMs?: number,
  initialBuffer?: string,
): Promise<{ result: T; leftover: string }> {
  return new Promise<{ result: T; leftover: string }>((resolve, reject) => {
    let buffer = initialBuffer ?? "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const processBuffer = () => {
      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? "";

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;

        try {
          const msg = codec.decode(line);
          tracer?.recv("backend", "native_inbound", msg, {
            sessionId,
            phase: "handshake_recv",
          });
          if ("id" in msg && msg.id === expectedId) {
            // Collect remaining lines + incomplete buffer as leftover for the next stage
            const remaining = lines.slice(i + 1);
            const leftover = remaining.length > 0 ? `${remaining.join("\n")}\n${buffer}` : buffer;
            if ("error" in msg && msg.error) {
              const { code, message, data } = msg.error;
              const safeCode = typeof code === "number" ? code : -32603;
              settle(() => reject(new AcpError(safeCode, message, data)));
            } else {
              settle(() => resolve({ result: (msg as { result: T }).result, leftover }));
            }
            return;
          }
        } catch {
          // Skip non-JSON lines (e.g. agent logs)
        }
      }
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      processBuffer();
    };

    const onError = (err: Error) => {
      settle(() => reject(err));
    };

    const onClose = () => {
      settle(() => reject(new Error("ACP subprocess closed before responding")));
    };

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      stdout.removeListener("data", onData);
      stdout.removeListener("error", onError);
      stdout.removeListener("close", onClose);
    };

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        settle(() => reject(new Error(`ACP handshake timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
    }

    // Process any pre-existing buffer content before listening for more data
    if (buffer) {
      processBuffer();
      if (settled) return;
    }

    stdout.on("data", onData);
    stdout.on("error", onError);
    stdout.on("close", onClose);
  });
}
