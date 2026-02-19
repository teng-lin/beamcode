# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-02-19

### Added

#### Multi-adapter support

- **Universal adapter layer**: `BackendAdapter` and `BackendSession` interfaces — one contract for any coding agent
- **UnifiedMessage**: Normalized message envelope with `Interruptible`, `Configurable`, `PermissionHandler`, `Reconnectable`, `Encryptable` extension interfaces via runtime type narrowing
- **SequencedMessage\<T\>**: Wrapper with `seq` + `timestamp` for reconnection replay
- **ClaudeAdapter**: Claude Code `--sdk-url` NDJSON/WebSocket adapter with inbound/outbound translators, state reducer, and `--resume` support
- **ACPAdapter**: JSON-RPC 2.0 over stdio covering 25+ ACP-compliant agents (Goose, Kiro, Gemini CLI, Cline, OpenHands, ...)
- **CodexAdapter**: JSON-RPC over WebSocket for `codex app-server` mode — Thread/Turn/Item model mapped to UnifiedMessage (30+ method types)
- **OpencodeAdapter**: HTTP + SSE adapter for Opencode CLI
- **GeminiAdapter**: A2A SSE adapter for Gemini CLI
- Backend adapter compliance test suite

#### Web UI (rebuilt)

- React 19 + Zustand + Tailwind v4 + Vite single-file consumer (~300 KB, ~94 KB gzip)
- Companion-style layout: collapsible sidebar, chat view, agent pane, status bar
- New Session Dialog: create sessions with adapter, model, and working directory selection
- Rich message rendering: markdown, code blocks, image blocks, thinking blocks, tool execution, diffs
- Streaming UX: blinking cursor, elapsed time, token count
- Slash command menu: categorized typeahead with keyboard navigation
- Permission UI: tool-specific previews (Bash commands, Edit diffs, file paths)
- Team coordination: task panel, agent grid, member presence
- Process log drawer, toast notifications, circuit breaker status banner
- Auto-reconnect with message replay from `last_seen_seq`

#### Daemon

- `Daemon` class with `start()` / `stop()` lifecycle
- `LockFile`: `O_CREAT | O_EXCL` exclusive lock prevents duplicate instances with staleness detection
- `StateFile`: `{ pid, port, heartbeat, version, controlApiToken }` for CLI discovery
- `ControlApi`: HTTP on `127.0.0.1:0` with Bearer auth — list, create, delete sessions
- `HealthCheck`: 60s heartbeat loop updating state file
- Graceful shutdown on SIGTERM/SIGINT with 10s force-exit timeout

#### Relay + E2E encryption

- `EncryptionLayer`: transparent E2E encryption middleware (sealed boxes: XSalsa20-Poly1305)
- `CloudflaredManager`: cloudflared sidecar — start, stop, tunnel URL extraction, retry with backoff
- `PairingManager`: pairing link generation and sealed-box key exchange
- `NonceTracker`: anti-replay protection (last 1000 nonces, 30s timestamp window)
- HMAC-SHA256 permission signing with nonce + timestamp + request_id binding
- `EncryptedEnvelope` wire format: `{ v: 1, sid, ct, len }`

#### Server

- `ReconnectionHandler`: stable consumer IDs, per-session message history, replay from `last_seen_seq`
- `ConsumerChannel`: per-consumer send queue with backpressure and high-water mark

### Changed

- Renamed package from `claude-code-bridge` to `beamcode`
- `SessionBridge` decomposed into focused modules: `SessionStore`, `ConsumerBroadcaster`, `ConsumerGatekeeper`, `SlashCommandExecutor`, `TeamEventDiffer`
- Slash command routing replaced with explicit handler chain (no binary routing)
- Session coordination delegated from `SessionBridge` to `SessionManager`
- `NodeWebSocketServer` generalized for consumer reconnection support
- `ProcessSupervisor` extracted as reusable core component
- Added `libsodium-wrappers-sumo` dependency for E2E encryption

### Fixed

- Consumer token used for HTTP API auth so New Session Dialog works correctly (#79)
- Await backend session close before port reuse to prevent startup races (#76)
- Remove `/cost` command — not supported by Claude CLI (#73)
- Codex `codex/event/error` handling with `error_code` metadata surfacing (#66)
- Security audit: 9 findings resolved including env injection, path traversal, and auth hardening (#68)
- Architecture violations: hexagonal boundary enforcement across all layers (#67)
- Frontend stability, message echo prevention, and security hardening (#5)

### Docs

- Rewrote `README.md`: focused vision, web UI walkthrough, updated adapter diagrams
- Added `DEVELOPMENT.md`: architecture reference, adapter guide, configuration, events, auth, testing, build

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
