import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      testing: "src/testing.ts",
      "adapters/acp": "src/adapters/acp/index.ts",
      "adapters/codex": "src/adapters/codex/index.ts",
      "adapters/claude": "src/adapters/claude/index.ts",
      "adapters/agent-sdk": "src/adapters/agent-sdk/index.ts",
      daemon: "src/daemon/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    external: ["ws"],
  },
  {
    entry: {
      "bin/beamcode": "src/bin/beamcode.ts",
    },
    format: "esm",
    dts: false,
    clean: false,
    sourcemap: true,
    external: ["ws"],
    banner: { js: "#!/usr/bin/env node" },
  },
]);
