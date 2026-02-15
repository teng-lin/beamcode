# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Slash command support**: Unified `slash_command` inbound message type with two execution strategies
  - **Emulated commands**: `/model`, `/status`, `/config`, `/cost`, `/context` resolved instantly from `SessionState`
  - **PTY commands**: Non-emulatable commands (e.g. `/usage`) executed via a sidecar PTY using optional `node-pty`
  - **Native forwarding**: `/compact`, `/cost`, `/context`, `/files`, `/release-notes` forwarded directly to CLI
- `SlashCommandExecutor` core orchestrator with per-session serialization queue
- `PtyCommandRunner` adapter for interactive PTY command execution
- `CommandRunner` interface for custom command execution strategies
- `MockCommandRunner` test utility (exported from `claude-code-bridge/testing`)
- `stripAnsi()` utility for stripping ANSI escape codes
- `slash_command_result` and `slash_command_error` consumer message types
- `slash_command:executed` and `slash_command:failed` bridge events
- `SessionState.last_model_usage`, `last_duration_ms`, `last_duration_api_ms` fields
- `ProviderConfig.slashCommand` configuration (PTY timeout, silence threshold, enable/disable)
- `SessionBridge.executeSlashCommand()` and `SessionManager.executeSlashCommand()` programmatic APIs
- `commandRunner` option on `SessionBridge` and `SessionManager` constructors
- `node-pty` as optional peer dependency

### Fixed

- **PtyCommandRunner**: Rewritten to handle Claude CLI's full TUI (terminal UI) mode
  - Uses silence-based TUI readiness detection instead of `\n> ` prompt matching (CLI uses cursor positioning)
  - Handles workspace trust and bypass permissions confirmation prompts with delayed Enter
  - Types command first, then presses Enter after 300ms delay (required for autocomplete interaction)
  - Increased default `ptyTimeoutMs` from 15s to 30s (TUI startup adds ~5s overhead)
  - Increased default `ptySilenceThresholdMs` from 500ms to 3000ms (API-calling commands like `/usage` need more time)
  - Successfully tested against real Claude CLI `/usage` command scraping

## [0.1.1] - 2025-02-14

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

## [0.1.0] - 2025-02-14

### Added

- Initial release of claude-code-bridge library
- Runtime-agnostic TypeScript library for managing Claude Code CLI sessions via WebSocket
- **Core Features:**
  - SessionManager for WebSocket-based session coordination
  - SessionBridge for bridging consumer and CLI connections
  - CLILauncher for spawning and managing CLI processes
  - FileStorage for persistent session state

- **Production Hardening:**
  - Idle session timeout cleanup with configurable thresholds
  - Health check endpoint for session monitoring
  - Connection heartbeat (ping-pong) for keep-alive
  - Backpressure handling for message sends with queue limits
  - Graceful drain on shutdown with connection management
  - Pending message queue overflow prevention
  - Rate limiting (token bucket) for consumer message protection
  - Circuit breaker pattern for CLI restart cascade prevention
  - Atomic/crash-safe file writes with write-ahead logging
  - Structured logging with pluggable logger interface
  - Session statistics API with real-time metrics
  - Operational commands for session management (close, archive, list, etc.)

- **Developer Experience:**
  - Comprehensive TypeScript type definitions
  - Testing utilities and fixtures
  - Integration tests for production features
  - Detailed API documentation
  - Example operator dashboard server with HTTP endpoints
  - Git hooks for pre-commit linting

- **Infrastructure:**
  - Full ES modules + CommonJS dual package export
  - TypeScript declaration file generation
  - Vitest-based test suite (331 tests)
  - Biome linting and formatting
  - GitHub Actions CI/CD workflows
  - Code coverage reporting
  - Release automation

### Technical Stack

- **Runtime:** Node.js 22.0.0+
- **Language:** TypeScript 5.8+
- **Package Manager:** pnpm 8
- **Testing:** Vitest 3.0+
- **Linting:** Biome 2.3+
- **WebSocket:** ws 8.18+

### Documentation

- README.md: Project overview and getting started
- API_REFERENCE.md: SessionManager API and HTTP endpoint documentation

### Notes

This is the initial stable release with all 11 production hardening features implemented and integrated. The library is production-ready for managing Claude Code CLI sessions in multi-tenant environments with proper rate limiting, circuit breaking, and operational management.

For migration guide or breaking changes from previous versions, see individual release notes.
