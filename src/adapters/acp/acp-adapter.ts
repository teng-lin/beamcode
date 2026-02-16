/**
 * AcpAdapter — Phase 3
 *
 * Implements BackendAdapter for the ACP (Agent Client Protocol) over stdio.
 * Spawns an ACP-compliant agent subprocess, performs the initialize handshake,
 * and returns an AcpSession.
 */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";
import { AcpSession } from "./acp-session.js";
import { JsonRpcCodec } from "./json-rpc.js";
import type { AcpInitializeResult } from "./outbound-translator.js";

const PROTOCOL_VERSION = 1;

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

  constructor(spawnFn?: SpawnFn) {
    this.spawnFn = spawnFn ?? spawn;
  }

  async connect(options: ConnectOptions): Promise<BackendSession> {
    const command = (options.adapterOptions?.command as string) ?? "goose";
    const args = (options.adapterOptions?.args as string[]) ?? [];
    const cwd = options.adapterOptions?.cwd as string | undefined;

    const child = this.spawnFn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });

    const codec = new JsonRpcCodec();

    // Initialize handshake
    const { id: initId, raw: initReq } = codec.createRequest("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "beamcode", version: "0.1.0" },
    });

    child.stdin?.write(codec.encode(initReq));

    const initResult = await waitForResponse<AcpInitializeResult>(child.stdout!, codec, initId);

    // Create or resume session
    const sessionMethod = options.resume ? "session/load" : "session/new";
    const { id: sessionReqId, raw: sessionReq } = codec.createRequest(sessionMethod, {
      sessionId: options.sessionId,
    });

    child.stdin?.write(codec.encode(sessionReq));

    const sessionResult = await waitForResponse<{ sessionId: string }>(
      child.stdout!,
      codec,
      sessionReqId,
    );

    const sessionId = sessionResult.sessionId ?? options.sessionId;

    return new AcpSession(sessionId, child, codec, initResult);
  }
}

/** Read lines from stdout until we get a JSON-RPC response matching the given ID. */
async function waitForResponse<T>(
  stdout: NodeJS.ReadableStream,
  codec: JsonRpcCodec,
  expectedId: number | string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");

      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const msg = codec.decode(line);
          if ("id" in msg && msg.id === expectedId) {
            cleanup();
            if ("error" in msg && msg.error) {
              reject(new Error(`ACP error: ${msg.error.message}`));
            } else {
              resolve((msg as { result: T }).result);
            }
            return;
          }
        } catch {
          // Skip non-JSON lines (e.g. agent logs)
        }
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("ACP subprocess closed before responding"));
    };

    const cleanup = () => {
      stdout.removeListener("data", onData);
      stdout.removeListener("error", onError);
      stdout.removeListener("close", onClose);
    };

    stdout.on("data", onData);
    stdout.on("error", onError);
    stdout.on("close", onClose);
  });
}
