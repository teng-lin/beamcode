#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(abs));
      continue;
    }
    out.push(abs);
  }
  return out;
}

function readText(relPath) {
  return readFileSync(resolve(root, relPath), "utf8");
}

function exists(relPath) {
  try {
    statSync(resolve(root, relPath));
    return true;
  } catch {
    return false;
  }
}

function toRel(absPath) {
  return relative(root, absPath).replaceAll("\\", "/");
}

function extractImports(source) {
  const specs = [];
  const re = /from\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(source))) {
    specs.push(m[1]);
  }
  return specs;
}

function extractEmitEvents(source) {
  const events = [];
  const re = /\bemit(?:Event)?\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(source))) {
    events.push(m[1]);
  }
  return events;
}

function loadWaivers() {
  const relPath = "docs/refactor-plan/architecture-waivers.json";
  if (!exists(relPath)) return [];
  try {
    const payload = JSON.parse(readText(relPath));
    return Array.isArray(payload.waivers) ? payload.waivers : [];
  } catch (err) {
    throw new Error(
      `Invalid waiver file at ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function waiverActive(waiver, nowDate) {
  if (!waiver.expires_on) return true;
  const expires = new Date(waiver.expires_on);
  if (Number.isNaN(expires.getTime())) return false;
  return expires >= nowDate;
}

function isWaived(waivers, violation, nowDate) {
  return waivers.some((w) => {
    if (w.rule !== violation.rule) return false;
    if (w.file !== violation.file) return false;
    if (!waiverActive(w, nowDate)) return false;
    if (!w.pattern) return true;
    return violation.evidence.includes(String(w.pattern));
  });
}

function checkForbiddenImports(ruleId, files, forbidden) {
  const violations = [];
  for (const file of files) {
    if (!exists(file)) continue;
    const src = readText(file);
    for (const spec of extractImports(src)) {
      for (const deny of forbidden) {
        if (!spec.includes(deny)) continue;
        violations.push({
          rule: ruleId,
          file,
          evidence: `import:${spec}`,
        });
      }
    }
  }
  return violations;
}

function checkForbiddenEmitNames(ruleId, files, names) {
  const violations = [];
  for (const file of files) {
    if (!exists(file)) continue;
    const src = readText(file);
    for (const eventName of extractEmitEvents(src)) {
      if (names.includes(eventName)) {
        violations.push({
          rule: ruleId,
          file,
          evidence: `emit:${eventName}`,
        });
      }
    }
  }
  return violations;
}

function checkForbiddenPattern(ruleId, files, pattern, evidence) {
  const violations = [];
  for (const file of files) {
    if (!exists(file)) continue;
    const src = readText(file);
    if (!pattern.test(src)) continue;
    violations.push({
      rule: ruleId,
      file,
      evidence,
    });
  }
  return violations;
}

function checkForbiddenFiles(ruleId, files, evidence) {
  const violations = [];
  for (const file of files) {
    if (!exists(file)) continue;
    violations.push({
      rule: ruleId,
      file,
      evidence,
    });
  }
  return violations;
}

function checkRuntimeStateMutationGuard() {
  const runtimeFile = "src/core/session-runtime.ts";
  if (!exists(runtimeFile)) {
    return [
      {
        rule: "runtime_mutation_guard",
        file: runtimeFile,
        evidence: "runtime file missing (guard disabled)",
      },
    ];
  }

  const allow = new Set([runtimeFile]);

  const files = walk(resolve(root, "src/core"))
    .map(toRel)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  const violations = [];
  for (const file of files) {
    if (allow.has(file)) continue;
    const src = readText(file);
    if (/\bsession\.state\s*=/.test(src) || /\bsession\.state\.[A-Za-z0-9_]+\s*=/.test(src)) {
      violations.push({
        rule: "runtime_mutation_guard",
        file,
        evidence: "session.state mutation outside runtime",
      });
    }
  }
  return violations;
}

function checkRuntimeOwnedFieldMutationGuard() {
  const runtimeFile = "src/core/session-runtime.ts";
  if (!exists(runtimeFile)) {
    return [
      {
        rule: "runtime_owned_field_guard",
        file: runtimeFile,
        evidence: "runtime file missing (guard disabled)",
      },
    ];
  }

  const files = walk(resolve(root, "src/core"))
    .map(toRel)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== runtimeFile);

  const forbidden = [
    /\bsession\.lastStatus\s*=(?!=)/,
    /\bsession\.adapterName\s*=(?!=)/,
    /\bsession\.backendSessionId\s*=(?!=)/,
    /\bsession\.messageHistory\s*=(?!=)/,
    /\bsession\.messageHistory\.(push|splice|shift|unshift)\s*\(/,
    /\bsession\.queuedMessage\s*=(?!=)/,
    /\bsession\.consumerSockets\.(set|delete|clear)\s*\(/,
    /\bsession\.consumerRateLimiters\.(set|delete|clear)\s*\(/,
    /\bsession\.backendSession\s*=(?!=)/,
    /\bsession\.backendAbort\s*=(?!=)/,
    /\bsession\.pendingMessages\s*=(?!=)/,
    /\bsession\.pendingInitialize\s*=(?!=)/,
    /\bsession\.pendingPermissions\.(set|delete|clear)\s*\(/,
    /\bsession\.pendingPassthroughs\.(push|pop|shift|unshift|splice)\s*\(/,
  ];

  const violations = [];
  for (const file of files) {
    const src = readText(file);
    for (const re of forbidden) {
      if (!re.test(src)) continue;
      violations.push({
        rule: "runtime_owned_field_guard",
        file,
        evidence: `forbidden-mutation:${re.toString()}`,
      });
      break;
    }
  }
  return violations;
}

function checkSlashRegistryMutationGuard() {
  const allow = new Set(["src/core/session-runtime.ts"]);

  const files = walk(resolve(root, "src/core"))
    .map(toRel)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  const patterns = [
    /\bsession\.registry\.clearDynamic\s*\(/,
    /\bsession\.registry\.registerFromCLI\s*\(/,
    /\bsession\.registry\.registerSkills\s*\(/,
  ];

  const violations = [];
  for (const file of files) {
    if (allow.has(file)) continue;
    const src = readText(file);
    for (const re of patterns) {
      if (!re.test(src)) continue;
      violations.push({
        rule: "slash_registry_mutation_guard",
        file,
        evidence: `forbidden-mutation:${re.toString()}`,
      });
      break;
    }
  }
  return violations;
}

function main() {
  const nowDate = new Date();
  const waivers = loadWaivers();

  const transportFiles = ["src/core/consumer-gateway.ts", "src/core/session-transport-hub.ts"];
  const bridgeFiles = ["src/core/session-bridge.ts"];
  const managerFiles = ["src/core/session-coordinator.ts"];
  const runtimePlaneFiles = ["src/core/session-bridge.ts", "src/core/unified-message-router.ts"];
  const coordinatorEntryFiles = [
    "src/bin/beamcode.ts",
    "src/http/server.ts",
    "src/http/api-sessions.ts",
  ];
  const coreNonTestFilesExcludingRepository = walk(resolve(root, "src/core"))
    .map(toRel)
    .filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        f !== "src/core/session-repository.ts",
    );
  const coreNonTestFiles = walk(resolve(root, "src/core"))
    .map(toRel)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const srcNonTestFiles = walk(resolve(root, "src"))
    .map(toRel)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const srcTestFiles = walk(resolve(root, "src"))
    .map(toRel)
    .filter((f) => f.endsWith(".test.ts") || f.endsWith(".e2e.test.ts"));
  const e2eNonTestFiles = walk(resolve(root, "src/e2e"))
    .map(toRel)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const e2eRealTestFiles = walk(resolve(root, "src/e2e/real"))
    .map(toRel)
    .filter((f) => f.endsWith(".e2e.test.ts"));
  const e2eTestFiles = walk(resolve(root, "src/e2e"))
    .map(toRel)
    .filter((f) => f.endsWith(".e2e.test.ts"));
  const e2eRealFiles = walk(resolve(root, "src/e2e/real"))
    .map(toRel)
    .filter((f) => f.endsWith(".ts"));

  const policyFiles = [
    "src/core/reconnect-policy.ts",
    "src/core/idle-policy.ts",
    "src/core/capabilities-policy.ts",
  ];

  const checks = [
    ...checkForbiddenFiles(
      "legacy_shim_files_absent",
      [
        "src/core/backend-lifecycle-manager.ts",
        "src/core/consumer-transport-coordinator.ts",
        "src/core/capabilities-protocol.ts",
        "src/core/reconnect-controller.ts",
        "src/core/idle-session-reaper.ts",
        "src/core/session-store.ts",
        "src/core/session-manager.ts",
        "src/core/interfaces/session-manager-coordination.ts",
        "src/e2e/real/session-manager-setup.ts",
      ],
      "legacy shim file reintroduced; use canonical coordinator-era modules",
    ),
    ...checkForbiddenImports("transport_no_backend_import", transportFiles, [
      "backend-lifecycle-manager",
      "backend-connector",
    ]),
    ...checkForbiddenImports("bridge_no_legacy_transport_import", bridgeFiles, [
      "consumer-transport-coordinator",
      "backend-lifecycle-manager",
    ]),
    ...checkForbiddenImports("bridge_no_session_store_import", bridgeFiles, ["session-store"]),
    ...checkForbiddenImports(
      "core_no_direct_session_store_import",
      coreNonTestFilesExcludingRepository,
      ["session-store"],
    ),
    ...checkForbiddenImports(
      "src_no_legacy_session_store_import",
      srcNonTestFiles,
      ["session-store"],
    ),
    ...checkForbiddenImports("src_no_legacy_core_shim_import", srcNonTestFiles, [
      "backend-lifecycle-manager",
      "consumer-transport-coordinator",
      "reconnect-controller",
      "idle-session-reaper",
      "capabilities-protocol",
      "session-store",
    ]),
    ...checkForbiddenPattern(
      "src_no_session_manager_import",
      srcNonTestFiles,
      /from\s+["'][^"']*session-manager\.js["']/,
      "session-manager import is not allowed; use session-coordinator",
    ),
    ...checkForbiddenPattern(
      "src_tests_no_session_manager_import",
      srcTestFiles,
      /from\s+["'][^"']*session-manager\.js["']/,
      "session-manager import is not allowed in tests; use session-coordinator",
    ),
    ...checkForbiddenPattern(
      "src_no_legacy_session_manager_option_usage",
      srcNonTestFiles,
      /\bsessionManager\s*:/,
      "prefer sessionCoordinator option/property name",
    ),
    ...checkForbiddenPattern(
      "e2e_no_manager_setup_import",
      e2eNonTestFiles,
      /from\s+["'][^"']*session-manager-setup\.js["']/,
      "session-manager-setup import is not allowed; use session-coordinator-setup",
    ),
    ...checkForbiddenPattern(
      "e2e_no_test_session_manager_alias_symbols",
      e2eTestFiles,
      /\b(TestSessionManager|setupTestSessionManager|cleanupSessionManager)\b/,
      "prefer TestSessionCoordinator helper names",
    ),
    ...checkForbiddenImports("e2e_no_session_manager_import", e2eTestFiles, ["core/session-manager"]),
    ...checkForbiddenImports("e2e_real_no_session_manager_import", e2eRealTestFiles, [
      "core/session-manager",
    ]),
    ...checkForbiddenImports("e2e_real_no_manager_setup_import", e2eRealTestFiles, [
      "session-manager-setup",
    ]),
    ...checkForbiddenPattern(
      "e2e_real_no_manager_filename_refs",
      ["package.json", ...e2eRealTestFiles],
      /session-manager-(claude|codex|gemini|opencode)\.e2e\.test\.ts/,
      "prefer session-coordinator-*.e2e.test.ts filenames",
    ),
    ...checkForbiddenPattern(
      "e2e_real_no_active_managers_symbol",
      e2eRealTestFiles,
      /\bactiveManagers\b/,
      "prefer activeCoordinators naming in real e2e tests",
    ),
    ...checkForbiddenPattern(
      "e2e_real_no_session_manager_symbol",
      e2eRealTestFiles,
      /\bSessionManager\b/,
      "prefer SessionCoordinator naming in real e2e tests",
    ),
    ...checkForbiddenPattern(
      "e2e_real_no_legacy_manager_alias_symbols",
      e2eRealFiles,
      /\b(activeManagers|waitForManagerEvent|SessionManagerEventPayload)\b/,
      "remove legacy manager aliases in real e2e support files",
    ),
    ...checkForbiddenPattern(
      "e2e_real_context_no_manager_alias",
      ["src/e2e/real/session-coordinator-setup.ts"],
      /\bmanager\s*:\s*SessionCoordinator\b/,
      "RealSessionContext should expose coordinator only",
    ),
    ...checkForbiddenImports("manager_no_legacy_policy_import", managerFiles, [
      "reconnect-controller",
      "idle-session-reaper",
      "capabilities-protocol",
    ]),
    ...checkForbiddenImports("runtime_no_capabilities_protocol_import", runtimePlaneFiles, [
      "capabilities-protocol",
    ]),
    ...checkForbiddenImports("entrypoints_no_session_manager_import", coordinatorEntryFiles, [
      "session-manager",
    ]),
    ...checkForbiddenImports(
      "core_no_manager_coordination_import",
      coreNonTestFiles,
      ["session-manager-coordination"],
    ),
    ...checkForbiddenImports("hub_no_inverted_adapter_logic_import", ["src/core/session-transport-hub.ts"], [
      "interfaces/adapter-names",
      "interfaces/inverted-connection-adapter",
    ]),
    ...checkForbiddenImports("policy_no_transport_import", policyFiles, [
      "consumer-transport-coordinator",
      "session-transport-hub",
      "consumer-gateway",
    ]),
    ...checkForbiddenImports("policy_no_backend_import", policyFiles, [
      "backend-lifecycle-manager",
      "backend-connector",
    ]),
    ...checkForbiddenEmitNames("transport_no_backend_event_emit", transportFiles, [
      "backend:connected",
      "backend:disconnected",
      "backend:message",
    ]),
    ...checkRuntimeStateMutationGuard(),
    ...checkRuntimeOwnedFieldMutationGuard(),
    ...checkSlashRegistryMutationGuard(),
    ...checkForbiddenPattern(
      "bridge_no_store_cli_connected",
      ["src/core/session-bridge.ts"],
      /\bthis\.store\.isCliConnected\s*\(/,
      "SessionBridge should derive cliConnected from SessionRuntime, not SessionStore",
    ),
  ];

  const activeViolations = [];
  const waivedViolations = [];
  for (const v of checks) {
    if (isWaived(waivers, v, nowDate)) {
      waivedViolations.push(v);
    } else {
      activeViolations.push(v);
    }
  }

  if (waivedViolations.length > 0) {
    console.log(`[arch-check] waivers applied: ${waivedViolations.length}`);
  }

  if (activeViolations.length === 0) {
    console.log("[arch-check] OK");
    return;
  }

  console.error(`[arch-check] violations: ${activeViolations.length}`);
  for (const violation of activeViolations) {
    console.error(`- [${violation.rule}] ${violation.file} :: ${violation.evidence}`);
  }
  process.exitCode = 1;
}

main();
