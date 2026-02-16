# beamcode

Universal adapter library that bridges any coding agent CLI to any frontend — code anywhere, from any device.

```
┌──────────────────────────────────────────────────────────┐
│                       FRONTENDS                          │
│  Mobile Browser │ Web UI │ Telegram │ Discord │ Terminal │
└────────┬────────────┬──────────┬─────────┬───────────────┘
         └────────────┴────┬─────┴─────────┘
                           │
                Consumer Protocol (JSON/WS)
                           │
           ┌───────────────┴────────────────┐
           │         SessionBridge          │
           │  (state, RBAC, presence,       │
           │   history, replay, E2E)        │
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

## Problem

The coding agent landscape is fragmenting. Claude Code, Codex CLI, Gemini CLI, Goose, Kiro, and others each have different protocols, capabilities, and remote access stories. Users cobble together SSH + tmux + Tailscale to run agents on a desktop and monitor from a phone. There are 30+ bespoke projects that each solve a narrow slice. No reusable library abstracts the CLI-to-frontend boundary.

## Solution

beamcode sits between any coding agent CLI and any frontend. One `BackendAdapter` interface, four protocol implementations, structured message relay with E2E encryption, and a daemon that keeps sessions alive while you're away.

## Features

- **Multi-agent support**: Adapters for Claude Code (`--sdk-url`), ACP (25+ agents), Codex CLI (JSON-RPC), and Claude Agent SDK
- **E2E encryption**: libsodium sealed boxes (XSalsa20-Poly1305) with pairing link key exchange
- **Daemon**: Process supervisor with lock file, state persistence, health checks, and signal handling
- **Relay**: Cloudflare Tunnel integration for remote access without open ports
- **Reconnection**: Sequenced messages with replay from `last_seen_seq` on reconnect
- **RBAC**: `participant` (read-write) and `observer` (read-only) roles with per-message enforcement
- **Presence**: Real-time consumer presence updates on connect/disconnect
- **Pluggable auth**: Transport-agnostic `Authenticator` interface (JWT, API keys, cookies, mTLS)
- **Permission signing**: HMAC-SHA256 with nonce + timestamp to prevent replay attacks
- **Session persistence**: Atomic JSON file storage with debounced writes
- **Production hardened**: Rate limiting, circuit breaker, backpressure, idle timeout, graceful drain
- **Dual CJS/ESM**: Works with `require()` or `import`

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

- **3-panel responsive layout**: collapsible sidebar, chat view, task panel
- **Multi-adapter visibility**: adapter badges per session (Claude Code, Codex, Gemini CLI, etc.)
- **Rich message rendering**: 3-level grouping (content-block, message, subagent), markdown via `marked` + DOMPurify
- **Streaming UX**: blinking cursor, elapsed time, token count
- **Slash command menu**: categorized typeahead with keyboard navigation
- **Permission UI**: tool-specific previews (Bash commands, Edit diffs, file paths)
- **Context gauge**: color-coded token usage bar (green/yellow/red)
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

#### Testing the frontend

1. Verify the build produces a single HTML file under 300 KB:
   ```sh
   cd web && npx vite build && ls -lh dist/index.html
   ```

2. Run the full build pipeline:
   ```sh
   pnpm build
   ```

3. Test with a live session:
   ```sh
   pnpm start                  # Start server on :3456
   # Open http://localhost:3456 in a browser
   # Send a message, verify streamed response appears
   ```

4. Test dev workflow with HMR:
   ```sh
   pnpm start &                # Background the server
   pnpm dev:web                # Start Vite dev server
   # Open http://localhost:5174
   # Edit web/src/ files and verify HMR updates

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
