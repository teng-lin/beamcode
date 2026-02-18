# E2E Overhaul Agent Team (Execution Spec)

## Mission
Implement the Real-CLI-first e2e overhaul in `feature/e2e-testing-overhaul-codex` (`.worktrees/e2e-testing-overhaul-codex`) with fast feedback, clear ownership, and minimal merge conflicts.

Primary source plan:
- `docs/plans/2026-02-18-e2e-testing-overhaul-codex.md`

Reference plan for gap ideas:
- `docs/plans/2026-02-18-e2e-testing-overhaul-claude.md`

## Team Structure

1. **Lead Integrator (Agent A)**
- Owns branch hygiene, task sequencing, integration decisions, and final CI wiring.
- Owns cross-track conflicts and merge order.

2. **Real CLI Lane Engineer (Agent B)**
- Owns real-CLI smoke/full profiles, preflight checks, and diagnostics artifacts.
- Owns `vitest.e2e.realcli.config.ts` and real-CLI tagged tests.

3. **Core E2E Scenarios Engineer (Agent C)**
- Owns gap-focused test suites:
  - slash commands
  - capabilities broadcast
  - permission flow
  - streaming conversation
- Extends shared helpers in `src/e2e/helpers/test-utils.ts`.

4. **Edge/Resilience Engineer (Agent D)**
- Owns consumer edge cases, session status, queue behavior, and presence/RBAC suites.
- Hardens deterministic waits/timeouts and flaky-test mitigation.

5. **Replay Infrastructure Engineer (Agent E)**
- Owns transcript schema, recorder/replayer, sanitizer, and deterministic fixture flow.
- Starts after Real CLI smoke baseline is merged.

## Workstreams (Priority Order)

### WS1: Real CLI Baseline (P0)
Owner: Agent B, review by Agent A

Deliverables:
1. `vitest.e2e.realcli.config.ts`
2. Real-CLI preflight utility (binary/auth/environment checks)
3. Required PR smoke suite (minimal high-signal)
4. Required nightly full suite scaffold
5. Structured failure artifacts (logs, scenario metadata, failure category)

Exit criteria:
1. PR pipeline includes required real-CLI smoke lane.
2. Nightly pipeline includes required real-CLI full lane.
3. Failures classify as `env`, `protocol`, or `product`.

### WS2: Gap-Focused E2E Expansion (P1)
Owners: Agent C + Agent D, coordinated by Agent A

Target files:
1. `src/e2e/slash-commands.e2e.test.ts`
2. `src/e2e/capabilities-broadcast.e2e.test.ts`
3. `src/e2e/consumer-edge-cases.e2e.test.ts`
4. `src/e2e/permission-flow.e2e.test.ts`
5. `src/e2e/session-status.e2e.test.ts`
6. `src/e2e/message-queue.e2e.test.ts`
7. `src/e2e/presence-rbac.e2e.test.ts`
8. `src/e2e/streaming-conversation.e2e.test.ts`
9. `src/e2e/helpers/test-utils.ts` helper extensions

Exit criteria:
1. New suites pass in deterministic lane.
2. Core smoke-compatible scenarios run in real-CLI lane.
3. Regression classes called out in Claude plan are covered.

### WS3: Replay Layer (P2)
Owner: Agent E, review by Agent A

Deliverables:
1. Turn-level transcript schema/types
2. Capture tooling with strict redaction
3. Replay runner with schema + semantic assertions
4. Initial replay fixtures for critical flows

Exit criteria:
1. Replay tests run as required deterministic lane segment.
2. Volatile fields normalized and sensitive fields redacted.
3. Replay failures are actionable (clear diff + invariant failure).

## Branch/PR Strategy

1. Agent A keeps `feature/e2e-testing-overhaul-codex` integration branch.
2. Each agent works on short-lived child branches:
- `feature/e2e-realcli-baseline`
- `feature/e2e-gap-slash-capabilities`
- `feature/e2e-gap-edge-resilience`
- `feature/e2e-replay-infra`
3. Merge order:
1. WS1 (Real CLI baseline)
2. WS2 (gap suites)
3. WS3 (replay layer)

## Coordination Protocol

1. Daily sync artifacts:
- test matrix status
- failing scenario list
- blocked dependencies
2. Hand-off template for each PR:
- changed files
- scenarios added
- CI lanes affected
- risk notes
3. Definition of done for each PR:
- tests pass in relevant lane(s)
- docs updated
- no flaky wait regressions introduced

## Risk Controls

1. **Real CLI env fragility**
- Mitigation: strict preflight + categorized skips/failures.
2. **Test flakiness from timing/races**
- Mitigation: deterministic barriers, bounded waits, no ad-hoc sleeps.
3. **Large multi-file merge conflicts**
- Mitigation: file ownership boundaries + phased merge order.
4. **Replay fixture drift**
- Mitigation: schema + semantic assertions, stable sanitization map.

## Immediate Kickoff Checklist

1. Agent A: open tracking issue with WS1/WS2/WS3 checklist.
2. Agent B: deliver Real CLI preflight + smoke skeleton first.
3. Agent C/D: scaffold new e2e test files and helper additions in parallel.
4. Agent E: draft transcript schema and sanitizer contract (no fixture churn yet).
