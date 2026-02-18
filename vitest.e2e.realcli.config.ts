import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/e2e/realcli/**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    maxWorkers: 1,
  },
});
