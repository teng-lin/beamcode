import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.e2e.test.ts"],
    exclude: ["src/e2e/realcli/**/*.e2e.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 15_000,
    maxWorkers: 2,
  },
});
