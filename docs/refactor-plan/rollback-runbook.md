# Core Refactor Rollback Runbook

This runbook documents the minimum rollback steps during phased core refactor rollout.

## Rollback Triggers

- Deterministic E2E parity gate fails on `main`.
- Real CLI smoke regressions in nightly/pre-release.
- Production signal regressions (error rate, reconnect failure spikes, session restore failures).

## Immediate Actions

1. Disable refactor path feature flags and route traffic to legacy session path.
2. Stop active rollout/canary progression.
3. Verify new session creates and reconnect flows on legacy path.
4. Announce rollback in incident/release channel.

## Verification Checklist

- `pnpm test:e2e:parity:pr` passes on rollback commit/config.
- Consumer handshake (`session_init`) and slash command flow verified.
- Adapter shutdown leaves no orphan processes.

## Follow-up

1. Capture failing parity axis (adapter/transport/lifecycle/protocol).
2. File fix issue linked to the owning BC item.
3. Re-run canary using same parity gates before resuming rollout.
