# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
pnpm build           # full build (lib + web)
pnpm build:lib       # TypeScript library only (tsdown + fix-dts)
pnpm build:web       # React frontend only

# Type / lint / format
pnpm typecheck       # tsc --noEmit
pnpm lint            # biome lint src/
pnpm check:fix       # biome check --write src/ (auto-fix)
pnpm check:arch      # enforce architectural layer boundaries

# Unit tests
pnpm test                           # vitest run (all unit tests)
pnpm test:watch                     # vitest watch mode
pnpm exec vitest run -t "test name" # run single test by name

# E2E mock (mock CLI — fast, no real credentials needed)
pnpm test:e2e                       # alias for test:e2e:mock
pnpm test:e2e:mock
pnpm exec vitest run --config vitest.e2e.config.ts -t "test name"

# E2E real backends 
pnpm test:e2e:real:smoke            # smoke tier, all adapters
pnpm test:e2e:real:full             # full tier, all adapters
pnpm test:e2e:real:claude           # Claude-only full
pnpm test:e2e:real:codex            # Codex-only full
pnpm test:e2e:real:gemini           # Gemini-only full
pnpm test:e2e:real:opencode         # OpenCode-only full
pnpm test:e2e:real:agent-sdk        # Agent SDK full

# Run a single real e2e test with full tracing
BEAMCODE_TRACE=1 BEAMCODE_TRACE_LEVEL=full BEAMCODE_TRACE_ALLOW_SENSITIVE=1 \
  E2E_PROFILE=real-full USE_REAL_CLI=true \
  pnpm exec vitest run src/e2e/real/session-coordinator-codex.e2e.test.ts \
  --config vitest.e2e.real.config.ts \
  -t "test name" 2>trace.ndjson
pnpm trace:inspect   # interactive viewer for trace.ndjson
```

## Worktree Workflow

Always implement features and fixes in an isolated worktree, never directly on `main`.

```bash
# Create a worktree + branch for a new feature or fix
git worktree add .worktrees/<short-name> -b <type>/<branch-name>
# e.g.
git worktree add .worktrees/fix-gemini-e2e -b fix/gemini-e2e-live-test
git worktree add .worktrees/feat-hybrid-web -b feat/hybrid-terminal-web

# List active worktrees
git worktree list

# Remove a worktree when done (after PR is merged)
git worktree remove .worktrees/<short-name>
git branch -d <type>/<branch-name>
```

Worktrees live under `.worktrees/` (gitignored). Each has its own working directory but shares the same git object store, so branches and commits are immediately visible across all worktrees.

## Architecture

BeamCode is a message broker that bridges **consumers** (browser/phone via WebSocket) and **local AI CLI backends** (Claude Code, Codex, Gemini, OpenCode, ACP-compatible agents).

### Four Bounded Contexts

| Context | Responsibility |
|---------|----------------|
| **SessionControl** | Lifecycle — `SessionCoordinator` owns a map of `SessionRuntime` instances |
| **BackendPlane** | Adapter layer — `BackendAdapter` interface, per-CLI adapters under `src/adapters/` |
| **ConsumerPlane** | WebSocket transport — `ConsumerGateway` (inbound), `OutboundPublisher` (outbound) |
| **MessagePlane** | Routing & queuing — `UnifiedMessageRouter`, `MessageQueueHandler` |

### Session Lifecycle

```
SessionCoordinator → creates → SessionRuntime (per-session state owner)
SessionRuntime → launches → BackendAdapter → BackendSession (messages: AsyncIterable<UnifiedMessage>)
SessionRuntime → emits → DomainEvent (flat pub/sub; only runtime emits events)
Policy services (ReconnectPolicy, IdlePolicy, CapabilitiesPolicy) — observe only, never mutate
```

### Translation Boundaries (T1–T4)

All adapters translate through four boundaries; pure functions, no side effects:

- **T1** `InboundNormalizer` — `ConsumerMessage → UnifiedMessage`
- **T2** adapter-specific — `UnifiedMessage → NativeCLI format`
- **T3** adapter-specific — `NativeCLI event → UnifiedMessage`
- **T4** `ConsumerMessageMapper` — `UnifiedMessage → ConsumerMessage`

### UnifiedMessage Protocol

Canonical internal envelope with 19 message types (see `src/core/unified-message-protocol.ts`). Key types:

- `user_message`, `assistant`, `tool_use`, `tool_result`
- `result` (terminal — sets status idle), `session_lifecycle`, `status_change`

### Testing Tiers

| Tier | Env vars | Speed | Use |
|------|----------|-------|-----|
| Unit | — | ~1s | Core logic, translators, mappers |
| E2E mock | `USE_MOCK_CLI=true` | ~5s | Full session flow with mock CLIs |
| E2E real-smoke | `USE_REAL_CLI=true E2E_PROFILE=real-smoke` | ~30s | Happy-path with real backends |
| E2E real-full | `USE_REAL_CLI=true E2E_PROFILE=real-full` | minutes | Full suite with real backends |

### Debugging Real E2E Test Failures

See **[DEVELOPMENT.md § Debugging real E2E test failures](DEVELOPMENT.md#debugging-real-e2e-test-failures)** for the full step-by-step guide. Summary:

1. **Built-in trace dump** — `dumpTraceOnFailure()` in `src/e2e/real/helpers.ts` fires automatically in `afterEach` on any failure. It prints session state (consumer count, last status, message history length), the last 20 events (`process:spawned`, `backend:connected`, `error`, …), and recent stdout/stderr from the CLI process. No flags needed — always on.

2. **Enable message-level tracing** when the trace dump isn't enough. Add `BEAMCODE_TRACE=1` to the test run and redirect stderr:
   ```bash
   BEAMCODE_TRACE=1 BEAMCODE_TRACE_LEVEL=full BEAMCODE_TRACE_ALLOW_SENSITIVE=1 \
     E2E_PROFILE=real-full USE_REAL_CLI=true \
     pnpm exec vitest run src/e2e/real/session-coordinator-gemini.e2e.test.ts \
     --config vitest.e2e.real.config.ts \
     -t "test name" 2>trace.ndjson
   ```

3. **Inspect the trace file** with the built-in tool:
   ```bash
   pnpm trace:inspect dropped-backend-types trace.ndjson
   pnpm trace:inspect failed-context trace.ndjson
   ```

4. **Read the diff array** — entries prefixed `-` are fields **silently dropped** at that boundary.

### Translation Boundary Quick Reference

| Boundary | Where bugs hide | File to fix |
|----------|----------------|-------------|
| T1 `InboundMessage → UnifiedMessage` | Consumer sends but backend ignores | `src/core/inbound-normalizer.ts` |
| T2 `UnifiedMessage → NativeCLI` | Backend receives wrong params | Adapter's `send()` method |
| T3 `NativeCLI → UnifiedMessage` | Backend response not translated | Adapter's message loop |
| T4 `UnifiedMessage → ConsumerMessage` | Consumer never receives the message | `src/core/unified-message-router.ts` |

See **[DEVELOPMENT.md § Message Tracing](DEVELOPMENT.md#message-tracing)** for the full trace event schema, practical walkthrough with real examples, and programmatic usage.

### File Layout (key paths)

```
src/
  core/                    # SessionCoordinator, SessionRuntime, routing, queue, mappers
  adapters/
    claude/                # Claude Code adapter
    codex/                 # Codex (JSON-RPC 2.0 over WebSocket, Thread/Turn model)
    acp/                   # ACP-compatible adapter
  transport/               # ConsumerGateway, OutboundPublisher, BackendConnector
  policy/                  # ReconnectPolicy, IdlePolicy, CapabilitiesPolicy
  e2e/
    real/                  # Real-backend e2e tests (shared-real-e2e-tests.ts + per-adapter)
    deterministic/         # Mock-CLI e2e tests
  helpers/                 # test-utils.ts (waitForMessage, collectMessages, attachPrebuffer)
web/                       # React 19 + Zustand + Tailwind v4 frontend
scripts/                   # build scripts, trace-inspect, arch-check, e2e parity gate
```
