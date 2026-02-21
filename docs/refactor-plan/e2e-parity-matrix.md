# E2E Parity Matrix

This matrix defines the minimum E2E coverage required before closing a refactor phase.

## PR Required Gate

- Command: `pnpm test:e2e:parity:pr`
- Includes:
  - `pnpm test:e2e:parity:check`
  - `pnpm test:e2e:deterministic`

## Nightly/Pre-Release Gate

- Command: `pnpm test:e2e:parity:nightly`
- Includes:
  - `pnpm test:e2e:parity:check`
  - `pnpm test:e2e:deterministic`
- Additional real CLI smoke:
  - `pnpm test:e2e:realcli:smoke:process`
  - `pnpm test:e2e:real:claude:smoke`

## Coverage Axes

| Axis | Minimum Coverage |
|---|---|
| Adapters | `acp`, `codex`, `gemini`, `opencode`, `claude` |
| Transport | WebSocket consumer path + HTTP/API session path |
| Lifecycle | create, reconnect, retry/relaunch, shutdown |
| Protocol | `session_init`, `status_change` metadata, permissions, slash passthrough |

## Phase Exit Rule

A phase is not complete until:

1. PR gate is green for all phase PRs.
2. Nightly/pre-release gate is green for the release cut.
3. Any listed temporary gaps have an owner and explicit target phase.
