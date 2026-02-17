#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync } from "node:fs";

const src = "web/dist/index.html";

if (!existsSync(src)) {
  console.error("Error: web/dist/index.html not found. Run 'pnpm build:web' first.");
  process.exit(1);
}

mkdirSync("dist/consumer", { recursive: true });
cpSync(src, "dist/consumer/index.html");
console.log("Copied web/dist/index.html → dist/consumer/index.html");
