import { execSync } from "node:child_process";
import { createServer } from "node:net";

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

function hasCliAuthSession() {
  try {
    const output = execSync("claude auth status", {
      stdio: "pipe",
      timeout: 5000,
      encoding: "utf-8",
    });
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === "object" && parsed.loggedIn === true;
  } catch {
    return false;
  }
}

async function canBindLocalhost() {
  return await new Promise((resolve) => {
    const server = createServer();
    const timeout = setTimeout(() => {
      try {
        server.close(() => resolve(false));
      } catch {
        resolve(false);
      }
    }, 2000);

    server.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });

    server.listen(0, "127.0.0.1", () => {
      clearTimeout(timeout);
      server.close(() => resolve(true));
    });
  });
}

if (!checkClaudeBinary()) {
  fail("Claude CLI is not available in PATH (expected `claude --version` to succeed).");
}

if (!["smoke", "full"].includes(mode)) {
  fail(`Unsupported mode '${mode}'. Use --mode smoke or --mode full.`);
}

const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
const hasAuthSession = hasCliAuthSession();
if (!hasApiKey && !hasAuthSession) {
  console.warn(
    "[e2e-realcli-preflight] No ANTHROPIC_API_KEY and no logged-in CLI session; auth-required tests may skip or fail.",
  );
}

const localhostBindOk = await canBindLocalhost();
if (!localhostBindOk) {
  console.warn(
    "[e2e-realcli-preflight] Localhost bind (127.0.0.1) is not permitted in this environment; SessionCoordinator real-CLI socket tests will be skipped.",
  );
}

console.log(`[e2e-realcli-preflight] OK (mode=${mode})`);
