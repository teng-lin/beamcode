import type { BackendAdapter } from "./backend-adapter.js";
import type { CliAdapterName } from "./adapter-names.js";

export interface AdapterResolver {
  resolve(name?: CliAdapterName): BackendAdapter;
  readonly defaultName: CliAdapterName;
  readonly availableAdapters: readonly CliAdapterName[];
}
