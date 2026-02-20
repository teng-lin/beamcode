import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [tailwindcss(), react(), viteSingleFile()],
  server: {
    port: 5174,
    proxy: {
      "/ws": { target: "ws://localhost:9414", ws: true },
      "/api": { target: "http://localhost:9414" },
    },
  },
  build: {
    target: "es2022",
    minify: "esbuild",
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    maxWorkers: "30%",
  },
});
