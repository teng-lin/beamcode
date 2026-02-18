# BeamCode Testing Gap Analysis

**Date**: 2026-02-17 (updated)
**Methodology**: Deep exploration of test infrastructure, coverage data, test file inventory, CI config, and code-level review of test patterns across backend (`src/`) and frontend (`web/`)
**Scope**: Test configuration, coverage accuracy, untested critical paths, test quality, CI enforcement, missing test categories

---

## Executive Summary

Since the original assessment, multiple PRs have delivered sweeping improvements. The test suite grew from ~1,500 to **2,308 tests across 137 files**, CI now enforces coverage thresholds on every PR, compliance tests are active (not skipped), and previously untested critical modules (`sdk-url-launcher`, `pty-command-runner`, `codex-session`) now have substantial coverage. The legacy `src/consumer/` module has been removed entirely (PR #32). Property-based tests (fast-check) and accessibility tests (axe-core) have been added.

**Current metrics** (v8 provider):

| Metric | Before (Feb 16) | After (Feb 17) | Delta |
|--------|-----------------|-----------------|-------|
| Statements | 85.85% | **84.52%** | -1.33% (more code added) |
| Branches | 89.01% | **90.69%** | +1.68% |
| Functions | 95.75% | **95.80%** | +0.05% |
| Test count | ~1,500 | **2,308** | +~800 |
| Test files | ~60 | **137** | +~77 |

Coverage thresholds are enforced in `vitest.config.ts` with `autoUpdate: true`. The headline number dipped slightly because new source code was added alongside tests, but branch coverage (the most revealing metric) improved.

**Remaining risk**: The SdkUrlAdapter compliance test is still a TODO (blocked on Phase 1b). Chaos/resilience and visual regression testing categories remain absent. A real a11y issue exists: Sidebar session rows use `role="button"` with nested interactive buttons (`nested-interactive` violation).

---

## Findings Summary

| ID | Original Severity | Status | Notes |
|----|-------------------|--------|-------|
| T1 | CRITICAL | **RESOLVED** | Thresholds enforced, compliance tests active |
| T2 | CRITICAL | **RESOLVED** | All critical modules tested; `src/consumer/` removed (PR #32) |
| T3 | CRITICAL | **RESOLVED** | Coverage runs on all PRs, thresholds in vitest.config |
| T4 | HIGH | **IMPROVED** | 8 real E2E tests, balanced mocking |
| T5 | HIGH | **RESOLVED** | Error paths covered in key modules; consumer module removed |
| T6 | HIGH | **RESOLVED** | api.ts, ws.ts, StatusBar, App, LogDrawer all tested (PR #30) |
| T7 | MEDIUM | **RESOLVED** | Fake timers, deterministic waits, per-test cleanup |
| T8 | MEDIUM | **RESOLVED** | Behavior-focused contracts throughout |
| T9 | MEDIUM | **RESOLVED** | Shared factories + setup files for both layers |
| T10 | LOWER | **MOSTLY RESOLVED** | Property-based (fast-check) + accessibility (axe-core) added; chaos/visual regression absent |
| T11 | LOWER | **RESOLVED** | `docs/TESTING.md` (287 lines) |

---

## RESOLVED Findings

### T1. Coverage Numbers Are Misleading → RESOLVED

- Vitest enforces thresholds (lines 84.52%, branches 90.69%, functions 95.80%, statements 84.52%) with `autoUpdate: true`
- Zero `describe.skip` blocks remain across the entire test suite
- One `describe.todo` remains: `src/adapters/sdk-url/sdk-url-compliance.test.ts` — explicitly documents that `SdkUrlAdapter.connect()` is not yet implemented (Phase 1b)
- Backend test coverage: 106 test files for 145 source files (73% file coverage, up from ~42%)
- Frontend test coverage: 38 test files for 48 source files (79% file coverage)
- `session-bridge.ts` reduced from 2,031 → 1,458 lines via refactoring; now at **95.89% line coverage** with 4 test files (5,299 lines of tests)

### T3. CI Does Not Enforce Test Quality → RESOLVED

- Coverage job now runs on **all PRs and main pushes** (no conditional)
- `vitest.config.ts` thresholds block CI if coverage drops
- `fail_ci_if_error: false` on Codecov upload is intentional: vitest thresholds are the enforcement mechanism, Codecov is supplementary reporting
- E2E tests: 8 files under `src/e2e/` (daemon, adapters, encrypted relay, session lifecycle, HTTP API, WebSocket flows)

### T7. Flaky Test Patterns → RESOLVED

- Frontend tests: zero `setTimeout` calls — all use `vi.useFakeTimers()` with proper cleanup
- Backend: `flushPromises()` helper in `src/testing/cli-message-factories.ts` replaces ad-hoc `setTimeout` ticks
- Mock state isolation: `MockWebSocket.instances` cleared per test, store reset via factories
- `ws.test.ts` uses timer advancement for reconnection backoff (deterministic)

### T8. Tests Verify Implementation, Not Behavior → RESOLVED

- Test names are behavioral specifications: _"creates session with 'starting' state"_, _"reconnects only the closed session while others stay connected"_
- `sdk-url-launcher.test.ts`: tests observable outcomes (state transitions, circuit breaker effects)
- `pty-command-runner.test.ts`: tests user-visible behavior (command typing, exit codes, ANSI stripping)
- `ws.test.ts`: functional contract tests (message routing, reconnection behavior, store sync)

### T9. Missing Shared Test Infrastructure → RESOLVED

**Backend** (`src/testing/`):
- `cli-message-factories.ts` — `createTestSocket()`, `authContext()`, `createMockSession()`, `flushPromises()`, message factories for all CLI message types
- `mock-process-manager.ts`, `mock-command-runner.ts`, `mock-socket.ts`
- `fixtures.ts` — shared test data

**Frontend** (`web/src/test/`):
- `setup.ts` — jsdom + jest-dom configuration
- `factories.ts` — `resetStore()`, `makePermission()`, `makeSessionInfo()`, `makeAssistantContent()`, `makeTeamMember()`, `makeTeamTask()`, `makeTeamState()`

### T11. No Test Strategy Documentation → RESOLVED

- `docs/TESTING.md` (287 lines): three-layer strategy, file naming conventions, directory layout, quick start, library reference, setup instructions, E2E helpers, manual testing procedures, coverage reporting

---

## REMAINING Findings

### T2. Critical Backend Modules Have Zero Tests → RESOLVED

**Now tested** (coverage from v8):

| Module | Coverage | Tests | What's covered |
|--------|----------|-------|----------------|
| `sdk-url-launcher.ts` (522 lines) | 97.05% | 30 | Binary validation, env deny list, session lifecycle, circuit breaker, spawn args, state mutations |
| `pty-command-runner.ts` (223 lines) | 88.88% | 10 | PTY loading errors, trust prompt handling, command execution, ANSI stripping, cleanup |
| `codex-session.ts` (254 lines) | 99.27% | via adapter tests | WebSocket lifecycle, JSON-RPC handshake, protocol translation |
| `session-bridge.ts` (1,458 lines) | 95.89% | 181+55+18+3 | Adapter path, multi-consumer, permissions, message queueing, state management |
| `process-supervisor.ts` (273 lines) | 99.34% | 30 | Process lifecycle, SIGKILL escalation, supervisor management |
| `reconnection-handler.ts` | 100% | 22 | Full coverage including error paths |

The `src/consumer/` module (consumer-client, renderer, permission-ui, crypto-client) was **removed entirely** in PR #32 — the Vite-built `web/` frontend replaces it. `beamcode.ts` (CLI entry point) is tested via E2E.

### T4. Over-Mocking Hides Real Failures → IMPROVED

- 8 real E2E tests now exercise full stack (daemon, WebSocket, adapters, encryption)
- Backend adapter tests still use mock child processes, but compliance tests enforce protocol contracts
- `adapter-bridge-consumer.integration.test.ts` tests the socket → bridge → consumer flow with real message passing
- **Remaining gap**: No tests with real CLI subprocesses and controlled test CLIs (contract tests using actual `execa`/spawn). Protocol timing issues in adapter ↔ CLI communication are still only testable via E2E.

### T5. Error Paths Are Not Tested → RESOLVED

**Now covered**:
- `sdk-url-launcher.test.ts`: path traversal rejection, special character rejection, circuit breaker open, spawn failure
- `pty-command-runner.test.ts`: PTY module missing, hard timeout
- `api.test.ts`: non-OK responses, network errors for all operations
- `ws.test.ts`: malformed JSON, unknown message types, send without connection
- `reconnection-handler.test.ts`: 100% coverage (all paths)
- `session-bridge.test.ts`: 181 tests covering multiple error scenarios

The `src/consumer/` module was removed (PR #32), eliminating the remaining gap.

### T6. Frontend API and WebSocket Layers Are Untested → RESOLVED

**Now tested**:

| File | Lines of tests | What's covered |
|------|---------------|----------------|
| `api.test.ts` | 167 | All CRUD operations, auth headers, error handling |
| `ws.test.ts` | 937 | Multi-connection, reconnection with exponential backoff, message handling (assistant, stream, session lifecycle, permissions, team, process output) |
| `store.test.ts` | 458+ | In-memory operations, state management |
| `StatusBar.test.tsx` | PR #30 | Adapter selector, permission picker, connection status, dropdown interactions |
| `App.test.tsx` | PR #30 | Session switching, global error handling, layout |
| `LogDrawer.test.tsx` | PR #30 | Log display, close button |

All previously untested components (StatusBar, App, LogDrawer) now have test files (PR #30). Accessibility tests added for Composer, Sidebar, StatusBar, SlashMenu, MessageFeed via vitest-axe.

### T10. Entire Test Categories Missing → MOSTLY RESOLVED

**Now present**:

| Category | Status | Evidence |
|----------|--------|---------|
| Contract/Compliance | **Added** | 5 compliance test suites enforcing adapter protocol contracts via reusable harness (`backend-adapter-compliance.ts`) |
| Performance/Benchmark | **Added** | `crypto/benchmark.test.ts` — encryption/decryption perf <5ms |
| Security | **Added** | Auth token tests, file storage path traversal, origin validation, HMAC signing, session ID validation |
| E2E | **Added** | 8 E2E test files covering full system lifecycle |
| Integration | **Added** | 5 integration test files (adapter-bridge, session-bridge, encryption pipeline, reconnection) |
| Property-based | **Added** | 43 fast-check tests across 6 files: JSON-RPC roundtrip/type guards, UnifiedMessage canonicalize/validation, state reducer immutability/idempotency, team state reducer, message sequencer monotonicity, auth token uniqueness/isolation |
| Accessibility | **Added** | 6 axe-core tests via vitest-axe: Composer, Sidebar, StatusBar, SlashMenu, MessageFeed. Found real issue: Sidebar nested-interactive violation |

**Still missing**:

| Category | Risk | Recommendation |
|----------|------|---------------|
| Chaos/Resilience | MEDIUM | Process crash injection, network partition simulation. Valuable but complex to set up. |
| Visual regression | LOW | No Chromatic/Percy. Component visual changes undetected. |

---

## Updated Remediation Roadmap

### Phase 1: Close Remaining Gaps — DONE

All Phase 1 items resolved:
- ~~Tests for `StatusBar.tsx`~~ — PR #30
- ~~`src/consumer/` decision~~ — removed entirely in PR #32
- SdkUrlAdapter compliance test — still blocked on Phase 1b

### Phase 2: Add Missing Test Categories — MOSTLY DONE

| Item | Gap | Status |
|------|-----|--------|
| ~~Property-based tests with fast-check~~ | T10 | **DONE** — 43 tests across 6 files |
| ~~Accessibility tests with axe-core~~ | T10 | **DONE** — 6 tests across 5 components |
| Contract tests with real subprocess (controlled test CLI) | T4 | Remaining |

### Phase 3: Harden (ongoing)

| Item | Gap | Effort |
|------|-----|--------|
| Fix Sidebar nested-interactive a11y violation | T10 | 0.5 days |
| Chaos/resilience tests (process crash, network partition) | T10 | 3–5 days |
| Visual regression with Chromatic or Percy | T10 | 2–3 days |

---

## Relationship to Other Reports

- **[Architecture Gap Analysis](2026-02-17-architecture-gap-analysis.md)** — G9 (Testing Gaps) is expanded here; most items now resolved
- **[Frontend Gap Analysis](2026-02-17-frontend-architecture-gap-analysis.md)** — F7 (No E2E Tests) resolved with 8 E2E test files
- **[Production Readiness Report](2026-02-15-production-readiness-report.md)** — C2 (consumer module 0% coverage) no longer applicable (`src/consumer/` removed in PR #32); C3 (backend adapter path) resolved; C4 (Codex adapter) now at 99.27%
- **[Codebase Quality Assessment](2026-02-16-codebase-quality-assessment.md)** — Testing should be re-rated from "Adequate" to "Good" for critical paths
