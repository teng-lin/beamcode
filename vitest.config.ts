import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.e2e.test.ts"],
    poolOptions: { forks: { maxForks: 4 } },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/testing.ts", "src/**/index.ts"],
      reportsDirectory: "./coverage",
    },
  },
});
