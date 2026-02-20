/**
 * GeminiAdapter — BackendAdapter for Gemini CLI's ACP (stdio) mode.
 *
 * Delegates to AcpAdapter, spawning `gemini --experimental-acp` as the
 * subprocess. All protocol handling is reused from the ACP infrastructure.
 */

import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";
import { AcpAdapter, type SpawnFn } from "../acp/acp-adapter.js";
import { classifyGeminiError } from "./gemini-error-classifier.js";

export interface GeminiAdapterOptions {
  geminiBinary?: string;
  spawnFn?: SpawnFn;
}

export class GeminiAdapter implements BackendAdapter {
  readonly name = "gemini" as const;

  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: true,
    availability: "local",
    teams: false,
  };

  private readonly geminiBinary?: string;
  private readonly spawnFn?: SpawnFn;

  constructor(options?: GeminiAdapterOptions) {
    this.geminiBinary = options?.geminiBinary;
    this.spawnFn = options?.spawnFn;
  }

  async connect(options: ConnectOptions): Promise<BackendSession> {
    const adapterOptions = (options.adapterOptions ?? {}) as {
      cwd?: string;
      geminiBinary?: string;
    };

    const binary = adapterOptions.geminiBinary ?? this.geminiBinary ?? "gemini";

    const acp = new AcpAdapter(this.spawnFn, classifyGeminiError);
    return acp.connect({
      ...options,
      adapterOptions: {
        ...options.adapterOptions,
        command: binary,
        args: ["--experimental-acp", "--approval-mode", "default"],
        cwd: adapterOptions.cwd,
      },
    });
  }
}
