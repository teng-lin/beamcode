# Development

Architecture reference, testing, and message tracing.

## Table of Contents

- [Architecture](#architecture)
- [Building](#building)
- [Testing](#testing)
- [UnifiedMessage Protocol](#unifiedmessage-protocol)
- [Message Tracing](#message-tracing)

---

## Architecture

See [docs/architecture-diagram.md](docs/architecture-diagram.md) for the full architecture diagram, data flows, module decomposition, and package structure.

**Summary:** An HTTP+WS server routes `ConsumerMessage` / `InboundMessage` through `SessionBridge` (a `TypedEventEmitter` orchestrator decomposed into 15+ focused modules) to a `BackendAdapter` — Claude, ACP, Codex, Gemini, or OpenCode. A daemon layer manages process lifecycle; a relay layer adds Cloudflare Tunnel + E2E encryption for remote access.

---

## Building

```sh
# Install dependencies
pnpm install

# Full build (library + web consumer)
pnpm build

# Library only
pnpm build:lib

# Web consumer only (outputs to web/dist/, copied to dist/consumer/)
pnpm build:web

# Type check
pnpm typecheck

# Architecture boundary checks
pnpm check:arch

# Lint / format
pnpm lint
pnpm check:fix
```

---

## Testing

BeamCode has **three test tiers**, all powered by [Vitest](https://vitest.dev/). You almost always want to start with unit tests, confirm with mock E2E, then validate on a real backend.

### Test Tiers at a Glance

| Tier | Command | Speed | Credentials | What it validates |
|------|---------|-------|-------------|-------------------|
| **Unit** | `pnpm test` | ~1s | None | Core logic, adapters, translators, crypto, daemon |
| **E2E mock** | `pnpm test:e2e` | ~5–15s | None | Full session flow end-to-end using mock CLI processes |
| **E2E real — smoke** | `pnpm test:e2e:real:smoke` | ~30–60s | Required | Happy-path with real CLI binaries: spawn, connect, init, clean shutdown |
| **E2E real — full** | `pnpm test:e2e:real:full` | minutes | Required | Full coverage: live prompt/response, streaming, cancel, slash commands |

> Both real tiers can be scoped to a single adapter (e.g. `pnpm test:e2e:real:gemini`) or a single test name with `-t`. See [Running a Single Test](#running-a-single-test).

#### E2E mock

Mock E2E tests (`src/e2e/*.e2e.test.ts`) use `MockProcessManager` — no real CLI binary is needed. They exercise the complete session bridge, WebSocket protocol, and message routing in a controlled, repeatable way. These are the fastest feedback loop after unit tests, and the only E2E tier that runs on every PR without credentials.

```bash
pnpm test:e2e           # all mock E2E
pnpm test:e2e:mock
```

#### Real — Smoke

Smoke tests spawn the actual CLI binary (claude, gemini, codex, etc.) and verify the minimum happy path:

- Process spawns successfully
- CLI connects back to beamcode's WebSocket server
- `session_init` is received by the consumer
- Clean shutdown without errors

They don't send prompts or wait for AI responses. Duration is dominated by the CLI startup time (~10–30s).

```bash
pnpm test:e2e:real:smoke            # all adapters
pnpm test:e2e:real:claude:smoke
pnpm test:e2e:real:agent-sdk:smoke
```

#### Real — Full

Full tests build on smoke by also exercising live AI interactions — sending a user message and waiting for an assistant reply, slash commands, interrupt, session resume, etc. These are gated behind `it.runIf(runFull)` in the shared test factory. Duration varies by backend and API response time.

```bash
pnpm test:e2e:real:full             # all adapters
pnpm test:e2e:real:claude
pnpm test:e2e:real:agent-sdk
pnpm test:e2e:real:codex
pnpm test:e2e:real:gemini
pnpm test:e2e:real:opencode
```

### Running a Single Test

Isolate by file and/or name. The `-t` flag matches a substring of the test description.

```bash
# Unit / mock E2E
pnpm exec vitest run -t "parseNDJSON"
pnpm exec vitest run src/utils/ndjson.test.ts

# Real backend — single file, single test
E2E_PROFILE=real-smoke USE_REAL_CLI=true \
  pnpm exec vitest run src/e2e/real/session-coordinator-claude.e2e.test.ts \
  --config vitest.e2e.real.config.ts \
  -t "launch emits process spawn"

# Per-backend shortcut scripts also accept -t via --
pnpm test:e2e:real:gemini -- -t "user_message gets an assistant reply"
pnpm test:e2e:real:claude -- -t "broadcast assistant reply"
```

### Real Backend Prerequisites

Tests auto-skip when a prerequisite is missing (detection logic in `src/e2e/real/prereqs.ts`).

| Backend | Binary | Auth |
|---------|--------|------|
| `claude` | `claude` in PATH | `ANTHROPIC_API_KEY` or `claude auth login` |
| `agent-sdk` | `claude` in PATH | `claude auth login` (uses CLI token, no API key needed) |
| `codex` | `codex` in PATH | handled by CLI |
| `gemini` | `gemini` in PATH | `GOOGLE_API_KEY` or CLI config |
| `opencode` | `opencode` in PATH | handled by CLI config |

### Frontend Tests

```bash
cd web && pnpm test          # all component tests
cd web && pnpm test:watch
cd web && pnpm exec vitest run src/components/Composer.test.tsx
```

Libraries: `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`.

### Coverage

```bash
pnpm exec vitest run --coverage       # backend → ./coverage/
cd web && pnpm exec vitest run --coverage  # frontend → ./web/coverage/
```

### CI Lanes

| Lane | Trigger | Scope |
|------|---------|-------|
| E2E mock | Every PR | All adapters (mock CLI) |
| E2E real — smoke | PRs, Claude auth required¹ | Claude only (process + session) |
| E2E real — full | Nightly, per-adapter auth required² | All adapters |

¹ In CI, gated on the `ANTHROPIC_API_KEY` secret. Locally, OAuth (`claude auth login`) also works.

² Full nightly requires secrets for each adapter: `ANTHROPIC_API_KEY` (Claude / Agent SDK), `GOOGLE_API_KEY` (Gemini), and equivalent credentials for Codex and OpenCode. Until all secrets are configured in CI, run missing adapters manually before release.

> Until nightly CI is fully configured for all adapters, run `pnpm test:e2e:real:<adapter>` manually before releasing changes that affect a specific adapter.

### Debugging Real E2E Test Failures

Real backend tests spawn actual CLI processes and communicate over WebSockets. When a test fails, the error message alone is rarely enough.

#### Step 1: Read the automatic trace dump

Every real E2E test file runs `dumpTraceOnFailure()` in `afterEach`. When a test fails it prints to stderr — no flags needed:

- **Session state** — consumer count, last status, message history length, launcher state
- **Last 20 events** — `process:spawned`, `backend:connected`, `backend:disconnected`, `error`, …
- **Last 15 lines of CLI stderr** — auth failures, crash messages, stack traces
- **Last 10 lines of CLI stdout** — startup messages, version info

Common patterns:

| Symptom in trace | Likely cause |
|-----------------|--------------|
| `process:exited code=1` shortly after spawn | Binary not found, bad CLI args, or auth failure |
| `backend:disconnected` before any messages | CLI crashed during initialization |
| `error source=bridge` | Message translation or routing failure |
| No `backend:connected` event | CLI never connected back to beamcode's WS server |
| `capabilities:ready` missing | CLI connected but capability handshake timed out |
| stderr shows `API_KEY` errors | Missing or invalid credentials |

#### Step 2: Run with message tracing

If the trace dump isn't enough, enable `BEAMCODE_TRACE=1` and redirect stderr to a file:

```bash
BEAMCODE_TRACE=1 BEAMCODE_TRACE_LEVEL=full BEAMCODE_TRACE_ALLOW_SENSITIVE=1 \
  E2E_PROFILE=real-full USE_REAL_CLI=true \
  pnpm exec vitest run src/e2e/real/session-coordinator-gemini.e2e.test.ts \
  --config vitest.e2e.real.config.ts \
  -t "user_message gets an assistant reply" 2>trace.ndjson
```

Trace levels: `smart` (default — bodies included, sensitive keys redacted) · `headers` (timing + size, no body) · `full` (everything, requires `BEAMCODE_TRACE_ALLOW_SENSITIVE=1`)

#### Step 3: Inspect the trace

```bash
pnpm trace:inspect dropped-backend-types trace.ndjson   # dropped/unmapped message types
pnpm trace:inspect failed-context trace.ndjson           # failed /context attempts
pnpm trace:inspect empty-results-by-version trace.ndjson
```

Or query manually — each event is NDJSON with `boundary`, `diff`, `seq`, `layer`, `direction`:

```bash
# Show fields silently dropped at each translation boundary
grep '"boundary"' trace.ndjson | node -e "
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const obj = JSON.parse(line);
  const drops = (obj.diff || []).filter(d => d.startsWith('-'));
  if (drops.length) console.log('[' + obj.boundary + '] ' + obj.messageType + ' DROPPED:', drops);
});
"
```

A `-fieldName` entry in the `diff` array means the field was **silently dropped** at that translation boundary.

#### Translation Boundary Quick Reference

| Boundary | Where bugs hide | File to fix |
|----------|----------------|-------------|
| T1 `InboundMessage → UnifiedMessage` | Consumer sends but backend ignores | `src/core/inbound-normalizer.ts` |
| T2 `UnifiedMessage → NativeCLI` | Backend receives wrong params | Adapter's `send()` method |
| T3 `NativeCLI → UnifiedMessage` | Backend response not translated | Adapter's message loop |
| T4 `UnifiedMessage → ConsumerMessage` | Consumer never receives the message | `src/core/unified-message-router.ts` |

#### Key files

| File | Purpose |
|------|---------|
| `src/e2e/real/helpers.ts` | `attachTrace()`, `dumpTraceOnFailure()`, `getTrace()` |
| `src/e2e/real/session-coordinator-setup.ts` | `setupRealSession()` — coordinator with trace attached |
| `src/e2e/real/prereqs.ts` | Binary/auth detection, auto-skip logic |
| `src/e2e/real/shared-real-e2e-tests.ts` | Shared parameterised test factory (`registerSharedSmokeTests`, `registerSharedFullTests`) |
| `src/core/message-tracer.ts` | `MessageTracerImpl` for T1–T4 boundary tracing |

### Shared Test Helpers

`src/e2e/helpers/test-utils.ts`:

| Helper | Purpose |
|--------|---------|
| `createProcessManager()` | Profile-aware mock/real CLI process manager |
| `setupTestSessionManager()` | Session manager with in-memory storage |
| `connectTestConsumer(port, id)` | Open a WebSocket as a consumer |
| `connectTestCLI(port, id)` | Open a WebSocket as a CLI client |
| `collectMessages(ws, count)` | Collect N messages from a WebSocket |
| `waitForMessage(ws, predicate)` | Wait until a message matches a predicate |
| `waitForMessageType(ws, type)` | Wait for a specific message type |
| `closeWebSockets(...sockets)` | Graceful WebSocket cleanup |
| `cleanupSessionManager(mgr)` | Tear down a test session manager |

`src/e2e/helpers/backend-test-utils.ts`: mock infrastructure per adapter (ACP subprocess, Codex WebSocket, OpenCode HTTP+SSE).

### Architecture Boundary Checks

```bash
pnpm check:arch
```

Current guards:
- Transport modules must not import backend lifecycle modules directly
- Policy modules must not import transport/backend lifecycle modules directly
- Transport modules must not emit `backend:*` events directly

Temporary exceptions go in `docs/refactor-plan/architecture-waivers.json` with `rule`, `file`, `reason`, and optional `expires_on`.

### Manual Testing

```bash
pnpm build
node dist/bin/beamcode.mjs --no-tunnel        # start locally
curl http://localhost:9414/health              # health check
node dist/bin/beamcode.mjs --no-tunnel --port 8080
```

`Ctrl+C` once = graceful shutdown. `Ctrl+C` twice = force exit.

---

## UnifiedMessage Protocol

See **[docs/unified-message-protocol.md](docs/unified-message-protocol.md)** for the full specification — all 19 message types, 7 content block types, field schemas, and versioning rules.

**Quick reference — types broadcast to consumers:**

| Type | Direction | Broadcast to UI |
|------|-----------|:---------------:|
| `session_init` | backend → consumer | ✅ |
| `status_change` | backend → consumer | ✅ |
| `assistant` | backend → consumer | ✅ |
| `result` | backend → consumer | ✅ |
| `stream_event` | backend → consumer | ✅ |
| `permission_request` | backend → consumer | ✅ |
| `tool_progress` | backend → consumer | ✅ |
| `tool_use_summary` | backend → consumer | ✅ |
| `auth_status` | backend → consumer | ✅ |
| `configuration_change` | backend → consumer | ✅ |
| `user_message` | consumer → backend | — |
| `permission_response` | consumer → backend | — |
| `interrupt` | consumer → backend | — |
| `session_lifecycle` | internal | ✅ |

---

## Message Tracing

BeamCode includes a debug tracing system that logs every message crossing a translation boundary as NDJSON to stderr. Useful for diagnosing message drops, field transformations, and timing issues across the frontend → bridge → backend pipeline.

### Enabling

```bash
# Smart mode (default): bodies included, large fields truncated, sensitive keys redacted
beamcode --trace

# Headers only: traceId, type, direction, timing, size — no body
beamcode --trace --trace-level headers

# Full payloads: every message logged as-is (requires explicit opt-in)
beamcode --trace --trace-level full --trace-allow-sensitive

# Environment-variable controls (CLI flags override env)
BEAMCODE_TRACE=1 beamcode
BEAMCODE_TRACE=1 BEAMCODE_TRACE_LEVEL=headers beamcode
BEAMCODE_TRACE=1 BEAMCODE_TRACE_LEVEL=full BEAMCODE_TRACE_ALLOW_SENSITIVE=1 beamcode
```

### Trace Inspect

Use `trace-inspect` for common operator queries on NDJSON trace logs:

```bash
pnpm trace:inspect dropped-backend-types trace.ndjson
pnpm trace:inspect failed-context trace.ndjson
pnpm trace:inspect empty-results-by-version trace.ndjson
```

### Translation Boundaries

There are 4 translation boundaries where bugs hide:

| # | Boundary | Translator | Location |
|---|----------|-----------|----------|
| T1 | `InboundMessage` → `UnifiedMessage` | `normalizeInbound()` | `src/core/inbound-normalizer.ts` |
| T2 | `UnifiedMessage` → Native CLI format | Adapter outbound translator | Each adapter's `send()` method |
| T3 | Native CLI response → `UnifiedMessage` | Adapter inbound translator | Each adapter's message loop |
| T4 | `UnifiedMessage` → `ConsumerMessage` | `map*()` functions | `src/core/unified-message-router.ts` |

Each boundary emits a `translate` trace event with before/after objects and an auto-generated diff. A field appearing as `-metadata.someField` in the diff means it was **silently dropped** at that boundary.

### Trace Event Schema

```json
{
  "trace": true,
  "traceId": "t_a1b2c3d4",
  "layer": "bridge",
  "direction": "translate",
  "messageType": "user_message",
  "sessionId": "sess-abc",
  "seq": 17,
  "ts": "2026-02-19T10:30:00.123Z",
  "elapsed_ms": 3,
  "translator": "normalizeInbound",
  "boundary": "T1",
  "from": { "format": "InboundMessage", "body": {} },
  "to": { "format": "UnifiedMessage", "body": {} },
  "diff": ["session_id → metadata.session_id", "+role: user"]
}
```

### Key Files

| File | Purpose |
|------|---------|
| `src/core/message-tracer.ts` | `MessageTracer` interface, `MessageTracerImpl`, `noopTracer` |
| `src/core/trace-differ.ts` | Auto-diff utility for translation events |

### Programmatic Usage

```ts
import { MessageTracerImpl, noopTracer } from "beamcode";

const tracer = new MessageTracerImpl({ level: "smart", allowSensitive: false });
const mgr = new SessionManager({ config, launcher, tracer });
```

When `--trace` is not set, `noopTracer` is used — all methods are empty functions with zero overhead.
