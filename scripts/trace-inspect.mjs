#!/usr/bin/env node

import { readFileSync } from "node:fs";

function usage() {
  console.error(
    "Usage: node scripts/trace-inspect.mjs <failed-context|dropped-backend-types|empty-results-by-version> [trace.ndjson]",
  );
  process.exit(1);
}

function readInput(pathArg) {
  if (pathArg) return readFileSync(pathArg, "utf8");
  return readFileSync(0, "utf8");
}

function parseNdjson(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore malformed lines so the inspector can keep scanning.
    }
  }
  return events;
}

function printFailedContext(events) {
  const failures = events.filter(
    (e) =>
      (e.messageType === "slash_decision_summary" &&
        e.command === "/context" &&
        e.outcome &&
        e.outcome !== "success") ||
      (e.messageType === "slash_command_error" && e.command === "/context"),
  );

  if (failures.length === 0) {
    console.log("No failed /context attempts found.");
    return;
  }

  for (const e of failures) {
    const reason =
      e.messageType === "slash_decision_summary"
        ? Array.isArray(e.body?.drop_or_consume_reasons)
          ? e.body.drop_or_consume_reasons.join(", ")
          : "-"
        : e.error || "-";
    console.log(
      [
        e.ts || "-",
        `session=${e.sessionId || "-"}`,
        `request=${e.requestId || "-"}`,
        `outcome=${e.outcome || "-"}`,
        `reason=${reason}`,
      ].join(" "),
    );
  }
}

function printDroppedBackendTypes(events) {
  const counts = new Map();
  for (const e of events) {
    if (e.layer !== "backend") continue;
    const dropped = e.action === "dropped" || e.outcome === "unmapped_type" || e.outcome === "parse_error";
    if (!dropped) continue;
    const key = `${e.messageType || "unknown"}|${e.outcome || "unknown"}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  if (counts.size === 0) {
    console.log("No dropped backend types found.");
    return;
  }

  for (const [key, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const [messageType, outcome] = key.split("|");
    console.log(`${count}\t${messageType}\t${outcome}`);
  }
}

function printEmptyResultsByVersion(events) {
  const sessionVersion = new Map();
  for (const e of events) {
    if (e.messageType !== "session_init") continue;
    const version =
      e.body?.session?.claude_code_version ||
      e.body?.session?.agentVersion ||
      e.body?.version ||
      "unknown";
    if (e.sessionId) sessionVersion.set(e.sessionId, version);
  }

  const counts = new Map();
  for (const e of events) {
    if (e.messageType !== "slash_decision_summary") continue;
    if (e.outcome !== "empty_result") continue;
    const version = (e.sessionId && sessionVersion.get(e.sessionId)) || "unknown";
    counts.set(version, (counts.get(version) || 0) + 1);
  }

  if (counts.size === 0) {
    console.log("No empty slash results found.");
    return;
  }

  for (const [version, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${count}\t${version}`);
  }
}

const mode = process.argv[2];
if (!mode) usage();

const text = readInput(process.argv[3]);
const events = parseNdjson(text);

switch (mode) {
  case "failed-context":
    printFailedContext(events);
    break;
  case "dropped-backend-types":
    printDroppedBackendTypes(events);
    break;
  case "empty-results-by-version":
    printEmptyResultsByVersion(events);
    break;
  default:
    usage();
}
