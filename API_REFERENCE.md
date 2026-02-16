# API Reference

Complete API reference for **beamcode** — the universal adapter library that bridges any coding agent CLI to any frontend.

## Table of Contents

- [Core Interfaces](#core-interfaces)
  - [BackendAdapter](#backendadapter)
  - [BackendSession](#backendsession)
  - [BackendCapabilities](#backendcapabilities)
  - [ConnectOptions](#connectoptions)
- [Extension Interfaces](#extension-interfaces)
  - [Interruptible](#interruptible)
  - [Configurable](#configurable)
  - [PermissionHandler](#permissionhandler)
  - [Reconnectable](#reconnectable)
  - [Encryptable](#encryptable)
- [UnifiedMessage](#unifiedmessage)
  - [UnifiedMessage Type](#unifiedmessage-type)
  - [UnifiedContent](#unifiedcontent)
  - [Factory & Guards](#factory--guards)
  - [Canonical Serialization](#canonical-serialization)
- [SequencedMessage](#sequencedmessage)
- [SessionManager](#sessionmanager)
- [SessionBridge](#sessionbridge)
- [SdkUrlLauncher](#sdkurllauncher)
- [Daemon](#daemon)
- [ControlApi](#controlapi)
- [Adapters](#adapters)
  - [SdkUrlAdapter](#sdkurladapter)
  - [ACPAdapter](#acpadapter)
  - [CodexAdapter](#codexadapter)
  - [AgentSdkAdapter](#agentsdkadapter)
- [Relay](#relay)
  - [EncryptionLayer](#encryptionlayer)
  - [TunnelRelayAdapter](#tunnelrelayadapter)
- [Crypto](#crypto)
  - [Key Management](#key-management)
  - [Sealed Boxes](#sealed-boxes)
  - [Authenticated Encryption](#authenticated-encryption)
  - [EncryptedEnvelope](#encryptedenvelope)
  - [HMAC Signing](#hmac-signing)
  - [PairingManager](#pairingmanager)
- [ReconnectionHandler](#reconnectionhandler)
- [Configuration](#configuration)
- [Events](#events)
- [Consumer Messages](#consumer-messages)
- [Inbound Messages](#inbound-messages)
- [Authentication](#authentication)
- [Testing Utilities](#testing-utilities)
- [Utilities](#utilities)

---

## Core Interfaces

### BackendAdapter

The contract every coding-agent backend must implement.

```typescript
import type { BackendAdapter } from "beamcode";

interface BackendAdapter {
  /** Human-readable adapter identifier (e.g. "sdk-url", "acp", "codex"). */
  readonly name: string;
  /** What this adapter supports. */
  readonly capabilities: BackendCapabilities;
  /** Open a new session (or resume an existing one). */
  connect(options: ConnectOptions): Promise<BackendSession>;
}
```

### BackendSession

A live connection to a single backend session.

```typescript
import type { BackendSession } from "beamcode";

interface BackendSession {
  /** The session identifier. */
  readonly sessionId: string;
  /** Send a message to the backend. */
  send(message: UnifiedMessage): void;
  /** Incoming messages from the backend as an async iterable. */
  readonly messages: AsyncIterable<UnifiedMessage>;
  /** Gracefully close the session. */
  close(): Promise<void>;
}
```

### BackendCapabilities

Declares what a backend adapter supports.

```typescript
import type { BackendCapabilities } from "beamcode";

interface BackendCapabilities {
  /** Whether the backend streams partial responses. */
  streaming: boolean;
  /** Whether the backend handles permission requests natively. */
  permissions: boolean;
  /** Whether the backend supports slash commands. */
  slashCommands: boolean;
  /** Where the backend can run. */
  availability: "local" | "remote" | "both";
}
```

### ConnectOptions

Adapter-agnostic options for establishing a session.

```typescript
import type { ConnectOptions } from "beamcode";

interface ConnectOptions {
  /** Target session ID to connect to (or create). */
  sessionId: string;
  /** If true, attempt to resume an existing session. */
  resume?: boolean;
  /** Adapter-specific options — each adapter defines its own shape. */
  adapterOptions?: Record<string, unknown>;
}
```

---

## Extension Interfaces

Sessions can optionally implement extension interfaces. Check for support via runtime type narrowing:

```typescript
if ("interrupt" in session) {
  session.interrupt();
}
```

### Interruptible

The session can cancel in-flight work.

```typescript
interface Interruptible {
  interrupt(): void;
}
```

### Configurable

The session supports runtime configuration changes.

```typescript
interface Configurable {
  setModel(model: string): void;
  setPermissionMode(mode: string): void;
}
```

### PermissionHandler

The session can surface and resolve permission requests.

```typescript
interface PermissionHandler {
  /** Incoming permission requests as an async iterable. */
  readonly permissionRequests: AsyncIterable<PermissionRequestEvent>;
  /** Respond to a pending permission request. */
  respondToPermission(requestId: string, behavior: "allow" | "deny"): void;
}

interface PermissionRequestEvent {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
}
```

### Reconnectable

The session can recover from disconnections.

```typescript
interface Reconnectable {
  /** Register a callback for disconnect events. */
  onDisconnect(callback: () => void): void;
  /** Replay messages from a given sequence number. */
  replay(fromSeq: number): AsyncIterable<UnifiedMessage>;
}
```

### Encryptable

The session supports end-to-end encryption.

```typescript
interface Encryptable {
  encrypt(message: UnifiedMessage): EncryptedEnvelope;
  decrypt(envelope: EncryptedEnvelope): UnifiedMessage;
}

interface EncryptedEnvelope {
  ciphertext: string;   // base64
  iv: string;           // base64
  algorithm: string;
}
```

---

## UnifiedMessage

All adapters translate to/from `UnifiedMessage` — a normalized envelope aligned with the Claude Agent SDK's `SDKMessage` types.

### UnifiedMessage Type

```typescript
import type { UnifiedMessage, UnifiedMessageType, UnifiedRole } from "beamcode";

type UnifiedMessageType =
  | "session_init"
  | "status_change"
  | "assistant"
  | "result"
  | "stream_event"
  | "permission_request"
  | "control_response"
  | "tool_progress"
  | "tool_use_summary"
  | "auth_status"
  | "user_message"
  | "permission_response"
  | "interrupt"
  | "configuration_change"
  | "unknown";

type UnifiedRole = "user" | "assistant" | "system" | "tool";

interface UnifiedMessage {
  /** Unique message ID (UUID v4). */
  id: string;
  /** Unix epoch milliseconds. */
  timestamp: number;
  /** Semantic message type. */
  type: UnifiedMessageType;
  /** Sender role. */
  role: UnifiedRole;
  /** Rich content blocks (primarily for assistant messages). */
  content: UnifiedContent[];
  /** Arbitrary key-value data carrier — the primary payload for most types. */
  metadata: Record<string, unknown>;
  /** Optional parent message ID for threading. */
  parentId?: string;
}
```

### UnifiedContent

Discriminated union for message content blocks.

```typescript
import type {
  UnifiedContent,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  CodeContent,
  ImageContent,
} from "beamcode";

type UnifiedContent =
  | TextContent
  | ToolUseContent
  | ToolResultContent
  | CodeContent
  | ImageContent;

interface TextContent { type: "text"; text: string }
interface ToolUseContent { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
interface ToolResultContent { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
interface CodeContent { type: "code"; language: string; code: string }
interface ImageContent { type: "image"; source: { type: "base64"; media_type: string; data: string } }
```

### Factory & Guards

```typescript
import {
  createUnifiedMessage,
  isUnifiedMessage,
  isTextContent,
  isToolUseContent,
  isToolResultContent,
  isCodeContent,
  isImageContent,
} from "beamcode";

// Create a message with auto-generated UUID and timestamp
const msg = createUnifiedMessage({
  type: "user_message",
  role: "user",
  content: [{ type: "text", text: "Hello" }],
  metadata: {},
});

// Runtime validation
isUnifiedMessage(value);  // => boolean

// Content type guards
isTextContent(block);        // => block is TextContent
isToolUseContent(block);     // => block is ToolUseContent
isToolResultContent(block);  // => block is ToolResultContent
isCodeContent(block);        // => block is CodeContent
isImageContent(block);       // => block is ImageContent
```

### Canonical Serialization

RFC 8785 (JSON Canonicalization Scheme) for deterministic serialization, used by HMAC signing.

```typescript
import { canonicalize } from "beamcode";

const json = canonicalize({ b: 2, a: 1 });
// => '{"a":1,"b":2}' — keys sorted by Unicode code-point order
```

---

## SequencedMessage

Transport-level wrapper for reconnection replay and backpressure.

```typescript
import type { SequencedMessage } from "beamcode";

interface SequencedMessage<T> {
  /** Monotonically increasing sequence number (1-based). */
  seq: number;
  /** Unique message identifier. */
  message_id: string;
  /** Unix epoch milliseconds when sequenced. */
  timestamp: number;
  /** The wrapped payload. */
  payload: T;
}
```

The `MessageSequencer<T>` class assigns sequence numbers:

```typescript
import { MessageSequencer } from "beamcode/core/types/sequenced-message";

const sequencer = new MessageSequencer<ConsumerMessage>();
const seqMsg = sequencer.next(consumerMessage);
// seqMsg.seq === 1
sequencer.currentSeq; // => 1
sequencer.reset();    // => counter back to 0
```

---

## SessionManager

Main facade that combines SessionBridge (consumer/CLI connections) and SdkUrlLauncher (CLI process management).

```typescript
import {
  SessionManager,
  NodeProcessManager,
  NodeWebSocketServer,
  FileStorage,
} from "beamcode";

const manager = new SessionManager({
  config: { port: 3456 },
  processManager: new NodeProcessManager(),
  server: new NodeWebSocketServer({ port: 3456 }),
  storage: new FileStorage("/path/to/sessions"),
  logger: new ConsoleLogger(),           // optional
  authenticator: myAuthenticator,         // optional
  beforeSpawn: (sid, opts) => { ... },    // optional hook
  commandRunner: new PtyCommandRunner(),  // optional, enables PTY slash commands
});
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `start()` | `async start(): Promise<void>` | Initialize: wire events, restore from storage, start WebSocket server |
| `stop()` | `async stop(): Promise<void>` | Graceful shutdown: drain consumers, kill CLI processes, persist state |
| `getSessionStats(id)` | `getSessionStats(sessionId: string): SessionStats \| undefined` | Real-time stats for a session |
| `getAllSessionStats()` | `getAllSessionStats(): SessionStats[]` | Stats for all active sessions |

### SessionStats

```typescript
interface SessionStats {
  sessionId: string;
  consumers: number;
  messageCount: number;
  uptime: number;           // milliseconds
  lastActivity: number;     // Unix timestamp
  cliConnected: boolean;
  pendingPermissions: number;
  queuedMessages: number;
}
```

### Example

```typescript
await manager.start();

const { sessionId } = manager.launcher.launch({ cwd: "/my/project" });

manager.on("cli:connected", ({ sessionId }) => {
  console.log(`CLI connected: ${sessionId}`);
});

manager.on("permission:requested", ({ sessionId, request }) => {
  manager.bridge.sendPermissionResponse(sessionId, request.request_id, "allow");
});

manager.bridge.sendUserMessage(sessionId, "Write a hello world in TypeScript");

manager.on("message:outbound", ({ sessionId, message }) => {
  if (message.type === "assistant") console.log(message.message.content);
});

await manager.stop();
```

---

## SessionBridge

Bridges consumer WebSocket connections to backend CLI connections. Handles message routing, RBAC enforcement, permission management, presence tracking, and message history.

```typescript
import { SessionBridge } from "beamcode";
```

### Key Methods

| Method | Description |
|--------|-------------|
| `sendUserMessage(sessionId, content, images?)` | Send a user message to the CLI |
| `sendPermissionResponse(sessionId, requestId, behavior, options?)` | Respond to a permission request |
| `interruptSession(sessionId)` | Interrupt the current CLI turn |
| `closeSession(sessionId, reason?)` | Close a session and disconnect consumers |
| `getSessionState(sessionId)` | Get the current session state |

---

## SdkUrlLauncher

Manages Claude Code CLI processes launched with `--sdk-url`. Extends `ProcessSupervisor` with SdkUrl-specific logic: argument construction, binary validation, environment deny list, session state tracking.

```typescript
import { SdkUrlLauncher } from "beamcode";
import type { SdkUrlLauncherOptions } from "beamcode";
```

### Constructor

```typescript
interface SdkUrlLauncherOptions {
  processManager: ProcessManager;
  config: ProviderConfig;
  storage?: LauncherStateStorage;
  logger?: Logger;
  beforeSpawn?: (sessionId: string, spawnOptions: SpawnOptions) => void;
}
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `launch(options?)` | `launch(options?: LaunchOptions): SdkSessionInfo` | Launch a new CLI session |
| `relaunch(sessionId)` | `async relaunch(sessionId: string): Promise<boolean>` | Relaunch an existing session (with `--resume`) |
| `kill(sessionId)` | `async kill(sessionId: string): Promise<boolean>` | Kill a session's CLI process (SIGTERM → SIGKILL) |
| `killAll()` | `async killAll(): Promise<void>` | Kill all active sessions |
| `markConnected(sessionId)` | `markConnected(sessionId: string): void` | Mark session as connected (called on WebSocket handshake) |
| `setCLISessionId(sessionId, cliSessionId)` | `setCLISessionId(sessionId: string, cliSessionId: string): void` | Store CLI's internal session ID for resume |
| `restoreFromStorage()` | `restoreFromStorage(): number` | Restore sessions from storage, returns count recovered |
| `listSessions()` | `listSessions(): SdkSessionInfo[]` | List all sessions |
| `getSession(sessionId)` | `getSession(sessionId: string): SdkSessionInfo \| undefined` | Get a specific session |
| `isAlive(sessionId)` | `isAlive(sessionId: string): boolean` | Check if session is alive |
| `removeSession(sessionId)` | `removeSession(sessionId: string): void` | Remove a session from internal maps |
| `pruneExited()` | `pruneExited(): number` | Remove exited sessions, returns count pruned |

### LaunchOptions

```typescript
interface LaunchOptions {
  cwd?: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  claudeBinary?: string;
  env?: Record<string, string | undefined>;
}
```

### SdkSessionInfo

```typescript
interface SdkSessionInfo {
  sessionId: string;
  state: "starting" | "connected" | "running" | "exited";
  model?: string;
  permissionMode?: string;
  cwd: string;
  createdAt: number;
  pid?: number;
  exitCode?: number | null;
  cliSessionId?: string;
  archived?: boolean;
}
```

---

## Daemon

Process supervisor daemon with exclusive lock file, state persistence, health checks, and signal handling.

```typescript
import { Daemon } from "beamcode/daemon";
```

### Constructor & Options

```typescript
interface DaemonOptions {
  /** Base directory for runtime files. Default: ~/.beamcode/ */
  dataDir?: string;
  /** Port for the control API. Default: 0 (random). */
  port?: number;
}
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `start(options?)` | `async start(options?: DaemonOptions): Promise<{ port: number; controlApiToken: string }>` | Acquire lock, write state, start health check, register signal handlers |
| `stop()` | `async stop(): Promise<void>` | Release lock, clean up state file, stop health check |
| `isRunning()` | `isRunning(): boolean` | Whether the daemon is running |

### Example

```typescript
const daemon = new Daemon();
const { port, controlApiToken } = await daemon.start({
  dataDir: "~/.beamcode",
  port: 0,
});

console.log(`Daemon running, control API on port ${port}`);

// On shutdown
await daemon.stop();
```

### Components

| Component | Export | Description |
|-----------|--------|-------------|
| `ChildProcessSupervisor` | `beamcode/daemon` | Manages CLI child processes (spawn, kill, PID tracking, session count) |
| `LockFile` | `acquireLock()`, `releaseLock()` | `O_CREAT \| O_EXCL` exclusive lock prevents duplicate daemons |
| `StateFile` | `writeState()`, `readState()` | `{ pid, port, heartbeat, version, controlApiToken }` for discovery |
| `HealthCheck` | `startHealthCheck()` | 60-second heartbeat loop updating state file |
| `SignalHandler` | `registerSignalHandlers()` | Graceful shutdown on SIGTERM/SIGINT |

---

## ControlApi

HTTP control API for the daemon. Binds to `127.0.0.1:0` (random port, localhost only). All endpoints require Bearer token authentication.

```typescript
import { ControlApi } from "beamcode/daemon";
```

### Constructor

```typescript
interface ControlApiOptions {
  supervisor: ChildProcessSupervisor;
  token: string;
  startedAt?: number;
}
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `listen()` | `async listen(): Promise<number>` | Start listening, returns assigned port |
| `close()` | `async close(): Promise<void>` | Stop the HTTP server |

### Endpoints

All endpoints require `Authorization: Bearer <token>` header.

#### `GET /health`

Returns daemon health status.

```json
{
  "status": "ok",
  "uptime": 3600000,
  "sessions": 3
}
```

#### `GET /sessions`

List all managed sessions.

#### `POST /sessions`

Create a new session. Requires `Content-Type: application/json` body with `cwd` field.

```json
{ "cwd": "/path/to/project" }
```

**Response:** `201 Created` with session info.

#### `DELETE /sessions/:id`

Stop a session by ID.

**Response:** `200 OK` with `{ "status": "stopped", "sessionId": "..." }`.

---

## Adapters

### SdkUrlAdapter

Bridges Claude Code via `--sdk-url` NDJSON/WebSocket protocol.

```typescript
import { SdkUrlLauncher } from "beamcode";
```

Capabilities: `{ streaming: true, permissions: true, slashCommands: true, availability: "local" }`

### ACPAdapter

JSON-RPC 2.0 over stdio for any ACP-compliant agent (Goose, Kiro, Gemini CLI, Cline, OpenHands, 25+ agents).

```typescript
import { ACPAdapter } from "beamcode/adapters/acp";

const adapter = new ACPAdapter({
  name: "acp",
  command: "goose",
  args: ["acp"],
  capabilities: {
    streaming: false,
    permissions: true,
    slashCommands: true,
    availability: "local",
  },
});

const session = await adapter.connect({ sessionId: "my-session" });
```

Capabilities: `{ streaming: false, permissions: true, slashCommands: true, availability: "local" }`

### CodexAdapter

JSON-RPC over subprocess stdio for Codex CLI in `app-server` mode.

```typescript
import { CodexAdapter } from "beamcode/adapters/codex";

const adapter = new CodexAdapter({
  command: "codex",
  args: ["app-server"],
});

const session = await adapter.connect({ sessionId: "my-session" });
```

Capabilities: `{ streaming: true, permissions: true, slashCommands: false, availability: "local" }`

### AgentSdkAdapter

In-process adapter using `@anthropic-ai/claude-agent-sdk`.

```typescript
import { AgentSdkAdapter } from "beamcode/adapters/agent-sdk";

const adapter = new AgentSdkAdapter({
  model: "claude-sonnet-4-5-20250929",
  permissionMode: "default",
});

const session = await adapter.connect({ sessionId: "my-session" });
```

Capabilities: `{ streaming: true, permissions: true, slashCommands: false, availability: "both" }`

### Adapter Comparison

| Adapter | Protocol | Agents | Streaming | Permissions | Session Resume |
|---------|----------|--------|-----------|-------------|----------------|
| SdkUrl | NDJSON/WebSocket | Claude Code | Yes | Yes | Yes |
| ACP | JSON-RPC 2.0/stdio | 25+ (Goose, Kiro, Gemini, Cline, ...) | No | Yes | Varies |
| Codex | JSON-RPC/NDJSON | Codex CLI | Yes | Yes | Yes |
| AgentSdk | In-process TS | Claude Code (via SDK) | Yes | Yes (callback bridge) | Yes |

---

## Relay

### EncryptionLayer

Middleware that transparently encrypts/decrypts messages between the SessionBridge and WebSocket transport.

```typescript
import { EncryptionLayer } from "beamcode/relay";
```

#### Constructor

```typescript
interface EncryptionLayerOptions {
  /** Our keypair (daemon or consumer side). */
  keypair: KeyPair;
  /** The peer's public key (established during pairing). */
  peerPublicKey: Uint8Array;
  /** Session ID for the envelope routing field. */
  sessionId: string;
}
```

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `encryptOutbound(message)` | `async encryptOutbound(message: ConsumerMessage): Promise<string>` | Encrypt a ConsumerMessage into a serialized EncryptedEnvelope |
| `decryptInbound(data)` | `async decryptInbound(data: string \| Buffer): Promise<InboundMessage>` | Decrypt raw WebSocket data into an InboundMessage |
| `isActive()` | `isActive(): boolean` | Whether the encryption layer is active |
| `deactivate()` | `deactivate(): void` | Deactivate (e.g., after revocation) |
| `updatePeerKey(key)` | `updatePeerKey(peerPublicKey: Uint8Array): void` | Update peer's public key (e.g., after re-pairing) |
| `isEncrypted(data)` | `static isEncrypted(data: string \| Buffer): boolean` | Detect if raw data is an encrypted envelope |

#### Data Flow

```
Outbound: ConsumerMessage → serialize → encrypt → EncryptedEnvelope (string)
Inbound:  EncryptedEnvelope (string|Buffer) → decrypt → deserialize → InboundMessage
```

### TunnelRelayAdapter

Wraps `CloudflaredManager` with start/stop semantics for Cloudflare Tunnel integration.

```typescript
import { TunnelRelayAdapter } from "beamcode/relay";
```

| Method | Description |
|--------|-------------|
| `start()` | Start the cloudflared tunnel |
| `stop()` | Stop the tunnel |
| `tunnelUrl` | The public tunnel URL |
| `isRunning` | Whether the tunnel is active |

---

## Crypto

All crypto functions use libsodium-wrappers-sumo.

```typescript
import {
  generateKeypair,
  destroyKey,
  fingerprintPublicKey,
  seal,
  sealOpen,
  encrypt,
  decrypt,
  generateNonce,
  wrapEnvelope,
  unwrapEnvelope,
  serializeEnvelope,
  deserializeEnvelope,
  isEncryptedEnvelope,
  sign,
  verify,
  NonceTracker,
  PairingManager,
  getSodium,
} from "beamcode/utils/crypto";
```

### Key Management

```typescript
import type { KeyPair } from "beamcode";

interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

// Generate X25519 keypair
const keypair: KeyPair = await generateKeypair();

// Zero out secret key memory
destroyKey(keypair);

// SHA-256 fingerprint of a public key (hex string)
const fp: string = await fingerprintPublicKey(keypair.publicKey);
```

### Sealed Boxes

Anonymous encryption for initial key exchange (no sender authentication).

```typescript
// Encrypt (sender anonymous)
const ciphertext: Uint8Array = await seal(plaintext, recipientPublicKey);

// Decrypt
const plaintext: Uint8Array = await sealOpen(ciphertext, keypair);
```

### Authenticated Encryption

`crypto_box` with X25519 Diffie-Hellman (XSalsa20-Poly1305).

```typescript
const nonce: Uint8Array = await generateNonce();

// Encrypt with sender authentication
const ct: Uint8Array = await encrypt(plaintext, nonce, peerPublicKey, mySecretKey);

// Decrypt and verify sender
const pt: Uint8Array = await decrypt(ct, nonce, peerPublicKey, mySecretKey);
```

### EncryptedEnvelope

Wire format for encrypted messages over the relay.

```typescript
import type { EncryptedEnvelope } from "beamcode";

interface EncryptedEnvelope {
  v: 1;              // version
  sid: string;       // session ID (routing, not encrypted)
  ct: string;        // ciphertext (base64)
  len: number;       // plaintext length
}

// Create an envelope from plaintext
const envelope = await wrapEnvelope(plaintext, sessionId, peerPublicKey, mySecretKey);

// Extract plaintext from an envelope
const plaintext = await unwrapEnvelope(envelope, peerPublicKey, mySecretKey);

// Serialize/deserialize for transport
const json: string = serializeEnvelope(envelope);
const parsed: EncryptedEnvelope = deserializeEnvelope(json);

// Detect encrypted envelopes in mixed-mode
isEncryptedEnvelope(parsed); // => boolean
```

### HMAC Signing

HMAC-SHA256 for permission response authentication with anti-replay protection.

```typescript
import type { HMACInput } from "beamcode/utils/crypto";

interface HMACInput {
  requestId: string;
  behavior: "allow" | "deny";
  nonce: string;
  timestamp: number;
}

// Sign a permission response
const signature: string = await sign(input, sharedSecret);

// Verify a signature
const valid: boolean = await verify(input, signature, sharedSecret);

// Anti-replay protection
const tracker = new NonceTracker({
  maxEntries: 1000,       // track last N nonces (default: 1000)
  windowMs: 30_000,       // timestamp validity window (default: 30s)
});

tracker.check(nonce, timestamp); // throws if replayed or expired
```

### PairingManager

Manages pairing link generation, consumption, and sealed-box key exchange.

```typescript
import type { PairingLink, PairingResult, ParsedPairingLink } from "beamcode/utils/crypto";
import { PairingManager, parsePairingLink, sealPublicKeyForPairing } from "beamcode/utils/crypto";

// Generate a pairing link
const manager = new PairingManager();
const link: PairingLink = await manager.generatePairingLink(tunnelUrl);
// link.url => "https://<tunnel>/pair?pk=<base64>&fp=<fingerprint>&v=1"

// Parse a pairing link (consumer side)
const parsed: ParsedPairingLink = parsePairingLink(link.url);

// Consumer sends its public key via sealed box
const sealed: Uint8Array = await sealPublicKeyForPairing(
  consumerPublicKey,
  parsed.daemonPublicKey,
);

// Daemon consumes the pairing
const result: PairingResult = await manager.consumePairing(sealed);
```

---

## ReconnectionHandler

Manages stable consumer IDs, per-session message history, and replay for reconnecting consumers.

```typescript
import { ReconnectionHandler } from "beamcode/server";
```

### Constructor

```typescript
interface ReconnectionHandlerOptions {
  /** Maximum messages retained per session for replay (default: 500). */
  maxHistoryPerSession?: number;
  /** Number of most recent messages sent to a new connection (default: 20). */
  initialReplayCount?: number;
}
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `registerConsumer(sessionId, existingId?)` | `registerConsumer(sessionId: string, existingId?: string): string` | Register a consumer, returns stable consumer ID |
| `recordMessage(sessionId, message)` | `recordMessage(sessionId: string, message: SequencedMessage<ConsumerMessage>): void` | Record an outbound message for potential replay |
| `getReplayMessages(sessionId, lastSeenSeq)` | `getReplayMessages(sessionId: string, lastSeenSeq: number): SequencedMessage<ConsumerMessage>[]` | Get messages with seq > lastSeenSeq |
| `getInitialMessages(sessionId)` | `getInitialMessages(sessionId: string): SequencedMessage<ConsumerMessage>[]` | Get the most recent N messages for new connections |
| `updateLastSeen(consumerId, seq)` | `updateLastSeen(consumerId: string, seq: number): void` | Update last-seen seq for a consumer |
| `getLastSeen(consumerId)` | `getLastSeen(consumerId: string): number` | Get last-seen seq (0 if unknown) |
| `removeSession(sessionId)` | `removeSession(sessionId: string): void` | Remove all state for a session |
| `removeConsumer(consumerId)` | `removeConsumer(consumerId: string): void` | Remove a single consumer's state |

---

## Configuration

### ProviderConfig

```typescript
import type { ProviderConfig } from "beamcode";

interface ProviderConfig {
  // Required
  port: number;

  // Timeouts (ms)
  gitCommandTimeoutMs?: number;          // default: 3000
  relaunchGracePeriodMs?: number;        // default: 2000
  killGracePeriodMs?: number;            // default: 5000
  storageDebounceMs?: number;            // default: 150
  reconnectGracePeriodMs?: number;       // default: 10000
  resumeFailureThresholdMs?: number;     // default: 5000
  relaunchDedupMs?: number;              // default: 5000
  authTimeoutMs?: number;               // default: 10000
  initializeTimeoutMs?: number;          // default: 5000

  // Resource limits
  maxMessageHistoryLength?: number;      // default: 1000
  maxConcurrentSessions?: number;        // default: 50
  idleSessionTimeoutMs?: number;         // default: 0 (disabled)
  pendingMessageQueueMaxSize?: number;   // default: 100

  // Rate limiting
  consumerMessageRateLimit?: {
    tokensPerSecond: number;             // default: 50
    burstSize: number;                   // default: 20
  };

  // Circuit breaker
  cliRestartCircuitBreaker?: {
    failureThreshold: number;            // default: 5
    windowMs: number;                    // default: 60000
    recoveryTimeMs: number;              // default: 30000
    successThreshold: number;            // default: 2
  };

  // CLI
  defaultClaudeBinary?: string;          // default: "claude"
  cliWebSocketUrlTemplate?: (sessionId: string) => string;

  // Slash commands
  slashCommand?: {
    ptyTimeoutMs: number;                // default: 30000
    ptySilenceThresholdMs: number;       // default: 3000
    ptyEnabled: boolean;                 // default: true
  };

  // Security
  envDenyList?: string[];                // always includes LD_PRELOAD, DYLD_INSERT_LIBRARIES, NODE_OPTIONS
}
```

### resolveConfig

```typescript
import { resolveConfig, DEFAULT_CONFIG } from "beamcode";

const resolved = resolveConfig({ port: 3456 });
// All optional fields filled with defaults
```

---

## Events

### BridgeEventMap

Events emitted by `SessionBridge`.

| Event | Payload |
|-------|---------|
| `cli:session_id` | `{ sessionId, cliSessionId }` |
| `cli:connected` | `{ sessionId }` |
| `cli:disconnected` | `{ sessionId }` |
| `cli:relaunch_needed` | `{ sessionId }` |
| `backend:connected` | `{ sessionId }` |
| `backend:disconnected` | `{ sessionId, code, reason }` |
| `backend:session_id` | `{ sessionId, backendSessionId }` |
| `backend:message` | `{ sessionId, message: UnifiedMessage }` |
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
| `capabilities:ready` | `{ sessionId, commands, models, account }` |
| `capabilities:timeout` | `{ sessionId }` |
| `auth_status` | `{ sessionId, isAuthenticating, output, error? }` |
| `error` | `{ source, error, sessionId? }` |

### LauncherEventMap

Events emitted by `SdkUrlLauncher`.

| Event | Payload |
|-------|---------|
| `process:spawned` | `{ sessionId, pid }` |
| `process:exited` | `{ sessionId, exitCode, uptimeMs }` |
| `process:connected` | `{ sessionId }` |
| `process:resume_failed` | `{ sessionId }` |
| `process:stdout` | `{ sessionId, data }` |
| `process:stderr` | `{ sessionId, data }` |
| `error` | `{ source, error, sessionId? }` |

### SessionManagerEventMap

Union of `BridgeEventMap` and `LauncherEventMap` — all events are available on `SessionManager`.

```typescript
manager.on("cli:connected", ({ sessionId }) => { ... });
manager.on("process:spawned", ({ sessionId, pid }) => { ... });
manager.on("error", ({ source, error, sessionId }) => { ... });
```

---

## Consumer Messages

Messages the bridge sends to consumers (browser, agent, etc.).

```typescript
import type { ConsumerMessage } from "beamcode";

type ConsumerMessage =
  | { type: "session_init"; session: SessionState }
  | { type: "session_update"; session: Partial<SessionState> }
  | { type: "assistant"; message: AssistantContent; parent_tool_use_id: string | null }
  | { type: "stream_event"; event: unknown; parent_tool_use_id: string | null }
  | { type: "result"; data: ResultData }
  | { type: "permission_request"; request: ConsumerPermissionRequest }
  | { type: "permission_cancelled"; request_id: string }
  | { type: "tool_progress"; tool_use_id: string; tool_name: string; elapsed_time_seconds: number }
  | { type: "tool_use_summary"; summary: string; tool_use_ids: string[] }
  | { type: "status_change"; status: "compacting" | "idle" | "running" | null }
  | { type: "auth_status"; isAuthenticating: boolean; output: string[]; error?: string }
  | { type: "error"; message: string }
  | { type: "cli_disconnected" }
  | { type: "cli_connected" }
  | { type: "user_message"; content: string; timestamp: number }
  | { type: "message_history"; messages: ConsumerMessage[] }
  | { type: "session_name_update"; name: string }
  | { type: "identity"; userId: string; displayName: string; role: ConsumerRole }
  | { type: "presence_update"; consumers: Array<{ userId: string; displayName: string; role: ConsumerRole }> }
  | { type: "slash_command_result"; command: string; request_id?: string; content: string; source: "emulated" | "pty" }
  | { type: "slash_command_error"; command: string; request_id?: string; error: string }
  | { type: "capabilities_ready"; commands: InitializeCommand[]; models: InitializeModel[]; account: InitializeAccount | null };
```

### Key Types

**ResultData** — turn completion data:

```typescript
interface ResultData {
  subtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries";
  is_error: boolean;
  result?: string;
  errors?: string[];
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUSD: number; ... }>;
}
```

---

## Inbound Messages

Messages consumers send to the bridge.

```typescript
import type { InboundMessage } from "beamcode";

type InboundMessage =
  | { type: "user_message"; content: string; session_id?: string; images?: { media_type: string; data: string }[] }
  | { type: "permission_response"; request_id: string; behavior: "allow" | "deny"; updated_input?: Record<string, unknown>; message?: string }
  | { type: "interrupt" }
  | { type: "set_model"; model: string }
  | { type: "set_permission_mode"; mode: string }
  | { type: "presence_query" }
  | { type: "slash_command"; command: string; request_id?: string };
```

---

## Authentication

Pluggable `Authenticator` interface gates consumer WebSocket connections.

```typescript
import type { Authenticator, AuthContext, ConsumerIdentity, ConsumerRole } from "beamcode";

type ConsumerRole = "participant" | "observer";

interface ConsumerIdentity {
  userId: string;
  displayName: string;
  role: ConsumerRole;
}

interface AuthContext {
  sessionId: string;
  transport: Record<string, unknown>;  // headers, query, remoteAddress, etc.
}

interface Authenticator {
  authenticate(context: AuthContext): Promise<ConsumerIdentity>;
}
```

### Example

```typescript
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

const manager = new SessionManager({
  config: { port: 3456 },
  processManager: new NodeProcessManager(),
  authenticator,
});
```

Without an authenticator, consumers get anonymous participant identities via `createAnonymousIdentity()`.

---

## Testing Utilities

```typescript
import { MemoryStorage, MockProcessManager } from "beamcode";

// In-memory storage (no filesystem)
const storage = new MemoryStorage();

// Mock process manager (no real processes)
const pm = new MockProcessManager();

// Create a test session manager
const manager = new SessionManager({
  config: { port: 0 },
  processManager: pm,
  storage,
});

// Launch and simulate
const info = manager.launcher.launch({ cwd: "/tmp" });
pm.lastProcess.resolveExit(0);
```

---

## Utilities

### NDJSON

```typescript
import { parseNDJSON, serializeNDJSON, NDJSONLineBuffer } from "beamcode";

// Parse a single NDJSON line
const obj = parseNDJSON('{"type":"assistant"}');

// Serialize to NDJSON
const line = serializeNDJSON({ type: "assistant" });

// Buffer for incremental NDJSON parsing
const buffer = new NDJSONLineBuffer();
buffer.append(chunk);
const lines = buffer.flush(); // => complete JSON objects
```

### ANSI Stripping

```typescript
import { stripAnsi } from "beamcode";

stripAnsi("\x1b[31mred text\x1b[0m"); // => "red text"
```

---

## Version Information

- **Package:** beamcode
- **Version:** 0.1.0
- **Node.js:** >= 22.0.0
- **TypeScript:** 5.8+
- **WebSocket:** ws 8.18+
- **Crypto:** libsodium-wrappers-sumo 0.7.15

## License

MIT — see [LICENSE](./LICENSE).
