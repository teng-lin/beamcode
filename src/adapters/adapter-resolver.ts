import type { BackendAdapter } from "../core/interfaces/backend-adapter.js";
import type { ClaudeAdapter } from "./claude/claude-adapter.js";
import {
  CLI_ADAPTER_NAMES,
  type CliAdapterName,
  type CreateAdapterDeps,
  createAdapter,
} from "./create-adapter.js";

export interface AdapterResolver {
  resolve(name?: CliAdapterName): BackendAdapter;
  /** The cached ClaudeAdapter singleton (always available after construction). */
  readonly claudeAdapter: ClaudeAdapter;
  readonly defaultName: CliAdapterName;
  readonly availableAdapters: readonly CliAdapterName[];
}

export function createAdapterResolver(
  deps: CreateAdapterDeps,
  defaultName: CliAdapterName = "claude",
): AdapterResolver {
  // ClaudeAdapter MUST be singleton: its SocketRegistry is the rendezvous
  // point for inverted connections (CLI -> BeamCode WebSocket callbacks).
  // Eagerly construct so the WebSocket CLI handler always has access,
  // even when the default adapter is non-inverted (e.g., Codex).
  const cachedClaude = createAdapter("claude", deps) as ClaudeAdapter;

  return {
    resolve(name?: CliAdapterName): BackendAdapter {
      const resolved = name ?? defaultName;
      if (resolved === "claude") {
        return cachedClaude;
      }
      return createAdapter(resolved, deps);
    },
    get claudeAdapter() {
      return cachedClaude;
    },
    defaultName,
    availableAdapters: CLI_ADAPTER_NAMES,
  };
}
