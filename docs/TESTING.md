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
# All e2e tests (they run as part of the backend suite)
pnpm vitest run src/e2e/

# Single e2e test
pnpm vitest run src/e2e/daemon-server.e2e.test.ts
```

### Adaptive process manager

E2E tests auto-detect whether the Claude CLI is available. The helper in `src/e2e/helpers/test-utils.ts` provides:

- **`MockProcessManager`** — used when Claude CLI is not installed (CI environments)
- **`NodeProcessManager`** — used when Claude CLI is detected locally

Override with environment variables:

```bash
USE_MOCK_CLI=true pnpm vitest run src/e2e/   # Force mock mode
USE_REAL_CLI=true pnpm vitest run src/e2e/   # Force real CLI
```

### Shared helpers

`src/e2e/helpers/test-utils.ts` provides:

| Helper | Purpose |
|--------|---------|
| `createProcessManager()` | Adaptive mock/real CLI process manager |
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
