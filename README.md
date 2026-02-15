# claude-code-bridge

Runtime-agnostic TypeScript library for managing [Claude Code](https://claude.ai/code) CLI sessions via the `--sdk-url` WebSocket protocol.

Provides process lifecycle management, NDJSON message bridging, session persistence, and typed event emission. Works on Node.js 22+ with adapters for any WebSocket server.

## Features

- **Runtime-agnostic**: Uses injected `ProcessManager` and `WebSocketLike` interfaces; no Bun or browser-specific APIs
- **Built-in WebSocket server**: Optional `NodeWebSocketServer` adapter handles CLI and consumer connections out of the box, or bring your own via the `WebSocketServerLike` interface
- **Pluggable authentication**: Transport-agnostic `Authenticator` interface — drop in JWT, API keys, cookies, mTLS, or any custom auth
- **Role-based access control**: `participant` (read-write) and `observer` (read-only) roles with per-message enforcement
- **Presence tracking**: Real-time consumer presence updates broadcast on connect/disconnect
- **Dual CJS/ESM**: Works with `require()` or `import`
- **Typed events**: `TypedEventEmitter` with full event map types for bridge, launcher, and manager
- **Session persistence**: JSON file storage with debounced writes; survives server restarts
- **Programmatic API**: Send messages and respond to permissions without a WebSocket consumer
- **Slash command support**: Emulates `/model`, `/status`, `/config`, `/cost`, `/context` from session state; delegates other commands to a sidecar PTY via optional `node-pty`
- **Security hardened**: UUID validation, path traversal prevention, env var deny list

## Requirements

- Node.js >= 22.0.0 (uses `Readable.toWeb()`)
- Claude Code CLI installed (`claude` in PATH, or absolute path configured)

## Installation

```sh
npm install claude-code-bridge
# or
pnpm add claude-code-bridge
```

## Quick Start

### Minimal setup with `SessionManager` + built-in WebSocket server

`SessionManager` is the recommended entry point. It wires `SessionBridge` and `CLILauncher` together automatically. Pass a `server` to handle CLI WebSocket connections out of the box:

```ts
import {
  SessionManager,
  NodeProcessManager,
  NodeWebSocketServer,
  FileStorage,
  ConsoleLogger,
} from "claude-code-bridge";
import { tmpdir } from "node:os";
import { join } from "node:path";

const manager = new SessionManager({
  config: { port: 3456 },
  processManager: new NodeProcessManager(),
  server: new NodeWebSocketServer({ port: 3456 }),
  storage: new FileStorage(join(tmpdir(), "claude-sessions")),
  logger: new ConsoleLogger("my-app"),
});

await manager.start(); // starts WebSocket server + restores persisted sessions

// Launch a session — CLI connects back automatically via ws://localhost:3456/ws/cli/:id
const { sessionId } = manager.launcher.launch({ cwd: "/my/project" });

// Listen to events
manager.on("cli:connected", ({ sessionId }) => {
  console.log(`CLI connected for ${sessionId}`);
});

manager.on("permission:requested", ({ sessionId, request }) => {
  // Prompt user, then:
  manager.bridge.sendPermissionResponse(sessionId, request.request_id, "allow");
});

// Graceful shutdown
await manager.stop();
```

### With authentication

Add a pluggable `Authenticator` to gate consumer connections. The auth layer is transport-agnostic — your implementation receives an `AuthContext` with raw transport metadata and decides what to inspect (JWT, API key, cookie, etc.):

```ts
import type { Authenticator, AuthContext, ConsumerIdentity } from "claude-code-bridge";

const authenticator: Authenticator = {
  async authenticate(context: AuthContext): Promise<ConsumerIdentity> {
    const token = (context.transport.query as Record<string, string>)?.token;
    if (!token) throw new Error("Missing token");

    const user = await verifyToken(token); // your auth logic
    return {
      userId: user.id,
      displayName: user.name,
      role: user.isAdmin ? "participant" : "observer",
    };
  },
};

const manager = new SessionManager({
  config: { port: 3456 },
  processManager: new NodeProcessManager(),
  server: new NodeWebSocketServer({ port: 3456 }),
  authenticator, // consumers connecting to /ws/consumer/:id will be authenticated
});

await manager.start();
```

Consumers connect via `ws://localhost:3456/ws/consumer/:sessionId?token=...`. Without an `authenticator`, consumers are assigned anonymous participant identities (useful for development).

### Custom WebSocket server (manual wiring)

If you need full control over routing (e.g. mixed CLI + consumer endpoints, or non-`ws` servers), skip the `server` option and wire the bridge yourself:

```ts
const manager = new SessionManager({
  config: { port: 3456 },
  processManager: new NodeProcessManager(),
  // no `server` — you handle WebSocket connections yourself
});

await manager.start();

const { sessionId } = manager.launcher.launch({ cwd: "/my/project" });

// Wire your WebSocket server to the bridge
// CLI connections:
manager.bridge.handleCLIOpen(cliSocket, sessionId);
manager.bridge.handleCLIMessage(sessionId, data);
manager.bridge.handleCLIClose(sessionId);

// Consumer connections (pass AuthContext with transport metadata):
const context = { sessionId, transport: { headers: req.headers } };
manager.bridge.handleConsumerOpen(browserSocket, context);
manager.bridge.handleConsumerMessage(browserSocket, sessionId, data);
manager.bridge.handleConsumerClose(browserSocket, sessionId);
```

### Programmatic API (no WebSocket consumer needed)

For headless usage (e.g. in an AI gateway like OpenClaw):

```ts
// Send a user message directly — no browser WebSocket needed
manager.bridge.sendUserMessage(sessionId, "Write a hello world in TypeScript");

// Listen for responses
manager.on("message:outbound", ({ sessionId, message }) => {
  if (message.type === "assistant") {
    console.log(message.content);
  }
});

// Auto-approve all tool use
manager.on("permission:requested", ({ sessionId, request }) => {
  manager.bridge.sendPermissionResponse(sessionId, request.request_id, "allow");
});
```

### Slash commands

The CLI's `local-jsx` slash commands (`/usage`, `/help`, etc.) silently no-op in headless mode (`--sdk-url`). The bridge adds a `slash_command` message type that routes through two strategies:

```ts
// Via WebSocket — consumers send:
ws.send(JSON.stringify({ type: "slash_command", command: "/model", request_id: "req-1" }));

// Consumer receives:
// { type: "slash_command_result", command: "/model", request_id: "req-1", content: "claude-sonnet-4-5-20250929", source: "emulated" }

// Programmatic API:
const result = await manager.executeSlashCommand(sessionId, "/model");
console.log(result?.content); // "claude-sonnet-4-5-20250929"
```

**Emulated commands** (instant, from SessionState): `/model`, `/status`, `/config`, `/cost`, `/context`

**Native commands** (forwarded to CLI): `/compact`, `/cost`, `/context`, `/files`, `/release-notes`

**PTY commands** (via optional `node-pty`): Any other command (e.g. `/usage`) is executed by spawning a sidecar PTY that resumes the CLI session.

To enable PTY execution, install `node-pty` and pass a `PtyCommandRunner`:

```ts
import { SessionManager, PtyCommandRunner } from "claude-code-bridge";

const manager = new SessionManager({
  config: { port: 3456 },
  processManager: new NodeProcessManager(),
  commandRunner: new PtyCommandRunner(),
});
```

## Architecture

```
                  SessionManager
                  ┌──────────────────────────────────────────────┐
                  │                                              │
                  │  WebSocketServerLike (optional)              │
                  │    ├─ CLI path:      /ws/cli/:id  ──┐        │
                  │    └─ Consumer path: /ws/consumer/:id  ──┐   │
                  │                                     │    │   │
                  │              Authenticator?         │    │   │
                  │                   │                 ▼    ▼   │
                  │  SessionBridge ◄──┴───────► CLILauncher      │
                  │    │  (RBAC + Presence)        │             │
                  │  TypedEvents              TypedEvents        │
                  │  (BridgeEventMap)        (LauncherEventMap)  │
                  └──────────────────────────────────────────────┘
```

With a `server` provided, both CLI and consumer connections are handled automatically. Without one, wire your own WebSocket server to the bridge handlers.

Consumers are authenticated via the pluggable `Authenticator` interface. Each consumer gets a `ConsumerIdentity` with a role (`participant` or `observer`). Observers can see everything but cannot send write commands.

The CLI is spawned as:
```
claude --sdk-url ws://localhost:3456/ws/cli/SESSION_ID -p ""
```

It connects back to the WebSocket server, which routes the connection to `SessionBridge`.

## API Reference

### `SessionManager`

Facade that wires `SessionBridge` and `CLILauncher` together.

```ts
const manager = new SessionManager({
  config: { port: 3456 },       // required
  processManager,                // required
  server?,                       // optional; built-in WS server (e.g. NodeWebSocketServer)
  storage?,                      // optional; enables persistence
  authenticator?,                // optional; gates consumer connections (see Authentication)
  commandRunner?,                // optional; enables PTY-based slash commands (e.g. PtyCommandRunner)
  logger?,
  gitResolver?,
  beforeSpawn?,                  // synchronous hook called before each spawn
});

manager.start(): Promise<void>  // starts server (if provided), restores storage, starts watchdog
manager.stop(): Promise<void>   // kills processes, closes sockets + server, clears timers

manager.bridge: SessionBridge    // direct access
manager.launcher: CLILauncher    // direct access

// Inherits all events from BridgeEventMap & LauncherEventMap
manager.on("cli:connected", ({ sessionId }) => {})
manager.on("permission:requested", ({ sessionId, request }) => {})
manager.on("process:exited", ({ sessionId, exitCode }) => {})
// ... see Events section
```

---

### `SessionBridge`

Bridges CLI WebSocket ↔ consumer WebSockets. Manages per-session state (message history, permissions, git info).

```ts
const bridge = new SessionBridge({ storage?, gitResolver?, authenticator?, logger?, config?, commandRunner? });

// CLI WebSocket hooks
bridge.handleCLIOpen(socket: WebSocketLike, sessionId: string): void
bridge.handleCLIMessage(sessionId: string, data: string | Buffer): void
bridge.handleCLIClose(sessionId: string): void

// Consumer WebSocket hooks (AuthContext contains sessionId + transport metadata)
bridge.handleConsumerOpen(socket: WebSocketLike, context: AuthContext): void
bridge.handleConsumerMessage(socket: WebSocketLike, sessionId: string, data: string | Buffer): void
bridge.handleConsumerClose(socket: WebSocketLike, sessionId: string): void

// Programmatic API (no consumer WebSocket needed)
bridge.sendUserMessage(sessionId, content, options?): void
bridge.sendPermissionResponse(sessionId, requestId, behavior: "allow" | "deny", options?): void
bridge.sendInterrupt(sessionId): void
bridge.sendSetModel(sessionId, model): void
bridge.sendSetPermissionMode(sessionId, mode): void
bridge.executeSlashCommand(sessionId, command): Promise<{ content, source } | null>

// Session inspection
bridge.getSession(sessionId): SessionSnapshot | undefined  // includes consumers[] with roles
bridge.getAllSessions(): SessionState[]
bridge.isCliConnected(sessionId): boolean

// Lifecycle
bridge.restoreFromStorage(): number   // call at startup
bridge.close(): void                   // closes all sockets
bridge.broadcastNameUpdate(sessionId, name): void
```

---

### `CLILauncher`

Spawns and manages Claude Code CLI subprocesses.

```ts
const launcher = new CLILauncher({
  processManager,                // required
  config,                        // required
  storage?,
  logger?,
  beforeSpawn?,                  // (sessionId, spawnOptions) => void  (sync)
});

// Launch / kill
launcher.launch(options?: LaunchOptions): SdkSessionInfo
launcher.relaunch(sessionId: string): Promise<boolean>
launcher.kill(sessionId: string): Promise<boolean>
launcher.killAll(): Promise<void>

// State
launcher.getSession(sessionId): SdkSessionInfo | undefined
launcher.listSessions(): SdkSessionInfo[]
launcher.isAlive(sessionId): boolean
launcher.setArchived(sessionId, archived: boolean): void
launcher.markConnected(sessionId): void
launcher.setCLISessionId(sessionId, cliSessionId): void
launcher.pruneExited(): number
launcher.getStartingSessions(): SdkSessionInfo[]

// Persistence
launcher.restoreFromStorage(): number
```

**`LaunchOptions`**

```ts
interface LaunchOptions {
  cwd?: string;
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  claudeBinary?: string;        // override binary; basename or absolute path only
  env?: Record<string, string>; // extra env vars (envDenyList always applied)
  allowedTools?: string[];
}
```

---

### Configuration

Pass to any of the three core classes via `config`:

```ts
interface ProviderConfig {
  port: number;                       // required — port of your WS server

  // Timeouts (ms)
  gitCommandTimeoutMs?: number;       // default: 3000
  relaunchGracePeriodMs?: number;     // default: 2000
  killGracePeriodMs?: number;         // default: 5000
  storageDebounceMs?: number;         // default: 150
  reconnectGracePeriodMs?: number;    // default: 10000
  resumeFailureThresholdMs?: number;  // default: 5000
  relaunchDedupMs?: number;           // default: 5000

  // Resource limits
  maxMessageHistoryLength?: number;   // default: 1000
  maxConcurrentSessions?: number;     // default: 50

  // CLI
  defaultClaudeBinary?: string;       // default: "claude"
  cliWebSocketUrlTemplate?: (sessionId: string) => string;

  // Slash command execution
  slashCommand?: {
    ptyTimeoutMs: number;             // default: 30000
    ptySilenceThresholdMs: number;    // default: 3000
    ptyEnabled: boolean;              // default: true
  };

  // Security
  envDenyList?: string[];             // default: ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS"]
                                      // Note: cannot be set to empty — defaults are always applied
}
```

---

### Events

**`BridgeEventMap`** (emitted by `SessionBridge` and `SessionManager`):

| Event | Payload |
|-------|---------|
| `cli:session_id` | `{ sessionId, cliSessionId }` |
| `cli:connected` | `{ sessionId }` |
| `cli:disconnected` | `{ sessionId }` |
| `cli:relaunch_needed` | `{ sessionId }` |
| `consumer:connected` | `{ sessionId, consumerCount, identity? }` |
| `consumer:disconnected` | `{ sessionId, consumerCount, identity? }` |
| `consumer:authenticated` | `{ sessionId, userId, displayName, role }` |
| `consumer:auth_failed` | `{ sessionId, reason }` |
| `message:outbound` | `{ sessionId, message: ConsumerMessage }` |
| `message:inbound` | `{ sessionId, message: InboundMessage }` |
| `permission:requested` | `{ sessionId, request: PermissionRequest }` |
| `permission:resolved` | `{ sessionId, requestId, behavior }` |
| `session:first_turn_completed` | `{ sessionId, firstUserMessage }` |
| `session:closed` | `{ sessionId }` |
| `slash_command:executed` | `{ sessionId, command, source, durationMs }` |
| `slash_command:failed` | `{ sessionId, command, error }` |
| `auth_status` | `{ sessionId, isAuthenticating, output, error? }` |
| `error` | `{ source, error, sessionId? }` |

**`LauncherEventMap`** (emitted by `CLILauncher` and `SessionManager`):

| Event | Payload |
|-------|---------|
| `process:spawned` | `{ sessionId, pid }` |
| `process:exited` | `{ sessionId, exitCode, uptimeMs }` |
| `process:connected` | `{ sessionId }` |
| `process:resume_failed` | `{ sessionId }` |
| `process:stdout` | `{ sessionId, data }` |
| `process:stderr` | `{ sessionId, data }` |
| `error` | `{ source, error, sessionId? }` |

---

### Adapters

| Class | Description |
|-------|-------------|
| `NodeProcessManager` | Spawns processes with `child_process.spawn` (Node.js 22+) |
| `NodeWebSocketServer` | WebSocket server using the `ws` package; listens on `/ws/cli/:id` and `/ws/consumer/:id` |
| `FileStorage` | JSON file persistence to a directory |
| `MemoryStorage` | In-memory storage (for tests / ephemeral use) |
| `DefaultGitResolver` | Resolves git branch/worktree info via `git` CLI |
| `PtyCommandRunner` | Executes slash commands via a sidecar PTY (requires `node-pty`) |
| `ConsoleLogger` | Logs to `console` with an optional prefix |
| `NoopLogger` | Discards all log output |

**Custom `ProcessManager`** (e.g. to use Bun):

```ts
import type { ProcessManager, ProcessHandle, SpawnOptions } from "claude-code-bridge";

class BunProcessManager implements ProcessManager {
  spawn(options: SpawnOptions): ProcessHandle {
    const proc = Bun.spawn([options.command, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      pid: proc.pid,
      exited: proc.exited.then((code) => code ?? null),
      kill: (signal = "SIGTERM") => proc.kill(signal),
      stdout: proc.stdout,
      stderr: proc.stderr,
    };
  }
  isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
}
```

---

### `WebSocketLike` interface

Any object with `.send(data: string)` and `.close(code?, reason?)` works as a socket. This covers `ws.WebSocket`, `ServerWebSocket` (Bun), browser `WebSocket`, etc.

---

### `WebSocketServerLike` interface

Abstraction for WebSocket servers that handle incoming CLI connections. Pass an implementation to `SessionManager`'s `server` option to let it manage CLI connections automatically.

```ts
interface WebSocketServerLike {
  listen(
    onCLIConnection: OnCLIConnection,
    onConsumerConnection?: OnConsumerConnection,
  ): Promise<void>;
  close(): Promise<void>;
}
```

**`NodeWebSocketServer`** is the built-in adapter for Node.js using the `ws` package:

```ts
import { NodeWebSocketServer } from "claude-code-bridge";

const server = new NodeWebSocketServer({ port: 3456, host: "0.0.0.0" });
// Pass to SessionManager as `server` option

// After listen, check the actual port (useful when port: 0):
server.port; // number | undefined
```

To support a different runtime (e.g. Bun), implement `WebSocketServerLike`:

```ts
import type { WebSocketServerLike, OnCLIConnection } from "claude-code-bridge";

class BunWebSocketServer implements WebSocketServerLike {
  async listen(onConnection: OnCLIConnection): Promise<void> {
    Bun.serve({
      port: 3456,
      fetch(req, server) {
        const url = new URL(req.url);
        const match = url.pathname.match(/^\/ws\/cli\/([^/]+)$/);
        if (match) server.upgrade(req, { data: { sessionId: match[1] } });
      },
      websocket: {
        open(ws) { onConnection(ws, ws.data.sessionId); },
        message(ws, msg) { /* handled by socket.on("message") */ },
        close(ws) { /* handled by socket.on("close") */ },
      },
    });
  }
  async close(): Promise<void> { /* shutdown logic */ }
}
```

---

### NDJSON utilities

```ts
import { parseNDJSON, serializeNDJSON, NDJSONLineBuffer } from "claude-code-bridge";

// Frame-based (WebSocket messages arrive as complete frames)
const { messages, errors } = parseNDJSON<MyType>(frameString);

// Serialize
const line = serializeNDJSON({ type: "user", content: "hello" }); // "...\n"

// Stream-based (stdout piped from a CLI process)
const buf = new NDJSONLineBuffer();
const lines = buf.feed(chunk);   // returns complete lines ready for JSON.parse
const final = buf.flush();       // any remaining data on close
buf.reset();                     // clear on reconnect
```

---

## Testing Utilities

Import from `claude-code-bridge/testing`:

```ts
import { MemoryStorage, MockProcessManager, MockCommandRunner, NoopLogger, createMockSocket } from "claude-code-bridge/testing";

const pm = new MockProcessManager();
const storage = new MemoryStorage();
const mgr = new SessionManager({ config: { port: 3456 }, processManager: pm, storage });

// Simulate a spawned process exiting
const info = mgr.launcher.launch({ cwd: "/tmp" });
pm.lastProcess.resolveExit(0);
await pm.lastProcess.exited;
```

`MockProcessManager` exposes:
- `.spawnCalls`: `SpawnOptions[]` — every call to `spawn()`
- `.spawnedProcesses`: `MockProcessHandle[]`
- `.lastProcess`: most recently spawned handle
- `handle.resolveExit(code)` — simulate process exit
- `handle.killCalls`: `string[]` — signals received

---

## Authentication & Authorization

### Authenticator interface

Implement `Authenticator` to gate consumer WebSocket connections. The interface is transport-agnostic — you receive an `AuthContext` with the target `sessionId` and a `transport` bag containing whatever metadata the WebSocket adapter provides (headers, query params, remote address, etc.):

```ts
import type { Authenticator, AuthContext, ConsumerIdentity } from "claude-code-bridge";

class JWTAuthenticator implements Authenticator {
  async authenticate(context: AuthContext): Promise<ConsumerIdentity> {
    const headers = context.transport.headers as Record<string, string>;
    const token = headers.authorization?.replace("Bearer ", "");
    if (!token) throw new Error("Missing authorization header");

    const payload = await verifyJWT(token);
    return {
      userId: payload.sub,
      displayName: payload.name,
      role: payload.admin ? "participant" : "observer",
    };
  }
}
```

Return a `ConsumerIdentity` to accept, throw to reject (socket closed with code 4001).

### Roles

| Role | Can read | Can write |
|------|----------|-----------|
| `participant` | All messages | `user_message`, `permission_response`, `interrupt`, `set_model`, `set_permission_mode`, `slash_command`, `presence_query` |
| `observer` | All messages | `presence_query` only |

Observers who attempt write operations receive an error message: `{ type: "error", message: "Observers cannot send X messages" }`.

### Consumer messages on connect

When a consumer connects successfully, it receives (in order):

1. `{ type: "identity", userId, displayName, role }` — the consumer's own identity
2. `{ type: "session_init", session }` — current session state
3. `{ type: "message_history", messages }` — conversation replay (if any)
4. `{ type: "permission_request", request }` — pending permissions (participants only)
5. `{ type: "presence_update", consumers }` — all connected consumers

### Presence

A `presence_update` message is broadcast to all consumers whenever someone connects or disconnects. Any consumer (including observers) can also send `{ type: "presence_query" }` to trigger a presence broadcast.

### Dev mode (no authenticator)

When no `authenticator` is provided, consumers are assigned anonymous participant identities (`anonymous-1`, `anonymous-2`, etc.) with full read-write access.

---

## Security Notes

- **`claudeBinary`** must be a simple basename (e.g. `"claude"`) or an absolute path. Relative paths with `../` are rejected.
- **`envDenyList`** defaults to `["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS"]` and cannot be cleared to empty (security invariant).
- **Session IDs** must be lowercase UUIDs. Non-UUID IDs are rejected at the storage layer.
- **Path traversal** is prevented in `FileStorage` via UUID validation and `safeJoin` containment checks.

## License

MIT
