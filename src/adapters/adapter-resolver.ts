import type { AdapterResolver } from "../core/interfaces/adapter-resolver.js";
import type { BackendAdapter } from "../core/interfaces/backend-adapter.js";
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

  // Lazy cache for all non-Claude adapters so stopAll() can reach them.
  const adapterCache = new Map<CliAdapterName, BackendAdapter>();
  adapterCache.set("claude", cachedClaude);

  return {
    resolve(name?: CliAdapterName): BackendAdapter {
      const resolved = name ?? defaultName;
      const cached = adapterCache.get(resolved);
      if (cached) return cached;

      const adapter = createAdapter(resolved, deps);
      adapterCache.set(resolved, adapter);
      return adapter;
    },

    async stopAll(): Promise<void> {
      const stops = [...adapterCache.values()]
        .filter(
          (a): a is BackendAdapter & { stop(): Promise<void> } => typeof a.stop === "function",
        )
        .map((a) => a.stop());
      await Promise.allSettled(stops);
      adapterCache.clear();
    },

    defaultName,
    availableAdapters: CLI_ADAPTER_NAMES,
  };
}
