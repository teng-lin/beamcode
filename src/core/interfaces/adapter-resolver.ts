import type { CliAdapterName } from "./adapter-names.js";
import type { BackendAdapter } from "./backend-adapter.js";

export interface AdapterResolver {
  resolve(name?: CliAdapterName): BackendAdapter;
  readonly defaultName: CliAdapterName;
  readonly availableAdapters: readonly CliAdapterName[];
  /** Tear down all cached adapters (kills child processes, aborts connections). */
  stopAll?(): Promise<void>;
}
