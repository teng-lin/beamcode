# Competitive Codebase Analysis

**Date**: 2026-02-16
**Scope**: BeamCode architecture & features vs. Companion and Happy
**Method**: Deep codebase exploration of all three projects

---

## Executive Summary

BeamCode, Companion, and Happy solve overlapping problems from different architectural positions. BeamCode is an **infrastructure library** (adapter abstraction, embeddable, lightweight). Companion is a **web application** (feature-rich UI, monolithic server). Happy is a **full-stack product** (mobile-first, zero-knowledge encryption, real infrastructure). Each has patterns and features worth studying.

---

## Project Profiles

### BeamCode

- **Identity**: Universal adapter library for coding agent CLIs
- **Stack**: TypeScript, Node.js ≥ 22, tsdown (dual CJS/ESM), React 19 + Zustand + Tailwind v4 + Vite
- **Scale**: ~40K LOC (14K backend, 3K frontend, 23K tests)
- **Agent support**: 25+ agents via 4 protocol adapters (SDK-URL, ACP, Codex, Agent SDK)
- **Differentiators**: BackendAdapter abstraction, E2E encryption relay, daemon with process supervision, RBAC, rate limiting, circuit breaker

### Companion

- **Identity**: Web UI for Claude Code and Codex sessions
- **Stack**: TypeScript, Bun, Hono, React 19 + Zustand + Tailwind v4 + Vite
- **Scale**: ~45K LOC (10K backend, 12K frontend, 22K tests)
- **Agent support**: 2 backends (Claude Code, Codex)
- **Differentiators**: Protocol recording/replay, terminal emulator (xterm.js), diff viewer, cron scheduler, env profiles, protocol drift detection tests, PostHog analytics
- **Published**: npm `the-companion` v0.43.0

### Happy

- **Identity**: Mobile-first encrypted client for remote AI agent control
- **Stack**: TypeScript, Yarn workspaces monorepo (4 packages), Fastify 5, Expo + React Native + Tauri
- **Scale**: ~129K LOC (9K server, 31K CLI, 85K app, 5K agent control)
- **Agent support**: 3 (Claude Code, Codex, Gemini)
- **Differentiators**: Zero-knowledge architecture, PostgreSQL + Redis + S3, mobile app (iOS/Android), Tauri desktop, push notifications, QR device linking, MCP protocol support, Prometheus metrics, launchd integration

---

## Side-by-Side Comparison

| Dimension | BeamCode | Companion | Happy |
|-----------|----------|-----------|-------|
| Architecture | Library (embeddable) | Application (monolithic) | Product (monorepo, 4 packages) |
| Runtime | Node.js ≥ 22 | Bun | Node.js ≥ 20 |
| Server | Raw HTTP + ws | Hono | Fastify 5 |
| Database | None (JSON files) | None (JSON files) | PostgreSQL (Prisma) + Redis |
| Frontend | React 19 web SPA (single HTML) | React 19 web SPA | Expo (iOS/Android/Web) + Tauri (desktop) |
| State mgmt | Zustand | Zustand | Zustand + MMKV (mobile) |
| CSS | Tailwind v4 | Tailwind v4 | Tailwind v4 (twrnc) |
| Build | tsdown (CJS/ESM) | Vite | Vite + Expo |
| Test | Vitest (69 files) | Vitest (49 files) | Vitest (60 files) |
| Encryption | libsodium (relay-level) | None | libsodium + tweetnacl (client-side) |
| Agent protocol | BackendAdapter interface | Inline ws-bridge | Inline per-agent modules |
| Agents supported | 25+ (ACP protocol) | 2 | 3 |
| Real-time | WebSocket (ws) | WebSocket (ws) | Socket.IO + Redis adapter |
| Daemon | Lock file + state file + health check | N/A | Lock file + launchd plist |
| Monitoring | None | PostHog (analytics) | Prometheus (metrics) |
| Deployment | npm install / run binary | npm / bunx | Docker multi-stage |
| Package | npm library | npm app | Yarn workspaces monorepo |

---

## Feature Matrix

| Feature | BeamCode | Companion | Happy |
|---------|----------|-----------|-------|
| Multi-agent adapter abstraction | **Yes** (4 adapters) | No | No |
| E2E encryption | **Yes** (relay) | No | **Yes** (zero-knowledge) |
| Remote access tunnel | **Yes** (Cloudflare) | No | Via server |
| RBAC (participant/observer) | **Yes** | No | No |
| Rate limiting | **Yes** | No | No |
| Circuit breaker | **Yes** | No | No |
| Sequenced message replay | **Yes** | No | No |
| Protocol recording/replay | No | **Yes** | **Yes** (JSONL) |
| Protocol drift detection tests | No | **Yes** | No |
| Terminal emulator | No | **Yes** (xterm.js) | No |
| File diff viewer | No | **Yes** | **Yes** |
| Cron scheduled tasks | No | **Yes** | No |
| Environment profiles | No | **Yes** | No |
| Prometheus metrics | No | No | **Yes** |
| MCP protocol support | No | No | **Yes** |
| Mobile app (iOS/Android) | No | No | **Yes** |
| Desktop app (Tauri) | No | No | **Yes** |
| Push notifications | No | No | **Yes** |
| QR device linking | No | No | **Yes** |
| PostgreSQL persistence | No | No | **Yes** |
| Session auto-naming | No | **Yes** | No |
| macOS launchd daemon | No | No | **Yes** |
| Idempotent message delivery | No | No | **Yes** |
| Team/multi-agent observation | **Yes** | No | No |

---

## Borrowable Ideas

### From Companion

#### Tier 1 — High Value

**Protocol recording/replay**
Companion logs every raw WebSocket message to JSONL files with 100K-line rotation. BeamCode's `SessionBridge` is the natural intercept point. This is invaluable for debugging adapter issues across 25+ agents. Implementation: a `Recorder` extension interface on `BackendAdapter`.

**Protocol drift detection tests**
Companion snapshots expected message shapes in tests and fails when the CLI changes its protocol. With 4 adapters to maintain, this is more important for BeamCode than for Companion. Catches breaking changes before users hit them.

**Diff panel component**
Companion's `DiffPanel.tsx` shows before/after for Edit/Write tool calls. BeamCode's frontend already renders `ToolGroupBlock` — adding a collapsible diff view inside it is a natural extension. The `diff` npm package is lightweight.

#### Tier 2 — Medium Value

**Environment profiles**
Per-session env configs stored on disk. Maps well to BeamCode's multi-adapter world where different agents need different env vars.

**Session auto-naming**
Small quality-of-life improvement for the sidebar when running multiple sessions.

#### Tier 3 — Study, Don't Copy

**ws-bridge.ts routing heuristics**
Companion's monolithic bridge handles message routing, protocol translation, and state in one file. The *heuristics* for what to forward vs buffer vs drop are battle-tested and worth validating against BeamCode's `SessionBridge` logic.

---

### From Happy

#### Tier 1 — High Value

**Prometheus metrics**
Happy exposes counters/histograms for request latency, active sessions, and error rates. BeamCode has rate limiting and circuit breakers with zero visibility. A `MetricsCollector` interface with a default Prometheus implementation would let consumers plug into existing monitoring. Natural fit alongside the `BackendAdapter` extension pattern.

**MCP protocol support**
Happy integrates `@modelcontextprotocol/sdk` for tool bridging. BeamCode's ACP adapter handles JSON-RPC/stdio agents, but MCP is becoming the standard for agent tool integration. Adding MCP transport — exposing BeamCode *as* an MCP server — would future-proof the adapter layer.

**Zero-knowledge upgrade path**
Happy's encryption is client-side only; the server cannot read messages. BeamCode's daemon currently decrypts at the relay boundary and routes plaintext internally. Happy's pattern of encrypting per-message with recipient public keys (not just transport-level) would enable a true zero-knowledge mode where the daemon is a dumb relay. Meaningful security upgrade for remote access.

**macOS launchd integration**
Happy has proper `launchd` plist management for its daemon. BeamCode's daemon requires manual startup. A `LaunchdManager` alongside the existing `ProcessSupervisor` makes "install and forget" possible on macOS.

#### Tier 2 — Medium Value

**Idempotent message delivery**
Happy makes all mutations safe to retry (critical for mobile with spotty connections). BeamCode's consumer messages aren't idempotent — a reconnecting client that replays a `user_message` could double-send to the CLI. Adding idempotency keys to `UnifiedMessage` and dedup logic in `SessionBridge` fixes this correctness gap.

**Transaction/lock wrapper pattern (`inTx`)**
Happy wraps all database mutations in a transaction helper. BeamCode doesn't use a database, but concurrent session state writes to `FileStorage` can race. A `withLock` wrapper around state file mutations would prevent corruption.

**Ink terminal UI**
Happy uses Ink (React for terminals) for a rich CLI experience. BeamCode's CLI is minimal. A nicer `beamcode` CLI showing session status, active consumers, and connection health would improve developer experience.

#### Tier 3 — Not Applicable

- PostgreSQL/Prisma — overkill for a library
- Expo mobile app — product concern
- QR device linking — BeamCode's pairing links already work
- Push notifications — requires infrastructure BeamCode shouldn't own
- Social features — out of scope

---

## Recommended Priorities

Based on alignment with BeamCode's library identity and impact:

| Priority | Feature | Source | Rationale |
|----------|---------|--------|-----------|
| 1 | Protocol recording | Companion | Debug aid for 25+ adapters; minimal API surface |
| 2 | Prometheus metrics | Happy | Visibility into rate limiter, circuit breaker, sessions |
| 3 | Drift detection tests | Companion | Prevents silent adapter breakage across 4 protocols |
| 4 | Idempotent messages | Happy | Correctness fix for reconnection replay path |
| 5 | Diff panel component | Companion | High-impact frontend improvement, small scope |
| 6 | MCP transport | Happy | Future-proofs adapter layer as MCP becomes standard |
| 7 | Zero-knowledge mode | Happy | Security upgrade for remote relay use case |
| 8 | launchd integration | Happy | "Install and forget" daemon management on macOS |

---

## Architectural Takeaways

**BeamCode's adapter abstraction is unique.** Neither Companion nor Happy has a pluggable backend interface. Both hard-code each agent integration. This is BeamCode's moat — and also its maintenance burden. The drift detection tests and protocol recording features directly address that burden.

**BeamCode's frontend is thin by design, but too thin.** At ~3K LOC vs Companion's ~12K and Happy's ~85K, the web UI lacks features users expect from coding agent UIs (diffs, terminal, file browsing). The diff panel is the highest-ROI frontend investment.

**Happy's zero-knowledge model is the future of remote access.** As AI coding agents handle increasingly sensitive codebases, "the server can't read your messages" is a compelling trust story. BeamCode's relay encryption is transport-level; upgrading to per-message encryption would be a meaningful differentiator.

**Observability is a gap.** Neither BeamCode's rate limiter, circuit breaker, nor session lifecycle emit any metrics. Both Companion (PostHog) and Happy (Prometheus) solved this. For a library, Prometheus-style metrics are the right choice — consumers bring their own dashboards.
