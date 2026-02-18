import { execSync } from "node:child_process";

const mode = process.argv.includes("--mode")
  ? process.argv[process.argv.indexOf("--mode") + 1]
  : "smoke";

function fail(message) {
  console.error(`[e2e-realcli-preflight] ${message}`);
  process.exit(1);
}

function checkClaudeBinary() {
  try {
    execSync("claude --version", {
      stdio: "pipe",
      timeout: 5000,
      encoding: "utf-8",
    });
    return true;
  } catch {
    return false;
  }
}

if (!checkClaudeBinary()) {
  fail("Claude CLI is not available in PATH (expected `claude --version` to succeed).");
}

if (!process.env.ANTHROPIC_API_KEY) {
  fail("ANTHROPIC_API_KEY is not set.");
}

if (!["smoke", "full"].includes(mode)) {
  fail(`Unsupported mode '${mode}'. Use --mode smoke or --mode full.`);
}

console.log(`[e2e-realcli-preflight] OK (mode=${mode})`);
