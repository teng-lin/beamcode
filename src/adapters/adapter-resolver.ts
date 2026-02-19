import type { BackendAdapter } from "../core/interfaces/backend-adapter.js";
import {
  CLI_ADAPTER_NAMES,
  type CliAdapterName,
  type CreateAdapterDeps,
  createAdapter,
} from "./create-adapter.js";
import type { SdkUrlAdapter } from "./sdk-url/sdk-url-adapter.js";

export interface AdapterResolver {
  resolve(name?: CliAdapterName): BackendAdapter;
  /** The cached SdkUrlAdapter singleton (always available after construction). */
  readonly sdkUrlAdapter: SdkUrlAdapter;
  readonly defaultName: CliAdapterName;
  readonly availableAdapters: readonly CliAdapterName[];
}

export function createAdapterResolver(
  deps: CreateAdapterDeps,
  defaultName: CliAdapterName = "sdk-url",
): AdapterResolver {
  // SdkUrlAdapter MUST be singleton: its SocketRegistry is the rendezvous
  // point for inverted connections (CLI -> BeamCode WebSocket callbacks).
  // Eagerly construct so the WebSocket CLI handler always has access,
  // even when the default adapter is non-inverted (e.g., Codex).
  const cachedSdkUrl = createAdapter("sdk-url", deps) as SdkUrlAdapter;

  return {
    resolve(name?: CliAdapterName): BackendAdapter {
      const resolved = name ?? defaultName;
      if (resolved === "sdk-url") {
        return cachedSdkUrl;
      }
      return createAdapter(resolved, deps);
    },
    get sdkUrlAdapter() {
      return cachedSdkUrl;
    },
    defaultName,
    availableAdapters: CLI_ADAPTER_NAMES,
  };
}
