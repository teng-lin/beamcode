#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync } from "node:fs";

mkdirSync("dist/consumer", { recursive: true });

// Prefer Vite-built consumer (single-file HTML from web/dist/)
const vitePath = "web/dist/index.html";
const legacyPath = "src/consumer/index.html";

if (existsSync(vitePath)) {
  cpSync(vitePath, "dist/consumer/index.html");
  console.log("Copied web/dist/index.html → dist/consumer/index.html");
} else if (existsSync(legacyPath)) {
  cpSync(legacyPath, "dist/consumer/index.html");
  console.log("Copied src/consumer/index.html → dist/consumer/index.html (legacy fallback)");
} else {
  console.error("Error: No consumer HTML found. Run 'pnpm build:web' first.");
  process.exit(1);
}
