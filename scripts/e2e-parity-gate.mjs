#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));

const REQUIRED_SCRIPTS = [
  "test:e2e:deterministic",
  "test:e2e:realcli:smoke:process",
  "test:e2e:real:claude:smoke",
];

const REQUIRED_TEST_FILES = [
  "src/e2e/session-lifecycle.e2e.test.ts",
  "src/e2e/session-status.e2e.test.ts",
  "src/e2e/presence-rbac.e2e.test.ts",
  "src/e2e/slash-commands.e2e.test.ts",
  "src/e2e/consumer-edge-cases.e2e.test.ts",
  "src/e2e/codex-adapter.e2e.test.ts",
  "src/e2e/gemini-adapter.e2e.test.ts",
  "src/e2e/acp-adapter.e2e.test.ts",
  "src/e2e/opencode-adapter.e2e.test.ts",
  "src/e2e/real/smoke.e2e.test.ts",
  "src/e2e/real/handshake.e2e.test.ts",
];

const REQUIRED_DOCS = [
  "docs/refactor-plan/e2e-parity-matrix.md",
  "docs/refactor-plan/rollback-runbook.md",
];

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function fileExists(path) {
  try {
    readFileSync(resolve(root, path), "utf8");
    return true;
  } catch {
    return false;
  }
}

function verifyRequiredScripts(pkg) {
  const missing = REQUIRED_SCRIPTS.filter((name) => !pkg.scripts?.[name]);
  return { ok: missing.length === 0, missing };
}

function verifyRequiredFiles(paths) {
  const missing = paths.filter((path) => !fileExists(path));
  return { ok: missing.length === 0, missing };
}

function printResult(label, result) {
  if (result.ok) {
    console.log(`[parity-gate] ${label}: OK`);
    return;
  }
  console.error(`[parity-gate] ${label}: missing`);
  for (const item of result.missing) {
    console.error(`  - ${item}`);
  }
}

function main() {
  const pkg = readJson("package.json");

  const scriptResult = verifyRequiredScripts(pkg);
  const testFileResult = verifyRequiredFiles(REQUIRED_TEST_FILES);
  const docsResult = verifyRequiredFiles(REQUIRED_DOCS);

  printResult("scripts", scriptResult);
  printResult("test files", testFileResult);
  printResult("docs", docsResult);

  const ok = scriptResult.ok && testFileResult.ok && docsResult.ok;
  if (!ok) {
    process.exitCode = 1;
    return;
  }

  console.log("[parity-gate] E2E parity matrix prerequisites are configured.");
}

main();
