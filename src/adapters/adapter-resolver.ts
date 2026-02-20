import type { BackendAdapter } from "../core/interfaces/backend-adapter.js";
import type { AdapterResolver } from "../core/interfaces/adapter-resolver.js";
import {
  CLI_ADAPTER_NAMES,
  type CliAdapterName,
  type CreateAdapterDeps,
  createAdapter,
} from "./create-adapter.js";

export type { AdapterResolver } from "../core/interfaces/adapter-resolver.js";

export function createAdapterResolver(
  deps: CreateAdapterDeps,
  defaultName: CliAdapterName = "claude",
): AdapterResolver {
  // ClaudeAdapter MUST be singleton: its SocketRegistry is the rendezvous
  // point for inverted connections (CLI -> BeamCode WebSocket callbacks).
  // Eagerly construct so the WebSocket CLI handler always has access,
  // even when the default adapter is non-inverted (e.g., Codex).
  const cachedClaude = createAdapter("claude", deps);

  return {
    resolve(name?: CliAdapterName): BackendAdapter {
      const resolved = name ?? defaultName;
      if (resolved === "claude") {
        return cachedClaude;
      }
      return createAdapter(resolved, deps);
    },
    defaultName,
    availableAdapters: CLI_ADAPTER_NAMES,
  };
}
