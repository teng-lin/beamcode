# Development

Architecture reference, adapter guide, configuration, testing, and build.

## Table of Contents

- [Architecture](#architecture)
- [Adapters](#adapters)
- [UnifiedMessage Protocol](#unifiedmessage-protocol)
- [Configuration](#configuration)
- [Events](#events)
- [Authentication](#authentication)
- [Message Tracing](#message-tracing)
- [Building](#building)
- [Testing](#testing)

---

## Architecture

See [docs/architecture-diagram.md](docs/architecture-diagram.md) for the full architecture diagram, data flows, module decomposition, and package structure.

**Summary:** An HTTP+WS server routes `ConsumerMessage` / `InboundMessage` through `SessionBridge` (a `TypedEventEmitter` orchestrator decomposed into 15+ focused modules) to a `BackendAdapter` — Claude, ACP, Codex, Gemini, or OpenCode. A daemon layer manages process lifecycle; a relay layer adds Cloudflare Tunnel + E2E encryption for remote access.

---

## Adapters

### BackendAdapter Interface

Every coding agent backend implements a single interface:

```ts
interface BackendCapabilities {
  streaming: boolean;       // partial response streaming
  permissions: boolean;     // native permission requests
  slashCommands: boolean;
  availability: "local" | "remote" | "both";
  teams: boolean;
}

interface ConnectOptions {
  sessionId: string;
  resume?: boolean;
  adapterOptions?: Record<string, unknown>;
}

interface BackendAdapter {
  readonly name: string;
  readonly capabilities: BackendCapabilities;
  connect(options: ConnectOptions): Promise<BackendSession>;
  createSlashExecutor?(session: BackendSession): AdapterSlashExecutor | null;
}

interface BackendSession {
  readonly sessionId: string;
  send(message: UnifiedMessage): void;
  sendRaw(ndjson: string): void;          // bypass translation (Claude-specific)
  readonly messages: AsyncIterable<UnifiedMessage>;
  close(): Promise<void>;
}
```

Sessions can optionally implement extension interfaces via runtime type narrowing (`"interrupt" in session`):

```ts
interface Interruptible  { interrupt(): void }
interface Configurable   { setModel(model: string): void; setPermissionMode(mode: string): void }
interface PermissionHandler {
  readonly permissionRequests: AsyncIterable<PermissionRequestEvent>;
  respondToPermission(requestId: string, behavior: "allow" | "deny"): void;
}
interface Reconnectable  { onDisconnect(cb: () => void): void; replay(fromSeq: number): AsyncIterable<UnifiedMessage> }
interface TeamObserver   { readonly teamName: string; readonly teamEvents: AsyncIterable<TeamEvent> }
interface Encryptable    { encrypt(msg: UnifiedMessage): EncryptedEnvelope; decrypt(env: EncryptedEnvelope): UnifiedMessage }
```

### Adapter Comparison

| Adapter | Protocol | Agents | Streaming | Permissions | Session Resume |
|---------|----------|--------|-----------|-------------|----------------|
| Claude | NDJSON/WebSocket | Claude Code | Yes | Yes | Yes |
| Claude Agent SDK | In-process SDK | Claude Code | Yes | Yes | Yes |
| ACP | JSON-RPC 2.0/stdio | 25+ (Goose, Kiro, Cline, ...) | Yes | Yes | Varies |
| Codex | JSON-RPC/WebSocket | Codex CLI | Yes | Yes | Yes |
| Gemini | JSON-RPC 2.0/stdio | Gemini CLI (wraps ACP) | Yes | Yes | Varies |
| OpenCode | REST+SSE | opencode | Yes | Yes | No |

#### Claude

Uses an **inverted connection** pattern: `connect()` registers a pending slot, then the Claude CLI connects back to beamcode's WS server via `--sdk-url`.

```ts
import { ClaudeAdapter } from "beamcode";
// Used automatically when adapter: "claude" in session config

const adapter = new ClaudeAdapter();
const session = await adapter.connect({
  sessionId: "my-session",
  adapterOptions: { socketTimeoutMs: 30_000 },  // optional, default 30s
});
```

#### ACP (Agent Client Protocol)

JSON-RPC 2.0 over stdio — covers every ACP-compliant agent (Goose, Kiro, Cline, ...). Command/args are passed via `adapterOptions`.

```ts
import { AcpAdapter } from "beamcode/adapters/acp";

const adapter = new AcpAdapter(); // optional spawnFn for testing

const session = await adapter.connect({
  sessionId: "my-session",
  adapterOptions: {
    command: "goose",   // or "kiro-cli", "cline", etc.
    args: ["acp"],
    cwd: "/my/project",
  },
});

for await (const msg of session.messages) {
  console.log(msg.type, msg);
}
```

#### Codex

JSON-RPC over WebSocket — launches a `codex app-server` subprocess.

```ts
import { CodexAdapter } from "beamcode/adapters/codex";

const adapter = new CodexAdapter({
  processManager,
  codexBinary: "codex",   // optional, default "codex"
  port: 0,                // optional, picks a free port
});

const session = await adapter.connect({ sessionId: "my-session" });
```

#### Gemini

Wraps `AcpAdapter`, spawning `gemini --experimental-acp`.

```ts
import { GeminiAdapter } from "beamcode/adapters/gemini";

const adapter = new GeminiAdapter({ geminiBinary: "gemini" }); // options optional

const session = await adapter.connect({
  sessionId: "my-session",
  adapterOptions: { cwd: "/my/project" },
});
```

#### OpenCode

REST + SSE — manages one shared `opencode serve` process, demuxing SSE events per session.

```ts
import { OpencodeAdapter } from "beamcode/adapters/opencode";

const adapter = new OpencodeAdapter({
  processManager,
  port: 4096,             // optional, default 4096
  opencodeBinary: "opencode",
  directory: "/my/project",
  password: "secret",     // optional
});

const session = await adapter.connect({ sessionId: "my-session" });
```

---

## UnifiedMessage Protocol

All adapters translate to/from `UnifiedMessage` — a normalized envelope that flows through `UnifiedMessageRouter` to `ConsumerBroadcaster` and the React UI.

**19 message types** (10 routed to consumers, 9 internal/bridge-handled):

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
| `team_message` | backend → state | indirect ¹ |
| `team_task_update` | backend → state | indirect ¹ |
| `team_state_change` | backend → state | indirect ¹ |
| `session_lifecycle` | internal | ✅ |
| `control_response` | internal | — |
| `unknown` | — | — |

¹ Team messages are not broadcast directly, but their state changes are broadcast to consumers as `session_update` messages via `emitTeamEvents()`.

**7 content block types** in `UnifiedContent`: `text`, `tool_use`, `tool_result`, `code`, `image`, `thinking`, `refusal`.

---

## Configuration

```ts
interface ProviderConfig {
  port: number;                             // WebSocket server port

  // Timeouts (ms)
  gitCommandTimeoutMs?: number;             // default: 3000
  relaunchGracePeriodMs?: number;           // default: 2000
  killGracePeriodMs?: number;               // default: 5000
  storageDebounceMs?: number;               // default: 150
  reconnectGracePeriodMs?: number;          // default: 10000
  resumeFailureThresholdMs?: number;        // default: 5000
  relaunchDedupMs?: number;                 // default: 5000

  // Resource limits
  maxMessageHistoryLength?: number;         // default: 1000
  maxConcurrentSessions?: number;           // default: 50

  // Rate limiting
  consumerMessageRateLimit?: {
    tokensPerSecond: number;
    burstSize: number;
  };

  // Circuit breaker
  cliRestartCircuitBreaker?: {
    failureThreshold: number;
    windowMs: number;
    recoveryTimeMs: number;
    successThreshold: number;
  };

  // CLI
  defaultClaudeBinary?: string;             // default: "claude"

  // Security
  envDenyList?: string[];                   // always includes LD_PRELOAD, DYLD_INSERT_LIBRARIES, NODE_OPTIONS
}
```

---

## Events

### Bridge Events (`BridgeEventMap`)

| Event | Payload |
|-------|---------|
| `backend:connected` | `{ sessionId }` |
| `backend:disconnected` | `{ sessionId, code, reason }` |
| `backend:session_id` | `{ sessionId, backendSessionId }` |
| `backend:relaunch_needed` | `{ sessionId }` |
| `backend:message` | `{ sessionId, message: UnifiedMessage }` |
| `consumer:connected` | `{ sessionId, consumerCount, identity? }` |
| `consumer:disconnected` | `{ sessionId, consumerCount, identity? }` |
| `consumer:authenticated` | `{ sessionId, userId, displayName, role }` |
| `consumer:auth_failed` | `{ sessionId, reason }` |
| `message:outbound` | `{ sessionId, message: ConsumerMessage }` |
| `message:inbound` | `{ sessionId, message: InboundMessage }` |
| `permission:requested` | `{ sessionId, request }` |
| `permission:resolved` | `{ sessionId, requestId, behavior }` |
| `session:first_turn_completed` | `{ sessionId, firstUserMessage }` |
| `session:closed` | `{ sessionId }` |
| `slash_command:executed` | `{ sessionId, command, source, durationMs }` |
| `slash_command:failed` | `{ sessionId, command, error }` |
| `capabilities:ready` | `{ sessionId, commands, models, account }` |
| `capabilities:timeout` | `{ sessionId }` |
| `team:created` | `{ sessionId, teamName }` |
| `team:deleted` | `{ sessionId, teamName }` |
| `team:member:joined` | `{ sessionId, member }` |
| `team:member:idle` | `{ sessionId, member }` |
| `team:member:shutdown` | `{ sessionId, member }` |
| `team:task:created` | `{ sessionId, task }` |
| `team:task:claimed` | `{ sessionId, task }` |
| `team:task:completed` | `{ sessionId, task }` |
| `auth_status` | `{ sessionId, isAuthenticating, output, error? }` |
| `error` | `{ source, error, sessionId? }` |

### Launcher Events (`LauncherEventMap`)

| Event | Payload |
|-------|---------|
| `process:spawned` | `{ sessionId, pid }` |
| `process:exited` | `{ sessionId, exitCode, uptimeMs, circuitBreaker? }` |
| `process:connected` | `{ sessionId }` |
| `process:resume_failed` | `{ sessionId }` |
| `process:stdout` | `{ sessionId, data }` |
| `process:stderr` | `{ sessionId, data }` |
| `error` | `{ source, error, sessionId? }` |

`SessionManager` emits the union of both maps (`SessionManagerEventMap = BridgeEventMap & LauncherEventMap`).

---

## Authentication

Pluggable `Authenticator` interface gates consumer WebSocket connections:

```ts
import type { Authenticator, AuthContext, ConsumerIdentity } from "beamcode";

const authenticator: Authenticator = {
  async authenticate(context: AuthContext): Promise<ConsumerIdentity> {
    const token = (context.transport.query as Record<string, string>)?.token;
    if (!token) throw new Error("Missing token");
    const user = await verifyToken(token);
    return {
      userId: user.id,
      displayName: user.name,
      role: user.isAdmin ? "participant" : "observer",
    };
  },
};
```

Without an authenticator, consumers get anonymous participant identities.

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
# Show failed /context attempts
pnpm trace:inspect failed-context trace.ndjson

# Show dropped/unmapped backend message types
pnpm trace:inspect dropped-backend-types trace.ndjson

# Show empty slash-command results grouped by backend version
pnpm trace:inspect empty-results-by-version trace.ndjson
```

### Translation Boundaries

There are 4 translation boundaries where bugs hide:

| # | Boundary | Translator | Location |
|---|----------|-----------|----------|
| T1 | `InboundMessage` → `UnifiedMessage` | `normalizeInbound()` | `session-bridge.ts` |
| T2 | `UnifiedMessage` → Native CLI format | Adapter outbound translator | Each adapter's `send()` method |
| T3 | Native CLI response → `UnifiedMessage` | Adapter inbound translator | Each adapter's message loop |
| T4 | `UnifiedMessage` → `ConsumerMessage` | `map*()` functions | `unified-message-router.ts` |

Each boundary emits a `translate` trace event with before/after objects and an auto-generated diff showing exactly which fields changed.

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

// Inject into SessionManager
const tracer = new MessageTracerImpl({
  level: "smart",
  allowSensitive: false,
});

const mgr = new SessionManager({ config, launcher, tracer });
```

When `--trace` is not set, `noopTracer` is used — all methods are empty functions with zero overhead.

### Debugging with Traces: Practical Walkthrough

This section explains the step-by-step process for using traces to find where messages are dropped or malformed. This is the primary debugging technique for cross-boundary issues.

#### Step 1: Start beamcode with full tracing

```bash
# Build first (required after code changes)
pnpm build:lib

# Start with full trace, stderr to file
node dist/bin/beamcode.mjs \
  --trace --trace-level full --trace-allow-sensitive \
  --adapter gemini --no-tunnel \
  2>trace.ndjson
```

Note the **Session ID** from the startup output — you need it to connect as a consumer.

#### Step 2: Connect a consumer and trigger the flow

```bash
SESSION_ID="<from startup output>"

node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:9414/ws/consumer/$SESSION_ID');

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log(msg.type, JSON.stringify(msg).substring(0, 120));
});

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'user_message',
    content: 'Hello',
    session_id: '$SESSION_ID'
  }));
});

setTimeout(() => process.exit(0), 15000);
"
```

#### Step 3: Analyze the trace for drops

Extract translation events and check for dropped fields at each boundary:

```bash
# Show all translation events (T1–T4) in sequence
grep '"trace":true' trace.ndjson | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        obj = json.loads(line.strip())
        boundary = obj.get('boundary', '')
        if boundary:
            diff = obj.get('diff', [])
            drops = [d for d in diff if d.startswith('-')]
            adds = [d for d in diff if d.startswith('+')]
            maps = [d for d in diff if '→' in d]
            print(f'[{boundary}] {obj.get(\"messageType\", \"?\")}')
            if maps: print(f'  mapped: {maps}')
            if drops: print(f'  DROPPED: {drops}')
            if adds: print(f'  added: {adds}')
    except: pass
"
```

A field appearing as `-metadata.someField` in a diff means it was **silently dropped** at that boundary.

#### Step 4: Find the specific boundary

| Symptom | Check boundary | File to fix |
|---------|---------------|-------------|
| Consumer never receives the message | T4 | `unified-message-router.ts` |
| Backend receives wrong params | T2 | Adapter's inbound translator |
| Backend response not translated | T3 | Adapter's outbound translator |
| Consumer sends but backend ignores | T1 | `inbound-normalizer.ts` |

#### Step 5: Check for errors and unmapped types

```bash
# Show errors (parse failures, unmapped types)
grep '"trace":true' trace.ndjson | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        obj = json.loads(line.strip())
        if obj.get('outcome') in ('parse_error', 'unmapped_type') or 'error' in obj.get('direction', ''):
            print(f'[seq={obj.get(\"seq\")}] {obj.get(\"layer\")} {obj.get(\"direction\")} — {obj.get(\"messageType\", \"?\")}')
            if obj.get('body'): print(f'  body: {json.dumps(obj[\"body\"])[:200]}')
    except: pass
"
```

#### Step 6: Inspect raw backend messages

```bash
# Show all native messages to/from backend
grep '"trace":true' trace.ndjson | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        obj = json.loads(line.strip())
        layer = obj.get('layer', '')
        direction = obj.get('direction', '')
        if layer == 'backend' and direction in ('send', 'recv'):
            body = obj.get('body', {})
            method = body.get('method', 'response')
            error = body.get('error', {})
            print(f'[seq={obj.get(\"seq\")}] {direction} {method}', end='')
            if error: print(f' ERROR={json.dumps(error)}', end='')
            print()
    except: pass
"
```

#### Example: Diagnosing a dropped field

Real example — `authMethods` was present in the ACP initialize response but missing from the consumer's `session_init`:

```
[T3] session_init
  mapped: ['content → session.tools', 'metadata.agentCapabilities → ...']
  DROPPED: ['-metadata.authMethods']
  added: ['+session.session_id', '+session.model', ...]
```

The `-metadata.authMethods` in the T4 diff immediately shows the field was dropped at the `handleSessionInit` mapper in `unified-message-router.ts`. Fix: store the field on `session.state` before building the consumer message.

#### Tips

- Use `--trace-level smart` (default) to avoid sensitive data in logs
- The `seq` field orders events chronologically across all layers
- The `diff` array is auto-generated — look for `-` prefixed entries (drops)
- Use `pnpm trace:inspect dropped-backend-types trace.ndjson` for a pre-built query on dropped types
- Each adapter maintains its own T2/T3 translators — check the adapter directory for the specific backend

---

## Building

```sh
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

# Lint
pnpm lint
```

---

## Testing

BeamCode has three test layers, all powered by [Vitest](https://vitest.dev/):

| Layer | Location | Runner | What it covers |
|-------|----------|--------|----------------|
| **Backend** (unit + integration) | `src/**/*.test.ts` | `pnpm test` | Core logic, adapters, crypto, daemon, server |
| **Frontend** (component) | `web/src/**/*.test.{ts,tsx}` | `cd web && pnpm test` | React components, store, utilities |
| **End-to-end** | `src/e2e/*.e2e.test.ts` | `pnpm test` (included) | Full daemon + server + WebSocket lifecycle |

### Quick start

```bash
# Backend unit/integration tests
pnpm test

# Frontend tests
cd web && pnpm test

# Full local suite
pnpm install
pnpm typecheck
pnpm -r --include-workspace-root test
pnpm test:e2e:deterministic
pnpm test:e2e:real:smoke
pnpm test:e2e:real:full
```

### Backend tests

Vitest is configured in `vitest.config.ts` with globals enabled and include pattern `src/**/*.test.ts`.

```bash
pnpm test                                    # all backend tests
pnpm test:watch                              # watch mode
pnpm vitest run src/utils/ndjson.test.ts     # single file
pnpm vitest run -t "parseNDJSON"             # filter by name
pnpm vitest run --coverage                   # with coverage
```

**File naming:**

| Pattern | Purpose |
|---------|---------|
| `*.test.ts` | Unit tests |
| `*.integration.test.ts` | Multi-component integration tests |
| `*.compliance.test.ts` | Protocol compliance suites |
| `*.e2e.test.ts` | End-to-end tests |

Tests are co-located next to the source files they cover.

**Example:**

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

### Frontend tests

Configured in `web/vite.config.ts` with `jsdom` environment and `web/src/test/setup.ts` for auto-cleanup.

```bash
cd web
pnpm test                                              # all
pnpm test:watch                                        # watch mode
pnpm vitest run src/components/Composer.test.tsx       # single file
pnpm vitest run --coverage
```

Libraries: `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`.

**Example:**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectionBanner } from "./ConnectionBanner";

describe("ConnectionBanner", () => {
  it("renders an alert with disconnection message", () => {
    render(<ConnectionBanner />);
    expect(screen.getByRole("alert")).toHaveTextContent("CLI disconnected");
  });
});
```

### End-to-end tests

E2E tests live in `src/e2e/` and split into two tiers:

- **Deterministic** (`src/e2e/*.e2e.test.ts`) — mock backends, fast, no external dependencies
- **Real backend** (`src/e2e/real/*.e2e.test.ts`) — spawn real CLI binaries, require installed backends + API keys

```bash
# Deterministic (mock backends — default)
pnpm test:e2e
pnpm test:e2e:deterministic

# Real backend — smoke lane
pnpm test:e2e:real:smoke

# Real backend — full lane
pnpm test:e2e:real:full

# Per-backend
pnpm test:e2e:real:claude
pnpm test:e2e:real:agent-sdk
pnpm test:e2e:real:codex
pnpm test:e2e:real:gemini
pnpm test:e2e:real:opencode

# Single test by name (-- forwards args to vitest, -t filters by description)
pnpm test:e2e:real:agent-sdk -- -t "user_message gets an assistant reply"
pnpm test:e2e:real:claude -- -t "broadcast assistant reply"

# Smoke-only for a single backend
pnpm test:e2e:real:agent-sdk:smoke
pnpm test:e2e:real:claude:smoke
```

**Real backend prerequisites:**

| Backend | Binary / Package | Auth |
|---------|------------------|------|
| claude | `claude` | `ANTHROPIC_API_KEY` or `claude auth login` |
| agent-sdk | `claude` + `@anthropic-ai/claude-agent-sdk` | `claude auth login` (uses CLI auth, no API key needed) |
| codex | `codex` | handled by CLI |
| gemini | `gemini` | `GOOGLE_API_KEY` or CLI config |
| opencode | `opencode` | handled by CLI config |

Tests are auto-skipped when prerequisites are not met. Detection logic is in `src/e2e/real/prereqs.ts`.

**E2E profiles** (via `E2E_PROFILE`):
- `deterministic` — stable lane using `MockProcessManager`
- `real-smoke` — minimal real backend checks (connection, session init, cleanup)
- `real-full` — broader coverage (live prompt/response, cancel, slash commands)

**CI lanes:**
- PR: `E2E Deterministic` is required
- PR: `E2E Real CLI Smoke` runs when `ANTHROPIC_API_KEY` secret is configured
- Nightly: full deterministic + full real CLI (secret-gated)

### Running a single e2e test in isolation

**This is the primary workflow when debugging a failing real backend test.**

The real backend scripts set required env vars (`E2E_PROFILE`, `USE_REAL_CLI`) and point vitest at the real config. To run a single test you must preserve those vars:

```bash
# Run one test file (e.g. claude) — smoke lane
E2E_PROFILE=real-smoke USE_REAL_CLI=true \
  pnpm vitest run src/e2e/real/session-coordinator-claude.e2e.test.ts \
  --config vitest.e2e.real.config.ts

# Filter further by test name using -t
E2E_PROFILE=real-smoke USE_REAL_CLI=true \
  pnpm vitest run src/e2e/real/session-coordinator-claude.e2e.test.ts \
  --config vitest.e2e.real.config.ts \
  -t "launch emits process spawn"
```

**With message tracing** (recommended when the trace dump alone is not enough):

```bash
# Smart tracing — bodies included, sensitive keys redacted (safe default)
BEAMCODE_TRACE=1 E2E_PROFILE=real-smoke USE_REAL_CLI=true \
  pnpm vitest run src/e2e/real/session-coordinator-claude.e2e.test.ts \
  --config vitest.e2e.real.config.ts \
  -t "launch emits process spawn" 2>trace.ndjson

# Full tracing — every payload as-is, no redaction
BEAMCODE_TRACE=1 BEAMCODE_TRACE_LEVEL=full BEAMCODE_TRACE_ALLOW_SENSITIVE=1 \
  E2E_PROFILE=real-smoke USE_REAL_CLI=true \
  pnpm vitest run src/e2e/real/session-coordinator-claude.e2e.test.ts \
  --config vitest.e2e.real.config.ts \
  -t "launch emits process spawn" 2>trace.ndjson

# Then inspect the trace
pnpm trace:inspect dropped-backend-types trace.ndjson
```

Replace `session-coordinator-claude` with `session-coordinator-gemini`, `session-coordinator-codex`, or `session-coordinator-opencode` for other backends. Use `real-full` profile to enable full-coverage tests (`it.runIf(runFull)`).

> **Note:** The `-t` flag matches a substring of the test name. Wrap in quotes if the name contains spaces.

### Architecture Boundary Checks

Run architecture checks locally with:

```bash
pnpm check:arch
```

Current checks focus on migration guardrails:
- transport modules must not import backend lifecycle modules directly
- policy modules must not import transport/backend lifecycle modules directly
- transport modules must not emit `backend:*` events directly
- when `src/core/runtime/session-runtime.ts` exists, mutation guardrails activate for `session.state`

Temporary exceptions must be tracked in:

`docs/refactor-plan/architecture-waivers.json`

Waiver entries require:
- `rule`
- `file`
- `reason`
- optional `pattern`
- optional `expires_on` (recommended)

### Debugging real E2E test failures

Real backend e2e tests spawn actual CLI processes (claude, gemini, codex, opencode) and communicate over WebSockets. When a test fails, the error message alone is rarely enough — you need to see what the backend process did. BeamCode's e2e infrastructure captures a per-manager trace of events, stdout, and stderr that is automatically dumped on test failure.

#### Built-in trace dump (automatic)

Every real e2e test file calls `dumpTraceOnFailure()` in its `afterEach` hook. When a test fails, this prints to stderr:

- **Session state** — launcher state, exit code, PID, consumer count, message history length
- **Recent events** (last 20) — `process:spawned`, `backend:connected`, `backend:disconnected`, `error`, etc.
- **Recent stderr** (last 15 lines) — CLI error output, stack traces, auth failures
- **Recent stdout** (last 10 lines) — CLI startup messages, version info

This output appears in the vitest console automatically — no flags needed.

#### Enabling message-level tracing

For deeper inspection of the message translation pipeline (T1–T4 boundaries), pass `BEAMCODE_TRACE=1` to the test run. This activates the `MessageTracer` inside the `SessionManager`, logging every message crossing a translation boundary as NDJSON.

```bash
# Run a single backend's e2e tests with full message tracing
BEAMCODE_TRACE=1 BEAMCODE_TRACE_LEVEL=full BEAMCODE_TRACE_ALLOW_SENSITIVE=1 \
  pnpm test:e2e:real:gemini 2>trace.ndjson

# Then analyze with trace-inspect or manual grep
pnpm trace:inspect dropped-backend-types trace.ndjson
```

Trace levels:
- `smart` (default) — message bodies included, large fields truncated, sensitive keys redacted
- `headers` — traceId, type, direction, timing, size only (no body)
- `full` — every message logged as-is (requires `BEAMCODE_TRACE_ALLOW_SENSITIVE=1`)

#### Step-by-step debugging walkthrough

1. **Run the failing test in isolation** with verbose output:

   ```bash
   E2E_PROFILE=real-smoke USE_REAL_CLI=true \
     pnpm vitest run src/e2e/real/session-coordinator-gemini.e2e.test.ts \
     --config vitest.e2e.real.config.ts --reporter=verbose 2>&1 | tee test-output.log
   ```

   Look for the `[gemini-e2e-debug]` (or `[claude-e2e-debug]`, etc.) prefix in the output — that's the trace dump.

2. **Check the trace dump for clues:**

   | Symptom in trace | Likely cause |
   |-----------------|--------------|
   | `process:exited code=1` shortly after spawn | Binary not found, auth failure, or bad CLI args |
   | `backend:disconnected` before any messages | CLI crashed during initialization |
   | `error source=bridge` | Message translation or routing failure |
   | stderr shows `GOOGLE_API_KEY` / `ANTHROPIC_API_KEY` errors | Missing credentials |
   | No `backend:connected` event | CLI never connected back to beamcode's WS server |
   | `capabilities:ready` missing | CLI connected but handshake timed out |

3. **If the trace dump isn't enough**, re-run with message tracing to see what crossed each boundary:

   ```bash
   BEAMCODE_TRACE=1 BEAMCODE_TRACE_LEVEL=smart \
     E2E_PROFILE=real-smoke USE_REAL_CLI=true \
     pnpm vitest run src/e2e/real/session-coordinator-gemini.e2e.test.ts \
     --config vitest.e2e.real.config.ts 2>trace.ndjson

   # Show translation events with drops
   grep '"boundary"' trace.ndjson | python3 -c "
   import sys, json
   for line in sys.stdin:
       obj = json.loads(line.strip())
       diff = obj.get('diff', [])
       drops = [d for d in diff if d.startswith('-')]
       if drops:
           print(f'[{obj[\"boundary\"]}] {obj.get(\"messageType\",\"?\")} DROPPED: {drops}')
   "
   ```

4. **For timeout-related failures**, check timing between events:

   ```bash
   # Extract event timestamps from the trace dump
   grep 'e2e-debug' test-output.log | grep -E 'process:|backend:|capabilities:'
   ```

   Large gaps between `process:spawned` and `backend:connected` suggest the CLI is slow to initialize. Adjust `connectTimeoutMs` in the test config if needed.

#### Key files

| File | Purpose |
|------|---------|
| `src/e2e/real/helpers.ts` | `attachTrace()`, `dumpTraceOnFailure()`, `getTrace()` |
| `src/e2e/real/session-coordinator-setup.ts` | `setupRealSession()` — creates coordinator with trace attached |
| `src/e2e/real/prereqs.ts` | Binary/auth detection, auto-skip logic |
| `src/core/message-tracer.ts` | `MessageTracerImpl` for T1–T4 boundary tracing |

### Shared test helpers

`src/e2e/helpers/test-utils.ts`:

| Helper | Purpose |
|--------|---------|
| `createProcessManager()` | Profile-aware mock/real CLI process manager |
| `setupTestSessionManager()` | Session manager with in-memory storage |
| `connectTestConsumer(port, id)` | Open a WebSocket as a consumer |
| `connectTestCLI(port, id)` | Open a WebSocket as a CLI client |
| `collectMessages(ws, count)` | Collect N messages from a WebSocket |
| `waitForMessageType(ws, type)` | Wait for a specific message type |
| `closeWebSockets(...sockets)` | Graceful WebSocket cleanup |
| `cleanupSessionManager(mgr)` | Tear down a test session manager |

`src/e2e/helpers/backend-test-utils.ts`: mock infrastructure per adapter (ACP subprocess, Codex WebSocket, OpenCode HTTP+SSE). Gemini coverage uses ACP transport/helpers.

### Test utilities (library)

```ts
import { MemoryStorage, MockProcessManager } from "beamcode/testing";

const pm = new MockProcessManager();
const storage = new MemoryStorage();
const mgr = new SessionManager({ config: { port: 0 }, processManager: pm, storage });

const info = mgr.launcher.launch({ cwd: "/tmp" });
pm.lastProcess.resolveExit(0);
```

### Manual testing

```bash
pnpm build
node dist/bin/beamcode.mjs --no-tunnel

# Health check
curl http://localhost:9414/health

# Custom port
node dist/bin/beamcode.mjs --no-tunnel --port 8080

# With tunnel (requires cloudflared)
node dist/bin/beamcode.mjs
```

`Ctrl+C` once for graceful shutdown (kills CLI processes, closes WebSockets, releases lock file). `Ctrl+C` twice to force exit.

### Coverage

```bash
pnpm vitest run --coverage        # backend → ./coverage/
cd web && pnpm vitest run --coverage  # frontend → ./web/coverage/
```
