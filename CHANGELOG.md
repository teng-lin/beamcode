# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Universal adapter layer**: `BackendAdapter` and `BackendSession` interfaces for multi-agent support
- **UnifiedMessage type**: Normalized message envelope aligned with Claude Agent SDK's `SDKMessage` types
- **Extension interfaces**: `Interruptible`, `Configurable`, `PermissionHandler`, `Reconnectable`, `Encryptable` — additive capabilities via runtime type narrowing
- **SequencedMessage\<T\>**: Wrapper with `seq` number and `timestamp` for reconnection replay

#### Adapters

- **ClaudeAdapter** (Phase 1): Extracted Claude Code `--sdk-url` NDJSON/WebSocket logic from monolithic SessionBridge into a standalone adapter
  - `ClaudeLauncher` — process lifecycle, `--sdk-url` URL construction, `--resume` support
  - Inbound translator (CLI NDJSON → UnifiedMessage)
  - Outbound message translator (consumer messages → CLI NDJSON)
  - State reducer (derives session state from CLI message stream)
- **ACPAdapter** (Phase 3): JSON-RPC 2.0 over stdio for any ACP-compliant agent (Goose, Kiro, Gemini CLI, Cline, OpenHands, 25+ agents)
  - `ACPSession` with `initialize` capability negotiation
  - JSON-RPC request/response/notification handling
  - Bidirectional message translation (ACP `session/update` ↔ UnifiedMessage)
- **CodexAdapter** (Phase 3): JSON-RPC over subprocess stdio for Codex CLI app-server mode
  - Thread/Turn/Item model mapping to UnifiedMessage
  - `CodexLauncher` for `codex app-server` subprocess management
  - Message translator covering 30+ Codex JSON-RPC method types
- **AgentSdkAdapter** (Phase 4): In-process adapter using `@anthropic-ai/claude-agent-sdk`
  - `AgentSdkSession` wrapping SDK's V2 session API
  - `PermissionBridge` — bridges SDK's callback-based `canUseTool` to async message flow
  - SDK message translator (SDKMessage ↔ UnifiedMessage, 16 message type mappings)
- **Backend adapter compliance test suite**: Contract tests verifiable by any adapter implementation

#### Daemon

- **Daemon** class with `start()` / `stop()` lifecycle
- **ChildProcessSupervisor**: Manages CLI child processes (spawn, kill, PID tracking, session count)
- **LockFile**: `O_CREAT | O_EXCL` exclusive lock prevents duplicate daemon instances; staleness detection
- **StateFile**: `{ pid, port, heartbeat, version, controlApiToken }` for CLI discovery
- **ControlApi**: HTTP server on `127.0.0.1:0` with Bearer token auth
  - `GET /health` — uptime and session count
  - `GET /sessions` — list all sessions
  - `POST /sessions` — create session (requires `cwd`)
  - `DELETE /sessions/:id` — stop a session
- **SignalHandler**: Graceful shutdown on SIGTERM/SIGINT
- **HealthCheck**: 60-second heartbeat loop updating state file

#### Relay

- **EncryptionLayer**: Middleware for transparent E2E encryption between SessionBridge and WebSocket transport
  - Outbound: `ConsumerMessage → serialize → encrypt → EncryptedEnvelope`
  - Inbound: `EncryptedEnvelope → decrypt → deserialize → InboundMessage`
  - Mixed-mode detection for pairing transition
- **CloudflaredManager**: Manages cloudflared sidecar process (start, stop, tunnel URL extraction, retry with backoff)
- **TunnelRelayAdapter**: Wraps CloudflaredManager with start/stop semantics
- **SessionRouter**: Routes encrypted envelopes to correct backend sessions by session ID

#### Crypto

- **Key management**: `generateKeypair()`, `destroyKey()` (zeros memory), `fingerprintPublicKey()`
- **Sealed boxes**: `seal()` / `sealOpen()` — anonymous encryption for initial key exchange
- **Authenticated encryption**: `encrypt()` / `decrypt()` — `crypto_box` with X25519 DH
- **EncryptedEnvelope**: Wire format `{ v: 1, sid, ct, len }` with serialize/deserialize/detection
- **HMAC signing**: `sign()` / `verify()` — HMAC-SHA256 for permission response authentication
- **NonceTracker**: Anti-replay protection tracking last 1000 nonces with 30s timestamp window
- **PairingManager**: Pairing link generation, consumption, and sealed-box key exchange
- `getSodium()` — lazy libsodium-wrappers-sumo loader

#### Server

- **ReconnectionHandler**: Stable consumer IDs, per-session message history (configurable capacity), replay from `last_seen_seq`, initial message batch for new connections
- **ConsumerChannel**: Per-consumer send queue with backpressure and high-water mark

#### Web Consumer

- Minimal HTML/JS client (`src/consumer/index.html`, ~700 LOC)
- E2E decryption of relay messages
- Markdown rendering of assistant responses
- Permission request UI (approve/deny with HMAC signing)
- Reconnection with message replay

### Changed

- Renamed package from `claude-code-bridge` to `beamcode`
- SessionBridge now operates on `UnifiedMessage` instead of raw NDJSON
- NodeWebSocketServer generalized for consumer reconnection support
- `ProcessSupervisor` extracted as a reusable core component
- Added `libsodium-wrappers-sumo` as a dependency for E2E encryption

## [0.1.1] - 2026-02-14

### Added

- GitHub Actions CI/CD workflows for automated testing and releases
  - Main CI workflow: Tests on Node 18.x and 20.x, linting, type checking, code coverage
  - Release workflow: Automated GitHub Release creation on version tags
  - Coverage uploads to Codecov for main branch pushes

### Changed

- Consolidated documentation structure (API_REFERENCE.md, CHANGELOG.md, README.md)
- Enhanced .gitignore with coverage, IDE, and log patterns

### Removed

- Removed redundant PRODUCTION_HARDENING.md and COMPLETION_SUMMARY.md documentation

## [0.1.0] - 2026-02-14

### Added

- Initial release of the library (then named `claude-code-bridge`)
- Runtime-agnostic TypeScript library for managing Claude Code CLI sessions via WebSocket
- **Core:**
  - SessionManager for WebSocket-based session coordination
  - SessionBridge for bridging consumer and CLI connections
  - CLILauncher for spawning and managing CLI processes
  - FileStorage for persistent session state
- **Production hardening:**
  - Idle session timeout cleanup
  - Health check endpoint
  - Connection heartbeat (ping-pong)
  - Backpressure handling with queue limits
  - Graceful drain on shutdown
  - Pending message queue overflow prevention
  - Rate limiting (token bucket)
  - Circuit breaker (sliding window)
  - Atomic/crash-safe file writes with write-ahead logging
  - Structured logging with pluggable logger interface
  - Session statistics API with real-time metrics
  - Operational commands (close, archive, list)
- **Slash command support:**
  - Emulated commands: `/model`, `/status`, `/config`, `/cost`, `/context` (instant, from SessionState)
  - Native forwarding: `/compact`, `/cost`, `/context`, `/files`, `/release-notes` (to CLI)
  - PTY commands: Any other command via sidecar PTY (requires `node-pty`)
  - `SlashCommandExecutor` with per-session serialization queue
  - `PtyCommandRunner` adapter for interactive PTY execution
- **Security:**
  - UUID validation for session IDs
  - Path traversal prevention in FileStorage
  - Environment variable deny list
  - Binary path validation (basename or absolute only)
- **Auth:**
  - Pluggable `Authenticator` interface
  - Role-based access control (`participant` / `observer`)
  - Presence tracking and broadcast
- **DX:**
  - Dual CJS/ESM package exports
  - Full TypeScript type definitions
  - `TypedEventEmitter` with complete event map types
  - Testing utilities (`MockProcessManager`, `MemoryStorage`, `MockCommandRunner`)
  - Example operator dashboard server
  - 331 tests via Vitest

### Technical Stack

- **Runtime:** Node.js 22.0.0+
- **Language:** TypeScript 5.8+
- **Testing:** Vitest 3.0+
- **Linting:** Biome 2.3+
- **WebSocket:** ws 8.18+
- **Crypto:** libsodium-wrappers-sumo 0.7.15
