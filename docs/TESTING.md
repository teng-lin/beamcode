# Testing

BeamCode has three test layers, all powered by [Vitest](https://vitest.dev/):

| Layer | Location | Runner | What it covers |
|-------|----------|--------|----------------|
| **Backend** (unit + integration) | `src/**/*.test.ts` | `pnpm test` | Core logic, adapters, crypto, daemon, server |
| **Frontend** (component) | `web/src/**/*.test.{ts,tsx}` | `cd web && pnpm test` | React components, store, utilities |
| **End-to-end** | `src/e2e/*.e2e.test.ts` | `pnpm test` (included) | Full daemon + server + WebSocket lifecycle |

## Quick start

```bash
# Run all backend + e2e tests
pnpm test

# Run frontend tests
cd web && pnpm test

# Run everything
pnpm test && cd web && pnpm test
```

## Backend tests

### Configuration

Vitest is configured in `vitest.config.ts`:

- **Globals**: enabled (`describe`, `it`, `expect` available without imports)
- **Include pattern**: `src/**/*.test.ts`
- **Coverage provider**: `@vitest/coverage-v8`

### Running

```bash
# All backend tests (unit + integration + e2e)
pnpm test

# Watch mode
pnpm test:watch

# Single file
pnpm vitest run src/utils/ndjson.test.ts

# Filter by test name
pnpm vitest run -t "parseNDJSON"

# With coverage report
pnpm vitest run --coverage
```

### File naming conventions

| Pattern | Purpose | Example |
|---------|---------|---------|
| `*.test.ts` | Unit tests | `ndjson.test.ts`, `auth-token.test.ts` |
| `*.integration.test.ts` | Integration tests (multi-component) | `session-bridge.integration.test.ts` |
| `*.compliance.test.ts` | Protocol compliance suites | `acp-compliance.test.ts` |
| `*.e2e.test.ts` | End-to-end tests | `daemon-server.e2e.test.ts` |

### Test structure

Tests are co-located next to the source files they cover:

```
src/
  utils/
    ndjson.ts
    ndjson.test.ts          ← unit test
  adapters/
    node-ws-server.ts
    node-ws-server.test.ts  ← unit test
  core/
    session-bridge.ts
    session-bridge.test.ts              ← unit test
    session-bridge.integration.test.ts  ← integration test
  e2e/
    daemon-server.e2e.test.ts
    ws-server-flow.e2e.test.ts
    helpers/
      test-utils.ts         ← shared e2e helpers
```

### Writing a backend test

```typescript
import { describe, expect, it } from "vitest";
import { parseNDJSON } from "./ndjson.js";

describe("parseNDJSON", () => {
  it("parses a single JSON line", () => {
    const { messages, errors } = parseNDJSON('{"type":"keep_alive"}');
    expect(messages).toEqual([{ type: "keep_alive" }]);
    expect(errors).toEqual([]);
  });
});
```

## Frontend tests

### Configuration

Frontend tests are configured inline in `web/vite.config.ts`:

- **Environment**: `jsdom`
- **Setup file**: `web/src/test/setup.ts` (auto-cleanup + `@testing-library/jest-dom` matchers)
- **Include pattern**: `src/**/*.test.{ts,tsx}`

### Running

```bash
cd web

# All frontend tests
pnpm test

# Watch mode
pnpm test:watch

# Single file
pnpm vitest run src/components/Composer.test.tsx

# With coverage
pnpm vitest run --coverage
```

### Libraries

| Library | Purpose |
|---------|---------|
| `@testing-library/react` | Render components, query DOM |
| `@testing-library/user-event` | Simulate user interactions |
| `@testing-library/jest-dom` | DOM assertion matchers (`toBeInTheDocument`, etc.) |
| `jsdom` | Browser environment for Vitest |

### Test setup

`web/src/test/setup.ts` runs before every test file:

```typescript
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
```

### Writing a frontend test

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectionBanner } from "./ConnectionBanner";

describe("ConnectionBanner", () => {
  it("renders an alert with disconnection message", () => {
    render(<ConnectionBanner />);
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent("CLI disconnected");
  });
});
```

## End-to-end tests

E2E tests live in `src/e2e/` and exercise the full stack: daemon, HTTP server, WebSocket connections, and session lifecycle.

### Running

```bash
# Default deterministic lane (mock CLI)
pnpm test:e2e

# Deterministic lane explicitly
pnpm test:e2e:deterministic

# Real CLI smoke lane (requires Claude CLI; API key or CLI login for auth-required tests)
pnpm test:e2e:realcli:smoke

# Real CLI full lane (same prerequisites)
pnpm test:e2e:realcli:full
```

### E2E profiles

E2E tests use explicit profiles via `E2E_PROFILE`:

- `deterministic` — stable/default lane using `MockProcessManager`
- `realcli-smoke` — minimal real backend checks
- `realcli-full` — broader real backend coverage

Current real CLI inventory in `src/e2e/realcli/`:

- 4 suites / 31 total tests
- 23 tests execute real `claude` processes in smoke mode (`prereqs.ok` + localhost-bind capable SessionManager tests)
- 28 tests execute real `claude` processes in full mode (adds 5 live turn/control/multi-consumer tests)

The helper in `src/e2e/helpers/test-utils.ts` resolves process manager selection in this order:

1. `USE_MOCK_CLI=true` -> `MockProcessManager`
2. `USE_REAL_CLI=true` -> `NodeProcessManager`
3. `E2E_PROFILE in {realcli-smoke, realcli-full}` -> `NodeProcessManager`
4. deterministic fallback -> Claude CLI auto-detection

Real CLI scripts run `scripts/e2e-realcli-preflight.mjs` first and fail fast when Claude CLI is missing.
If neither `ANTHROPIC_API_KEY` nor `claude auth login` session is available, auth-required tests are skipped.

### CI lanes

- PR: `E2E Deterministic` is required.
- PR: `E2E Real CLI Smoke` runs when `ANTHROPIC_API_KEY` secret is configured.
- Nightly (`.github/workflows/e2e-nightly.yml`):
  - `E2E Deterministic Full`
  - `E2E Real CLI Full` (secret-gated)


### Shared helpers

`src/e2e/helpers/test-utils.ts` provides:

| Helper | Purpose |
|--------|---------|
| `createProcessManager()` | Profile-aware mock/real CLI process manager |
| `setupTestSessionManager()` | Create a test session manager with in-memory storage |
| `connectTestConsumer(port, id)` | Open a WebSocket as a consumer client |
| `connectTestCLI(port, id)` | Open a WebSocket as a CLI client |
| `collectMessages(ws, count)` | Collect N messages from a WebSocket |
| `waitForMessageType(ws, type)` | Wait for a specific message type |
| `mockAssistantMessage(text)` | Generate a mock assistant response |
| `closeWebSockets(...sockets)` | Graceful WebSocket cleanup |
| `cleanupSessionManager(mgr)` | Tear down a test session manager |

### E2E test files

| File | What it tests |
|------|---------------|
| `daemon-server.e2e.test.ts` | Daemon lifecycle: start, server listen, consumer connect, stop, cleanup |
| `ws-server-flow.e2e.test.ts` | WebSocket message flow between CLI and consumer |
| `encrypted-relay.e2e.test.ts` | Encrypted relay with key exchange and sealed boxes |
| `http-api-sessions.e2e.test.ts` | REST API for session CRUD (`/api/sessions`) |
| `session-lifecycle.e2e.test.ts` | Full session lifecycle from creation to teardown |
| `slash-commands.e2e.test.ts` | Emulated slash command behavior and request/response flow |
| `capabilities-broadcast.e2e.test.ts` | `capabilities_ready` broadcast behavior and late-join replay |
| `permission-flow.e2e.test.ts` | Permission request/response round-trip across CLI and consumers |
| `consumer-edge-cases.e2e.test.ts` | Malformed payload handling, oversize rejection, RBAC edge behavior |
| `session-status.e2e.test.ts` | Status change propagation and interrupt forwarding |
| `message-queue.e2e.test.ts` | Queued message lifecycle (queue, update, cancel, auto-send) |
| `streaming-conversation.e2e.test.ts` | Streaming deltas and multi-turn conversation ordering |
| `presence-rbac.e2e.test.ts` | Identity/presence updates and observer role constraints |
| `realcli/session-manager-realcli.e2e.test.ts` | Real `SessionManager` + `--sdk-url` handshake, connection lifecycle, and full-mode live turns |

## Manual CLI testing

For manual testing of the built CLI binary, see below.

### Start the server

```bash
pnpm build
node dist/bin/beamcode.js --no-tunnel
```

### HTTP checks

```bash
# Health check
curl http://localhost:3456/health
# → {"status":"ok"}

# Verify redirect to active session
curl -v http://localhost:3456/ 2>&1 | grep "< Location"

# 404 for unknown paths
curl -o /dev/null -w "%{http_code}" http://localhost:3456/unknown
# → 404
```

### Custom port and lock file

```bash
# Custom port
node dist/bin/beamcode.js --no-tunnel --port 8080

# Second instance should fail (same data-dir)
node dist/bin/beamcode.js --no-tunnel
# → Error: Daemon already running (PID: <pid>)

# Use a different data-dir for parallel instances
node dist/bin/beamcode.js --no-tunnel --port 3457 --data-dir /tmp/beamcode2
```

### Tunnel (requires cloudflared)

```bash
brew install cloudflared   # macOS
node dist/bin/beamcode.js  # starts with tunnel by default
```

### Graceful shutdown

- `Ctrl+C` once: graceful shutdown (kills CLI processes, closes WebSockets, releases lock file)
- `Ctrl+C` twice: force exit

## Coverage

```bash
# Backend coverage
pnpm vitest run --coverage

# Frontend coverage
cd web && pnpm vitest run --coverage
```

Coverage reports are written to:
- Backend: `./coverage/`
- Frontend: `./web/coverage/`
