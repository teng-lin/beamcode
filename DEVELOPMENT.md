# Development

Architecture reference, adapter guide, configuration, testing, and build.

## Table of Contents

- [Architecture](#architecture)
- [BackendAdapter Interface](#backendadapter-interface)
- [Adapters](#adapters)
- [SessionBridge](#sessionbridge)
- [UnifiedMessage](#unifiedmessage)
- [Daemon](#daemon)
- [Relay + E2E Encryption](#relay--e2e-encryption)
- [Reconnection](#reconnection)
- [Configuration](#configuration)
- [Events](#events)
- [Authentication](#authentication)
- [Testing](#testing)
- [Building](#building)

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                 HTTP + WS SERVER (:3456)                  │
│                                                          │
│  /api/sessions   REST CRUD                               │
│  /               Serves React web UI                     │
│  /ws/consumer/:id  Consumer WebSocket endpoint           │
└──────────────────────────────┬───────────────────────────┘
                               │
              ConsumerMessage (30+ subtypes, typed union)
              InboundMessage  (user_message, interrupt, ...)
                               │
                               ▼
┌──────────────────────────────────────────────────────────┐
│              core/ — SessionBridge + Modules             │
│                                                          │
│  SessionBridge (orchestrator, TypedEventEmitter)         │
│  ├── SessionStore        session CRUD + persistence      │
│  ├── ConsumerBroadcaster WS fan-out, backpressure, RBAC  │
│  ├── ConsumerGatekeeper  auth, rate limiting             │
│  ├── SlashCommandExecutor per-session command dispatch   │
│  └── TeamEventDiffer     pure team state diff            │
│                                                          │
│  SessionManager orchestrates SessionBridge + launchers   │
└──────────────────────────────┬───────────────────────────┘
                               │
                     BackendAdapter interface
                               │
              ┌────────────────┼────────────────┐
              │                │                │
           Claude            ACP             Codex
           Adapter           Adapter         Adapter
```

---

## BackendAdapter Interface

Every coding agent backend implements a single interface:

```ts
interface BackendAdapter {
  readonly name: string;                        // "claude" | "acp" | "codex"
  readonly capabilities: BackendCapabilities;
  connect(options: ConnectOptions): Promise<BackendSession>;
}

interface BackendSession {
  readonly sessionId: string;
  send(message: UnifiedMessage): void;
  readonly messages: AsyncIterable<UnifiedMessage>;
  close(): Promise<void>;
}
```

Sessions can optionally implement extension interfaces via runtime type narrowing:

```ts
interface Interruptible    { interrupt(): void }
interface Configurable     { setModel(m: string): void; setPermissionMode(m: string): void }
interface PermissionHandler { respondToPermission(id: string, behavior: "allow" | "deny"): void }
interface Reconnectable    { replay(fromSeq: number): AsyncIterable<UnifiedMessage> }
interface Encryptable      { encrypt(msg: UnifiedMessage): EncryptedEnvelope }
```

---

## Adapters

### Adapter Comparison

| Adapter | Protocol | Agents | Streaming | Permissions | Session Resume |
|---------|----------|--------|-----------|-------------|----------------|
| Claude | NDJSON/WebSocket | Claude Code | Yes | Yes | Yes |
| ACP | JSON-RPC 2.0/stdio | 25+ (Goose, Kiro, Gemini, Cline, ...) | No | Yes | Varies |
| Codex | JSON-RPC/WebSocket | Codex CLI | Yes | Yes | Yes |

### Claude Code via `--sdk-url`

Spawns `claude --sdk-url ws://...` and bridges its NDJSON WebSocket stream:

```ts
import { ClaudeAdapter } from "beamcode";
// Used automatically when adapter: "claude" in session config
```

### ACP (Agent Client Protocol)

JSON-RPC 2.0 over stdio — one adapter covers every ACP-compliant agent:

```ts
import { ACPAdapter } from "beamcode/adapters/acp";

const adapter = new ACPAdapter({
  name: "acp",
  command: "goose",       // or "kiro-cli acp", "gemini acp", etc.
  args: ["acp"],
  capabilities: {
    streaming: false,
    permissions: true,
    slashCommands: true,
    availability: "local",
  },
});

const session = await adapter.connect({ sessionId: "my-session" });

for await (const msg of session.messages) {
  console.log(msg.type, msg);
}
```

### Codex CLI (JSON-RPC over WebSocket)

```ts
import { CodexAdapter } from "beamcode/adapters/codex";

const adapter = new CodexAdapter({
  command: "codex",
  args: ["app-server"],
});

const session = await adapter.connect({ sessionId: "my-session" });
```

---

## SessionBridge

The core message router, decomposed into focused modules:

```ts
SessionBridge (orchestrator, TypedEventEmitter)
├── SessionStore          // Session CRUD + persistence
├── ConsumerBroadcaster   // WebSocket fan-out with backpressure + role filtering
├── ConsumerGatekeeper    // Pluggable auth, RBAC, rate limiting
├── SlashCommandExecutor  // Per-session command dispatch
└── TeamEventDiffer       // Pure team state diff functions
```

Message routing: CLI messages → `translateCLI()` → `routeUnifiedMessage()` → `ConsumerBroadcaster.broadcast()` → N consumers.

---

## UnifiedMessage

All adapters translate to/from `UnifiedMessage` — a normalized envelope:

```ts
type UnifiedMessage =
  | { type: "assistant_message"; messageId: string; content: UnifiedContent[]; ... }
  | { type: "partial_message"; event: unknown; ... }
  | { type: "result"; subtype: string; cost: number; ... }
  | { type: "system_init"; sessionId: string; model: string; ... }
  | { type: "permission_request"; requestId: string; toolName: string; ... }
  | { type: "tool_progress"; toolUseId: string; toolName: string; ... }
  | { type: "error"; message: string; recoverable: boolean }
  // ... and more
```

---

## Daemon

The daemon keeps agent sessions alive while clients connect and disconnect:

```ts
import { Daemon } from "beamcode";

const daemon = new Daemon({
  port: 3456,
  storagePath: "~/.beamcode/sessions",
  lockPath: "~/.beamcode/daemon.lock",
  statePath: "~/.beamcode/daemon.state.json",
});

await daemon.start();
```

Components:
- **LockFile**: `O_CREAT | O_EXCL` exclusive lock prevents duplicate daemons
- **StateFile**: `{ pid, port, heartbeat, version }` for CLI discovery
- **HealthCheck**: Periodic liveness loop
- **SignalHandler**: Graceful shutdown on SIGTERM/SIGINT

---

## Relay + E2E Encryption

Remote access via Cloudflare Tunnel with end-to-end encryption:

```
Mobile Browser → HTTPS → CF Tunnel Edge → cloudflared → localhost → Daemon → CLI
                  ↑
          E2E encrypted: tunnel cannot read message contents
```

**Pairing flow**:
1. Daemon generates X25519 keypair, starts cloudflared tunnel
2. Prints pairing link: `https://<tunnel>/pair?pk=<base64>&fp=<fingerprint>&v=1`
3. Browser extracts daemon public key, generates own keypair
4. Browser sends its public key encrypted via sealed box
5. Both sides establish authenticated bidirectional E2E

**Wire format** — `EncryptedEnvelope`:
```ts
{ v: 1, sid: "session-id", ct: "<ciphertext>", len: 42 }
```

**Permission signing**: HMAC-SHA256 with nonce + timestamp (30s window) + request_id binding prevents replay attacks over the relay.

---

## Reconnection

Sequenced messages survive network drops:

```ts
// Each message carries a sequence number
// { seq: 42, timestamp: 1234567890, payload: ConsumerMessage }

// On reconnect, consumer sends last_seen_seq
// Server replays missed messages from buffer
```

Per-consumer backpressure: if a consumer falls behind, non-critical messages (streaming events) are dropped while critical ones (permission requests) are preserved.

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

### Bridge Events

| Event | Payload |
|-------|---------|
| `cli:connected` | `{ sessionId }` |
| `cli:disconnected` | `{ sessionId }` |
| `consumer:connected` | `{ sessionId, consumerCount, identity? }` |
| `consumer:disconnected` | `{ sessionId, consumerCount, identity? }` |
| `message:outbound` | `{ sessionId, message }` |
| `message:inbound` | `{ sessionId, message }` |
| `permission:requested` | `{ sessionId, request }` |
| `permission:resolved` | `{ sessionId, requestId, behavior }` |
| `session:closed` | `{ sessionId }` |
| `slash_command:executed` | `{ sessionId, command, source, durationMs }` |
| `error` | `{ source, error, sessionId? }` |

### Launcher Events

| Event | Payload |
|-------|---------|
| `process:spawned` | `{ sessionId, pid }` |
| `process:exited` | `{ sessionId, exitCode, uptimeMs }` |
| `process:connected` | `{ sessionId }` |
| `process:resume_failed` | `{ sessionId }` |

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
pnpm test:e2e:real:codex
pnpm test:e2e:real:gemini
pnpm test:e2e:real:opencode
```

**Real backend prerequisites:**

| Backend | Binary | Auth |
|---------|--------|------|
| claude | `claude` | `ANTHROPIC_API_KEY` or `claude auth login` |
| codex | `codex` | handled by CLI |
| gemini | `gemini-cli-a2a-server` | `GOOGLE_API_KEY` or CLI config |
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

`src/e2e/helpers/backend-test-utils.ts`: mock infrastructure per adapter (ACP subprocess, Codex WebSocket, Gemini SSE, Opencode HTTP+SSE).

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
curl http://localhost:3456/health

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

# Lint
pnpm lint
```
