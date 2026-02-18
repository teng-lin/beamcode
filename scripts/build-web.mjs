import { spawnSync } from "node:child_process";

const result = spawnSync("pnpm", ["--dir", "web", "run", "build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
