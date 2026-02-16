/**
 * AgentSdkAdapter — Phase 3
 *
 * Implements BackendAdapter for the Claude Agent SDK. Wraps a query function
 * (injected or passed via adapterOptions) into an AgentSdkSession.
 */

import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";
import type { QueryFn } from "./agent-sdk-session.js";
import { AgentSdkSession } from "./agent-sdk-session.js";

export class AgentSdkAdapter implements BackendAdapter {
  readonly name = "agent-sdk";

  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: true,
  };

  constructor(private readonly queryFn?: QueryFn) {}

  async connect(options: ConnectOptions): Promise<BackendSession> {
    const queryFn = this.queryFn ?? (options.adapterOptions?.queryFn as QueryFn);
    if (!queryFn) {
      throw new Error("queryFn is required (pass via constructor or adapterOptions)");
    }

    const queryOptions = (options.adapterOptions?.queryOptions as Record<string, unknown>) ?? {};

    return new AgentSdkSession(options.sessionId, queryFn, queryOptions);
  }
}
