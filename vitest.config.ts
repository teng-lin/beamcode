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
      exclude: [
        "src/**/*.test.ts",
        "src/index.ts",
        "src/testing.ts",
        "src/**/index.ts",
        "src/testing/**",
        "src/e2e/**",
        "src/interfaces/**",
        "src/bin/**",
      ],
      reportsDirectory: "./coverage",
      thresholds: {
        lines: 90,
        branches: 83,
        functions: 90,
        statements: 90,
      },
    },
  },
});
