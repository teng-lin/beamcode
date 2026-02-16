/**
 * SdkUrlAdapter — Phase 1a.1 skeleton
 *
 * Implements BackendAdapter for the SDK-URL (NDJSON over WebSocket) protocol
 * used by Claude Code CLI. Full wiring deferred to Phase 1b.
 */

import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";

export class SdkUrlAdapter implements BackendAdapter {
  readonly name = "sdk-url" as const;

  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: true,
    availability: "local",
    teams: true,
  };

  async connect(_options: ConnectOptions): Promise<BackendSession> {
    throw new Error("SdkUrlAdapter.connect() not yet implemented — will be wired in Phase 1b");
  }
}
