# beamcode

Code from anywhere. Collaborate on any agent session. Drive Claude, Codex, Goose, or any CLI agent from your phone, tablet, or laptop — and let teammates watch, join, and catch up in real time.

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                                                                     │
  │   Your desktop                    You (phone on the couch)          │
  │   ┌─────────────┐                ┌──────────┐                       │
  │   │ Claude Code │                │ Mobile   │                       │
  │   │ (running)   │                │ Browser  │◄── E2E encrypted      │
  │   └──────┬──────┘                └────┬─────┘    via CF Tunnel      │
  │          │                            │                             │
  │          │   ┌────────────────────────┤                             │
  │          │   │                        │                             │
  │          ▼   ▼                        │                             │
  │   ┌──────────────┐                    │  Teammate        Observer   │
  │   │SessionBridge │◄───────────────────┤  ┌──────────┐  ┌─────────┐  │
  │   │fan-out,      │                    └──│ Laptop   │  │ Audit   │  │
  │   │RBAC, replay  │◄──────────────────────│ (collab) │  │ (watch) │  │
  │   └──────────────┘                       └──────────┘  └─────────┘  │
  │                                                                     │
  │   N consumers ↔ 1 agent session (not 1:1 like everything else)      │
  └─────────────────────────────────────────────────────────────────────┘
```

## Why this matters

There are 30+ projects in this space — Companion, Happy, ClaudeCodeUI, Opcode, CUI, and others. They all share two limitations:

1. **1:1 sessions** — one frontend, one CLI backend. No collaboration.
2. **SSH/tmux/Tailscale plumbing** — remote access is a DIY stack, not a product.

BeamCode solves both.

**Code from anywhere** — Cloudflare Tunnel + E2E encryption turns your desktop agent into something you can drive from any device. No open ports, no VPN, no SSH. Open a link on your phone and you're in.

**Collaborate on the same session** — BeamCode's session-bridge is N:1, not 1:1:

- **N consumers per session** — `Map<WebSocket, ConsumerIdentity>`, not a single slot
- **Role gating** — participants drive, observers watch (PARTICIPANT_ONLY message types)
- **Fan-out broadcasts** — every consumer gets every message, filtered by role
- **Presence** — everyone sees who joins and leaves in real time
- **History replay** — late joiners catch up from message history
- **Protocol-agnostic** — same multi-consumer model whether the backend is Claude, Goose, Codex, or Agent SDK

This unlocks scenarios no existing tool supports:

| Scenario | How it works |
|----------|-------------|
| **Code from the couch** | Start Claude on your desktop, drive it from your phone via encrypted tunnel |
| **Pair programming with AI** | One person drives Claude, others observe and learn |
| **Real-time code review** | Reviewer watches the agent work, sees permission requests live |
| **Teaching / onboarding** | Instructor drives, students observe the full agent workflow |
| **Audit trail** | Security observer watches agent actions without ability to interfere |

## How it works

```
┌──────────────────────────────────────────────────────────┐
│                       CONSUMERS                          │
│  Mobile Browser │ Web UI │ Telegram │ Discord │ Terminal │
└────────┬────────────┬──────────┬─────────┬───────────────┘
         └────────────┴────┬─────┴─────────┘
                           │
                Consumer Protocol (JSON/WS)
                           │
           ┌───────────────┴────────────────┐
           │         SessionBridge          │
           │  ┌───────────┐ ┌────────────┐  │
           │  │ Session   │ │ Consumer   │  │
           │  │ Store     │ │ Broadcaster│  │
           │  ├───────────┤ ├────────────┤  │
           │  │ Consumer  │ │ SlashCmd   │  │
           │  │ Gatekeeper│ │ Registry   │  │
           │  ├───────────┤ ├────────────┤  │
           │  │ TeamEvent │ │ Structured │  │
           │  │ Differ    │ │ Logger     │  │
           │  └───────────┘ └────────────┘  │
           └───────────────┬────────────────┘
                           │
                 BackendAdapter interface
                           │
     ┌────────┬────────────┼────────────┬────────┐
     │        │            │            │        │
  SdkUrl    ACP        Codex      AgentSdk    PTY
  Adapter   Adapter    Adapter    Adapter    (fallback)
     │        │            │            │        │
  Claude   Goose       Codex      Claude     Any CLI
  Code     Kiro        CLI        Code
  --sdk-   Gemini      (OpenAI)   SDK
  url      Cline
           25+ agents
```

## Features

- **Multi-consumer sessions**: N frontends per session with fan-out, RBAC, presence, and history replay
- **Multi-agent support**: Adapters for Claude Code (`--sdk-url`), ACP (25+ agents), Codex CLI (JSON-RPC), and Claude Agent SDK
- **Web consumer**: React 19 + Zustand + Tailwind v4 app with companion-style UI (sidebar, status bar, agent pane, toast notifications, process logs)
- **Team coordination**: Agent team members, tasks, and events with real-time UI
- **E2E encryption**: libsodium sealed boxes (XSalsa20-Poly1305) with pairing link key exchange
- **Daemon**: Process supervisor with lock file, state persistence, health checks, and signal handling
- **Relay**: Cloudflare Tunnel integration for remote access without open ports
- **Reconnection**: Sequenced messages with replay from `last_seen_seq` on reconnect
- **Pluggable auth**: Transport-agnostic `Authenticator` interface (JWT, API keys, cookies, mTLS)
- **Permission signing**: HMAC-SHA256 with nonce + timestamp to prevent replay attacks
- **Session persistence**: Atomic JSON file storage with debounced writes and schema versioning
- **Production hardened**: Rate limiting, circuit breaker, backpressure, structured error types, structured logging

## Requirements

- Node.js >= 22.0.0
- A coding agent CLI installed (Claude Code, Codex, Gemini CLI, Goose, etc.)
- For relay: `cloudflared` binary in PATH
- For PTY commands: optional `node-pty` peer dependency

## Installation

```sh
npm install beamcode
# or
pnpm add beamcode
```

## Quick Start

### Claude Code via `--sdk-url`

The `SdkUrlAdapter` spawns Claude Code with `--sdk-url` and bridges its NDJSON WebSocket stream:

```ts
import {
  SessionManager,
  NodeProcessManager,
  NodeWebSocketServer,
  FileStorage,
} from "beamcode";
import { tmpdir } from "node:os";
import { join } from "node:path";

const manager = new SessionManager({
  config: { port: 3456 },
  processManager: new NodeProcessManager(),
  server: new NodeWebSocketServer({ port: 3456 }),
  storage: new FileStorage(join(tmpdir(), "beamcode-sessions")),
});

await manager.start();

const { sessionId } = manager.launcher.launch({ cwd: "/my/project" });

manager.on("cli:connected", ({ sessionId }) => {
  console.log(`CLI connected: ${sessionId}`);
});

manager.on("permission:requested", ({ sessionId, request }) => {
  manager.bridge.sendPermissionResponse(sessionId, request.request_id, "allow");
});

// Send messages programmatically (no WebSocket consumer needed)
manager.bridge.sendUserMessage(sessionId, "Write a hello world in TypeScript");

manager.on("message:outbound", ({ sessionId, message }) => {
  if (message.type === "assistant") console.log(message.content);
});

await manager.stop();
```

### Any ACP Agent (Goose, Kiro, Gemini CLI, Cline, ...)

The `ACPAdapter` speaks JSON-RPC 2.0 over stdio — one adapter covers every ACP-compliant agent:

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

### Codex CLI (JSON-RPC)

```ts
import { CodexAdapter } from "beamcode/adapters/codex";

const adapter = new CodexAdapter({
  command: "codex",
  args: ["app-server"],
});

const session = await adapter.connect({ sessionId: "my-session" });
```

### Claude Agent SDK (In-Process)

```ts
import { AgentSdkAdapter } from "beamcode/adapters/agent-sdk";

const adapter = new AgentSdkAdapter({
  // Uses @anthropic-ai/claude-agent-sdk under the hood
  model: "claude-sonnet-4-5-20250929",
  permissionMode: "default",
});

const session = await adapter.connect({ sessionId: "my-session" });
```

## Architecture

### BackendAdapter Interface

Every coding agent backend implements a single interface:

```ts
interface BackendAdapter {
  readonly name: string;                        // "sdk-url" | "acp" | "codex" | "agent-sdk"
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
// Core extensions
interface Interruptible { interrupt(): void }
interface Configurable { setModel(m: string): void; setPermissionMode(m: string): void }
interface PermissionHandler { respondToPermission(id: string, behavior: "allow" | "deny"): void }

// Relay extensions
interface Reconnectable { replay(fromSeq: number): AsyncIterable<UnifiedMessage> }
interface Encryptable { encrypt(msg: UnifiedMessage): EncryptedEnvelope }
```

### Adapter Comparison

| Adapter | Protocol | Agents | Streaming | Permissions | Session Resume |
|---------|----------|--------|-----------|-------------|----------------|
| SdkUrl | NDJSON/WebSocket | Claude Code | Yes | Yes | Yes |
| ACP | JSON-RPC 2.0/stdio | 25+ (Goose, Kiro, Gemini, Cline, ...) | No | Yes | Varies |
| Codex | JSON-RPC/NDJSON | Codex CLI | Yes | Yes | Yes |
| AgentSdk | In-process TS | Claude Code (via SDK) | Yes | Yes (callback bridge) | Yes |

### SessionBridge

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

### UnifiedMessage

All adapters translate to/from `UnifiedMessage` — a normalized envelope aligned with the Claude Agent SDK's `SDKMessage` types:

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

### Daemon

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
// Daemon runs: lock file, state file, health check loop,
// child process supervisor, local control API on 127.0.0.1
```

Components:
- **ChildProcessSupervisor**: Manages CLI child processes (spawn, kill, PID tracking)
- **LockFile**: `O_CREAT | O_EXCL` exclusive lock prevents duplicate daemons
- **StateFile**: `{ pid, port, heartbeat, version }` for CLI discovery
- **ControlApi**: HTTP on `127.0.0.1:0` for session CRUD
- **SignalHandler**: Graceful shutdown on SIGTERM/SIGINT
- **HealthCheck**: Periodic liveness loop

### Relay + E2E Encryption

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

### Reconnection

Sequenced messages survive network drops:

```ts
import type { SequencedMessage } from "beamcode";

// Each message carries a sequence number
// { seq: 42, timestamp: 1234567890, payload: ConsumerMessage }

// On reconnect, consumer sends last_seen_seq
// Server replays missed messages from buffer
```

### Web Consumer

A React 19 + Zustand + Tailwind v4 app in `web/` that builds to a single HTML file (~300 KB, ~94 KB gzip):

- **Companion-style layout**: collapsible sidebar with session grouping, status bar, agent pane
- **Multi-adapter visibility**: adapter badges per session (Claude Code, Codex, Gemini CLI, etc.)
- **Rich message rendering**: 3-level grouping (content-block, message, subagent), markdown via `marked` + DOMPurify
- **Streaming UX**: blinking cursor, elapsed time, token count
- **Slash command menu**: categorized typeahead with keyboard navigation
- **Permission UI**: tool-specific previews (Bash commands, Edit diffs, file paths)
- **Observability**: context gauge, circuit breaker status, toast notifications, process log viewer
- **Team coordination**: task panel, agent grid, member presence
- **Reconnection**: WebSocket connect-on-switch pattern with message replay

#### Development

Two terminals:

```sh
# Terminal 1: Start the beamcode server
pnpm start                    # Runs on :3456

# Terminal 2: Start the Vite dev server with HMR
pnpm dev:web                  # Runs on :5174, proxies /ws and /api to :3456
```

Open `http://localhost:5174` for live development with hot module replacement.

#### Building

```sh
pnpm build:web                # Builds web/ → single HTML file in web/dist/
pnpm build                    # Builds library + web consumer, copies to dist/consumer/
```

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

  // Slash commands (PTY-based)
  slashCommand?: {
    ptyTimeoutMs: number;                   // default: 30000
    ptySilenceThresholdMs: number;          // default: 3000
    ptyEnabled: boolean;                    // default: true
  };

  // Security
  envDenyList?: string[];                   // always includes LD_PRELOAD, DYLD_INSERT_LIBRARIES, NODE_OPTIONS
}
```

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

## Testing

```ts
import { MemoryStorage, MockProcessManager } from "beamcode/testing";

const pm = new MockProcessManager();
const storage = new MemoryStorage();
const mgr = new SessionManager({ config: { port: 0 }, processManager: pm, storage });

const info = mgr.launcher.launch({ cwd: "/tmp" });
pm.lastProcess.resolveExit(0);
```

## Security

- **E2E encryption**: libsodium sealed boxes (XSalsa20-Poly1305) — relay cannot read message contents
- **Permission signing**: HMAC-SHA256 + nonce + timestamp prevents replay
- **Session revocation**: `revoke-device` generates new keypair, forces re-pairing
- **Binary validation**: `claudeBinary` must be a basename or absolute path (no `../`)
- **Env deny list**: `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS` always blocked
- **Session IDs**: Must be lowercase UUIDs; path traversal prevented via `safeJoin`
- **Rate limiting**: Token bucket per consumer (configurable)
- **Circuit breaker**: Sliding window prevents CLI restart cascades
- **Structured errors**: `BeamCodeError` hierarchy with error codes and cause chains

See [SECURITY.md](./SECURITY.md) for the full threat model and cryptographic details.

## Documentation

- [API Reference](./API_REFERENCE.md) — Complete API documentation
- [Backend Adapter Guide](./docs/adapters/backend-adapter-guide.md) — How to write a custom adapter
- [Architecture](./docs/architecture/universal-adapter-layer.md) — Vision, competitive landscape, protocol details
- [Architecture Diagram](./docs/architecture/architecture-diagram.md) — Visual system architecture
- [Implementation Plan](./docs/plans/2026-02-15-beamcode-implementation-plan.md) — Phase-by-phase plan
- [ACP Research](./docs/research/acp-research-notes.md) — Agent Client Protocol investigation

## License

MIT
