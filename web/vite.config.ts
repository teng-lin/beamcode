import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [tailwindcss(), react(), viteSingleFile()],
  server: {
    port: 5174,
    proxy: {
      "/ws": { target: "ws://localhost:3456", ws: true },
      "/api": { target: "http://localhost:3456" },
    },
  },
  build: {
    target: "es2022",
    minify: "esbuild",
  },
});
