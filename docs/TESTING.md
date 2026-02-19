# Testing

BeamCode has three test layers, all powered by [Vitest](https://vitest.dev/):

| Layer | Location | Runner | What it covers |
|-------|----------|--------|----------------|
| **Backend** (unit + integration) | `src/**/*.test.ts` | `pnpm test` | Core logic, adapters, crypto, daemon, server |
| **Frontend** (component) | `web/src/**/*.test.{ts,tsx}` | `cd web && pnpm test` | React components, store, utilities |
| **End-to-end** | `src/e2e/*.e2e.test.ts` | `pnpm test` (included) | Full daemon + server + WebSocket lifecycle |

## Quick start

```bash
# Run backend unit/integration tests
pnpm test

# Run frontend tests
cd web && pnpm test

# Run backend + frontend
pnpm test && cd web && pnpm test
```

### Full local suite (including real backend e2e)

```bash
pnpm install
pnpm typecheck
pnpm -r --include-workspace-root test
pnpm test:e2e:deterministic
pnpm test:e2e:real:smoke
pnpm test:e2e:real:full
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

E2E tests live in `src/e2e/` and are split into two tiers:

- **Deterministic** (`src/e2e/*.e2e.test.ts`) — mock backends, fast, no external dependencies
- **Real backend** (`src/e2e/real/*.e2e.test.ts`) — spawn real CLI binaries, require installed backends + API keys

### Running

```bash
# Deterministic lane (mock backends — default)
pnpm test:e2e
pnpm test:e2e:deterministic          # explicit

# Real backend — all backends, smoke lane
pnpm test:e2e:real:smoke

# Real backend — all backends, full lane (includes live prompt tests)
pnpm test:e2e:real:full
```

### Running a single backend

Each backend has a dedicated script: `pnpm test:e2e:real:<backend>`

```bash
pnpm test:e2e:real:claude
pnpm test:e2e:real:codex
pnpm test:e2e:real:gemini
pnpm test:e2e:real:opencode
```

### Backend prerequisites

Each real backend test is gated by binary availability and API key checks.
Tests are auto-skipped when prerequisites are not met.

| Backend | Binary | Auth | Notes |
|---------|--------|------|-------|
| **claude** (Claude) | `claude` | `ANTHROPIC_API_KEY` or `claude auth login` | Prompt tests skipped without auth |
| **codex** | `codex` | Handled by CLI (e.g. `codex auth`) | Binary availability is the only gate |
| **gemini** | `gemini-cli-a2a-server` | Handled by CLI (e.g. `GOOGLE_API_KEY`) | Binary availability is the only gate |
| **opencode** | `opencode` | Handled by CLI config | Binary availability is the only gate |

Prerequisite detection is in `src/e2e/real/prereqs.ts`. Each backend exports a `get*PrereqState()` function
that checks binary availability and API key presence.

### E2E profiles

E2E tests use explicit profiles via `E2E_PROFILE`:

- `deterministic` — stable/default lane using `MockProcessManager`
- `real-smoke` — minimal real backend checks (connection, session init, cleanup)
- `real-full` — broader real backend coverage (adds live prompt/response, cancel, slash commands)

The helper in `src/e2e/helpers/test-utils.ts` resolves process manager selection in this order:

1. `USE_MOCK_CLI=true` -> `MockProcessManager`
2. `USE_REAL_CLI=true` -> `NodeProcessManager`
3. `E2E_PROFILE in {real-smoke, real-full}` -> `NodeProcessManager`
4. deterministic fallback -> Claude CLI auto-detection

Real backend scripts run `scripts/e2e-realcli-preflight.mjs` first and fail fast when Claude CLI is missing.

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

`src/e2e/helpers/backend-test-utils.ts` provides mock infrastructure per adapter:

| Helper group | Purpose |
|--------------|---------|
| `MessageReader`, `collectUnifiedMessages()` | Read from `BackendSession.messages` streams |
| `createMockChild()`, `createAcpAutoResponder()` | ACP (Claude) mock subprocess |
| `MockWebSocket`, `sendCodexNotification()` | Codex mock WebSocket |
| `makeSSE()`, `sseResponse()`, `buildA2A*Event()` | Gemini A2A mock SSE responses |
| `createMockOpencodeHttpClient()`, `buildOpencode*Event()` | Opencode mock HTTP+SSE |
| `createScriptedQueryFn()`, `createPermissionQueryFn()` | Agent SDK scripted query functions |

### E2E test files

#### Deterministic (mock backend)

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
| `acp-adapter.e2e.test.ts` | ACP adapter conversation flows with mock subprocess |
| `agent-sdk-adapter.e2e.test.ts` | Agent SDK adapter flows with scripted query functions |
| `codex-adapter.e2e.test.ts` | Codex adapter session with mock WebSocket |
| `gemini-adapter.e2e.test.ts` | Gemini adapter with mock A2A SSE responses |
| `opencode-adapter.e2e.test.ts` | Opencode adapter with mock HTTP client + SSE events |

#### Real backend (`src/e2e/real/`)

| File | Backend | What it tests |
|------|---------|---------------|
| `smoke.e2e.test.ts` | claude | Basic Claude CLI smoke checks |
| `handshake.e2e.test.ts` | claude | `--sdk-url` WebSocket handshake |
| `process-smoke.e2e.test.ts` | claude | Process spawn and lifecycle |
| `session-manager-claude.e2e.test.ts` | claude | Full SessionManager lifecycle, live turns, multi-consumer, resume |
| `session-manager-codex.e2e.test.ts` | codex | Codex session lifecycle, consumer comms, live prompt, slash commands |
| `session-manager-gemini.e2e.test.ts` | gemini | Gemini session lifecycle, streamed responses, cancel mid-turn |
| `session-manager-opencode.e2e.test.ts` | opencode | Opencode session lifecycle, HTTP+SSE connection, streamed responses |

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
