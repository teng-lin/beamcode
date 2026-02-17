# UI Gap Analysis: Backend Capabilities Not Exposed in Frontend

**Date**: 2026-02-16 (updated with competitive analysis + PR #23–#26 implementation audit)
**Methodology**: 5-agent parallel review — session management, metrics/observability, process lifecycle, security/relay, and configuration/adapters + competitive analysis of Companion, Happy, and Halo UIs
**Scope**: All `src/` backend capabilities vs. `web/` frontend coverage + competitor feature comparison

---

## Executive Summary

BeamCode's backend is **production-grade** with sophisticated session management, fault tolerance, E2E encryption, multi-adapter support, and observability infrastructure. The frontend exposes **the core chat experience well** (messaging, streaming, permissions, teams, slash commands) and **now covers most session state and management features** thanks to PRs #22–#25. However, **3 capability domains remain largely invisible**: process lifecycle (circuit breaker, reconnect), security (encryption, pairing, tunnels), and advanced configuration.

### Coverage by Domain

| Domain | Backend Features | UI Coverage | Gap Severity |
|--------|-----------------|-------------|-------------|
| Core Chat (messaging, streaming, permissions) | 31 message types | ~95% | Low |
| Session State (model, cost, context, git) | 25+ fields | **~95%** | **Low** |
| Session Management (admin, archive, health) | 10 operational commands | **~70%** | **Medium** |
| Observability (metrics, latency, errors) | 15 metric event types | **~40%** | **Medium** |
| Process Lifecycle (circuit breaker, reconnect) | 22+ state dimensions | **~70%** | **Medium** |
| Security (encryption, pairing, tunnels, roles) | 7 crypto modules + relay | **~25%** | **High** |
| Configuration (adapters, settings, MCP) | 50+ config options, 4 adapters | **~40%** | **Medium** |

> **Note**: Coverage improved significantly in PRs #23–#25 (session management from 20%→60%, observability from 5%→25%, configuration from 5%→25%) and again in PR #26 (process lifecycle from 10%→70%, security from 0%→25%, observability from 25%→40%, configuration from 25%→40%). See "Shipped in PRs #23–#26" section below for details.

---

## Competitive Landscape

Analysis of three competitor UIs — **The Companion**, **Happy**, and **Halo** — reveals features that validate several of our gap findings and surface new opportunities.

### The Companion

Web UI for Claude Code with multi-backend support. TypeScript/Bun/Hono, React 19 + Zustand + Tailwind v4 + Vite. ~45K LOC. Published as `the-companion` on npm.

**Key features observed:**
- **Multi-backend selector**: Inline toggle between "Claude Code" and "Codex" backends — validates P3-1 and elevates it
- **Bottom toolbar**: Dense, power-user control bar with folder picker, branch picker, worktree button, environment selector, model picker — all inline
- **Session archiving**: "ARCHIVED (54)" collapsible section in sidebar — validates P1-4
- **Project grouping**: Sessions grouped by project with live "1 running" count badge
- **Auto-generated session names**: Creative names ("Deft Quartz") for easy identification
- **Agent mode dropdown**: Explicit mode selector in composer area
- **Notification controls**: Sound on/off, Alerts on/off toggles in sidebar
- **Terminal access**: Dedicated terminal section in sidebar (xterm.js)
- **Environment management**: Full environment management UI with profiles
- **Image upload**: Image attachment button in composer
- **Diff panel**: Before/after diff viewer for Edit/Write tool calls
- **Protocol recording**: Logs every raw WebSocket message to JSONL with 100K-line rotation
- **Protocol drift detection tests**: Snapshots expected message shapes; fails when CLI changes protocol
- **Cron scheduled tasks**: Automated recurring agent runs
- **PostHog analytics**: Integrated usage tracking

### Happy

Multi-platform Claude Code client (native mobile, web, browser extensions). TypeScript/Yarn monorepo (4 packages), Fastify 5, Expo + React Native + Tauri. ~129K LOC. Supports Claude Code, Codex, and Gemini.

**Key features observed:**
- **Multi-platform native**: Android, iOS, Linux, Windows, Chrome/Safari extensions
- **Realtime voice**: Voice interaction powered by GPT-4.1 speech
- **E2E encryption as headline feature**: Zero-knowledge architecture — server cannot read messages
- **Push notifications**: Native mobile lock-screen notifications for session activity
- **Code diff view**: Syntax-highlighted diffs as primary content view
- **Git status bar**: Branch name + file change counts (+18 -18) at bottom of session
- **Descriptive session names**: Auto-generated from task context ("Voice Session Management in Mobi...", "OpenTunnel Dependency Upgrade...")
- **PostgreSQL + Redis + S3**: Full persistence layer (vs. BeamCode's JSON files)
- **MCP protocol support**: Integrated `@modelcontextprotocol/sdk` for tool bridging
- **Prometheus metrics**: Counters/histograms for request latency, active sessions, error rates
- **macOS launchd integration**: Proper daemon lifecycle management
- **Idempotent message delivery**: All mutations safe to retry (critical for mobile)
- **QR device linking**: Pair mobile devices to sessions

### Hello Halo

Open-source desktop application wrapping Claude Code agent for non-technical users. Electron 28 + React 18 + Zustand + Tailwind 3.4 + Vite. ~78K LOC. MIT licensed. v1.2.17. Largely self-built using AI.

**Key features observed:**
- **Content Canvas**: In-app preview for code (CodeMirror 6), HTML (iframe), Markdown (Streamdown/Shiki), images (zoom/pan), JSON, CSV, and live browser — tabbed artifact viewer
- **Artifact Rail**: Real-time file list sidebar showing all files AI creates/modifies
- **Space System**: Isolated workspaces with own files, conversations, and context (like VS Code workspaces)
- **AI Browser**: Embedded Chromium (BrowserView + CDP) with 26 tools — navigation, input, snapshot, performance, network monitoring, device emulation. Uses accessibility tree UIDs instead of CSS selectors (lower token cost)
- **Remote Access**: Cloudflare Quick Tunnel (no account needed) + 6-digit PIN auth + WebSocket sync — access from phone/tablet/browser
- **Multi-provider**: Anthropic, OpenAI, DeepSeek, GitHub Copilot, custom OpenAI-compatible APIs via an OpenAI compatibility router that translates SDK requests bidirectionally
- **V2 Sessions**: Process-reuse architecture from Claude Code SDK — reuses running process across messages, avoids 3-5s cold start per message
- **Tool Permissions**: Approve/reject file/command operations with visual previews before execution
- **i18n**: Full internationalization (EN, ZH-CN, ZH-TW, ES, DE, FR, JA) via i18next
- **One-click install**: Native installers (DMG/EXE/AppImage) with auto-updates — no npm/Node.js setup
- **File explorer**: react-arborist tree with file watching via separate worker process (@parcel/watcher)
- **Diff viewer**: react-diff-viewer-continued for file comparisons
- **Conversation search**: Full-text search across conversations
- **Performance**: Lazy thoughts (stored separately, ~97% of data), LRU conversation cache, debounced index writes, virtualized lists (Virtuoso)
- **Health system**: Process monitoring, orphan detection, automatic recovery
- **Stealth mode**: 15 anti-detection evasions for AI Browser (prevents automated browser detection)
- **Dark/light theme**: System-aware theming with CSS variables
- **MCP support**: Compatible with Claude Desktop MCP servers
- **Analytics**: Optional GA4 + Baidu Analytics

**Architecture notes:**
- Multi-process Electron: Main (Node.js) ↔ Renderer (Chromium) via IPC, with HTTP/WS server for remote clients
- Unified API adapter: same React app runs in both Electron (IPC) and web (HTTP) modes
- File-based storage under `~/.halo/` (no external database) with atomic .tmp writes
- 60+ IPC channels organized by domain (auth, config, space, conversation, agent, artifact, search, browser, remote, system)
- 8 Zustand stores (app, chat, space, canvas, search, onboarding, perf, ai-browser)
- Uses `@anthropic-ai/claude-agent-sdk` directly (not CLI WebSocket bridge)

### Project Comparison

| Dimension | BeamCode | Companion | Happy | Halo |
|-----------|----------|-----------|-------|------|
| Identity | Universal adapter library | Web application | Full-stack product | Desktop app (Electron) |
| Scale | ~40K LOC | ~45K LOC | ~129K LOC | ~78K LOC |
| Agents supported | 25+ (4 adapters) | 2 | 3 | 1 (Claude Code SDK) + multi-provider |
| Runtime | Node.js ≥ 22 | Bun | Node.js ≥ 20 | Electron 28 (Node.js) |
| Database | JSON files | JSON files | PostgreSQL + Redis | JSON files (~/.halo/) |
| Encryption | libsodium (relay) | None | libsodium + tweetnacl (client-side) | None (deprecated safeStorage) |
| Agent protocol | BackendAdapter interface | Inline ws-bridge | Inline per-agent modules | Claude Agent SDK direct |
| Monitoring | None | PostHog | Prometheus | GA4 + Baidu (optional) |
| Distribution | npm / web | npm | npm | Native installers (DMG/EXE/AppImage) |
| Remote access | Cloudflare Tunnel + token | None observed | QR device linking | Cloudflare Quick Tunnel + PIN |
| i18n | None | None observed | None observed | 7 languages |
| AI Browser | None | None | None | 26-tool embedded Chromium |

### Competitive Gap Cross-Reference

| Competitor Feature | Source | BeamCode Backend | Gap Item | Status |
|---|---|---|---|---|
| Multi-backend toggle | Companion | 4 adapters ready | P3-1 | **✅ Shipped** (PR #26) — AdapterSelector dropdown |
| Session archiving with count | Companion | archive/unarchive commands | P1-4 | **✅ Shipped** (PR #25) |
| E2E encryption indicator | Happy | Full crypto stack | P0-4 | **✅ Shipped** (PR #26) — lock icon in TopBar |
| Branch/folder picker toolbar | Companion | `repo_root`, `git_branch` in state | P1-7 | **✅ Shipped** (PR #25) — StatusBar |
| Environment management | Companion | Not yet in backend | — | Future consideration |
| Notification controls | Companion | Not yet in backend | P2-7 | **✅ Shipped** (PR #25/#26) — UI + Web Audio + Browser Notifications |
| Image upload in composer | Companion | Depends on backend adapter | — | **✅ Shipped** (PR #14) — CW-5 |
| Voice input | Happy | Not in scope | — | Differentiator for Happy, not us |
| Mobile native apps | Happy | Not in scope | — | Differentiator for Happy, not us |
| Git status bar (ahead/behind) | Happy | `git_ahead`/`git_behind` in state | P2-8 | **✅ Shipped** (PR #25) |
| Session naming | Companion, Happy | Auto-generated IDs currently | P1-8 | **✅ Shipped** (PR #25/#26) — auto-name on first turn + secret redaction |
| Project grouping with count | Companion | `cwd` available per session | P2-9 | **✅ Shipped** (PR #25) |
| Content Canvas (artifact preview) | Halo | Tool results in messages | CW-7 | **Mostly shipped** (PR #25/#26) — PreBlock with line numbers/copy/ANSI strip, MarkdownBlock, grep highlighting |
| AI Browser (embedded Chromium) | Halo | Not in backend | — | New consideration — see MA-5 |
| Workspace/Space system | Halo | `cwd` per session | — | Sessions approximate this, no explicit "space" abstraction |
| File explorer tree | Halo | Not in frontend | — | New consideration — see P3-8 |
| i18n (7 languages) | Halo | Not implemented | — | Future consideration for international adoption |
| One-click native install | Halo | npm-based install | — | Different distribution model (web-first vs. desktop-first) |
| Multi-provider (OpenAI compat router) | Halo | 4 adapters (different approach) | P3-1 | BeamCode adapts to CLIs; Halo adapts API protocols |
| Tool permission previews | Halo | Full permission system | — | **✅ Shipped** — DiffView, PreBlock in PermissionBanner |
| Conversation search | Halo | Session search in sidebar | — | **✅ Shipped** (PR #14) — CW-2 |
| Process health/recovery | Halo | Circuit breaker + reconnect | P0-1/P0-3 | **✅ Shipped** (PR #26) — circuit breaker + watchdog banners |

### New Items from Competitive Analysis

#### P1-7: Context Toolbar (Branch, Folder, Worktree) — **SHIPPED (PR #25)**

**Competitive evidence**: Companion's bottom toolbar packs folder, branch, worktree, env, and model selectors into a single compact bar.

**Shipped in PR #25** as `StatusBar.tsx` (338 lines) below the composer:
- ✅ Adapter type badge (claude/codex/continue/gemini) with color coding
- ✅ Current working directory (derived from `cwd` via `cwdBasename()`)
- ✅ Git branch name from `state.git_branch`
- ✅ Git ahead/behind indicators (↑N green, ↓N amber) from `state.git_ahead`/`git_behind`
- ✅ Worktree badge when `state.is_worktree` is true
- ✅ Permission mode picker (moved from TopBar)
- ✅ Model picker with dropdown (moved from TopBar)

#### P1-8: Descriptive Session Names — **SHIPPED (PR #25/#26)**

**Competitive evidence**: Both competitors auto-generate meaningful session names — Companion uses creative names ("Deft Quartz"), Happy uses task-derived names ("OpenTunnel Dependency Upgrade").

**Wired in PR #25**:
- ✅ `session_name_update` WS message type defined in protocol
- ✅ Frontend handler stores name via `store.updateSession()`
- ✅ Sidebar displays `info.name` with fallback to `cwdBasename(info.cwd)`
- ✅ Backend `broadcastNameUpdate()` API with tests

**Shipped in PR #26** (completing the gaps):
- ✅ Auto-naming trigger on `session:first_turn_completed` event
- ✅ Name derived from first user message (truncated to ~50 chars, first line only)
- ✅ Secret redaction applied before persisting/broadcasting (`redactSecrets()` utility)
- ✅ Persists name via storage + broadcasts to consumers

**Remaining gap**:
- ❌ No click-to-rename UI in sidebar (minor — names auto-generate well)

#### P2-7: Notification Preferences — **SHIPPED (PR #25/#26)**

**Competitive evidence**: Companion has Sound on/off and Alerts on/off toggles in sidebar.

**Shipped in PR #25** (sidebar footer):
- ✅ Sound toggle (speaker icon with on/off state) — persists to localStorage via `beamcode_sound`
- ✅ Alerts toggle (bell icon with on/off state) — persists to localStorage via `beamcode_alerts`
- ✅ Dark mode toggle (sun/moon icon) — persists to localStorage, fully functional

**Shipped in PR #26** (completing the behavior wiring):
- ✅ Web Audio API helper (`audio.ts`) — synthesized beep via `OscillatorNode` (440Hz, 200ms)
- ✅ `AudioContext` created lazily on first user gesture (click/keydown) to comply with autoplay policy
- ✅ Sound plays on `result` messages when `soundEnabled` and `document.hidden`
- ✅ Browser Notification dispatched on `result` when `alertsEnabled` and `document.hidden`
- ✅ `Notification.permission` checked on mount, requested if `alertsEnabled` is true
- ✅ Both gated on `document.hidden` to avoid noise when user is looking at the tab

#### P2-8: Git Ahead/Behind Indicator — **SHIPPED (PR #25)**

**Competitive evidence**: Happy shows branch + file change counts in a status bar.

**Shipped in PR #25** (StatusBar):
- ✅ Reads `git_ahead` and `git_behind` from session state
- ✅ Conditionally renders ↑N (green) and ↓N (amber) when values > 0
- ✅ Displayed inline with branch name in StatusBar
- ✅ Real-time updates via Zustand store

#### P2-9: Session Grouping by Project — **SHIPPED (PR #25)**

**Competitive evidence**: Companion groups sessions under project headers ("claude-code-api") with running count ("1 running").

**Shipped in PR #25** (Sidebar):
- ✅ Dynamic grouping logic: groups active sessions by project (derived from `cwdBasename(cwd)`)
- ✅ Collapsible `<details>` headers with project name + running count ("1 running")
- ✅ Total session count in muted text
- ✅ Conditional: flat list when only 1 project group, grouped view when multiple
- ✅ Running count derived from `state === "running" || state === "connected"`

### Frontend Quick Wins from Competitive Analysis

Broader competitive research (Cursor, Cline, Copilot, etc.). **Six of eight shipped in PR #14.**

| Item | Status | Implementation |
|------|--------|---------------|
| CW-1: Keyboard Shortcuts | **Shipped** | `useKeyboardShortcuts` hook + `ShortcutsModal` (Cmd+B sidebar, Cmd+. panel, `?` help, Esc close) |
| CW-2: Session Search | **Shipped** | `filterSessionsByQuery()` — case-insensitive on name/cwd, real-time filtering |
| CW-3: "Allow All" Permissions | **Superseded by P1-5** | Replaced by PermissionModePicker with Default/Plan/YOLO modes (PR #25) |
| CW-4: Code Diff View | **Shipped** | `DiffView.tsx` using `diff` library, color-coded, integrated in PermissionBanner + ToolBlock |
| CW-5: Image Drag-and-Drop | **Shipped** | Drag + paste support, 10MB/10-image limits, base64 encoding, preview thumbnails |
| CW-6: Conversation Export | **Shipped** | JSON + Markdown export from TaskPanel, auto-generated filenames |
| CW-7: Inline Tool Rendering | **Mostly shipped** | PreBlock for Bash/Read/Write/Edit/Grep/Glob, MarkdownBlock for WebFetch/WebSearch, JsonBlock fallback. **Missing**: syntax highlighting, ANSI colors, line numbers |
| CW-8: Plan/Act Mode Toggle | **Not started** | No state, UI, or backend message type |

#### CW-7: Inline Tool Result Rendering — **SIGNIFICANTLY IMPROVED (PR #25)**

**Done** (permission previews, PR #23): Bash shows `$ command`, Edit shows DiffView, Write shows file path + content preview, Read/Glob/Grep show pattern in monospace.

**Shipped in PR #25** (`ToolResultBlock.tsx`):
- ✅ `PreBlock` renderer for Bash, Read, Write, Edit, Grep, Glob — monospace with 50-line truncation and expand button
- ✅ `MarkdownBlock` renderer for WebFetch, WebSearch — rendered as formatted markdown
- ✅ `JsonBlock` fallback for MCP/unknown tools — pretty-printed JSON
- ✅ O(1) `toolNameByUseId` Map in `AssistantMessage` for efficient tool name lookups
- ✅ 9 `ToolResultBlock` tests

**Enhanced in PR #26**:
- ✅ Line numbers on monospace blocks (gutter column)
- ✅ Copy-to-clipboard button (appears on hover, top-right corner)
- ✅ ANSI code stripping for Bash output (`ansi-strip.ts` utility)
- ✅ Grep match highlighting with `bc-accent/20` background

**Remaining gaps**:
- ❌ No syntax highlighting for language-specific output (would need a library like Shiki/Prism)

#### CW-8: Plan/Act Mode Toggle

Maps to Claude Code's existing plan mode. Toggle in TopBar + visual mode indicator. Cline has Plan/Act toggle, Windsurf has Write/Chat/Turbo modes.

**Effort**: M (needs new inbound message type) | **Impact**: High
**Risk**: Different CLIs have different mode concepts. Ship as visual indicator first.

### Multi-Agent Moat Features

BeamCode's multi-adapter architecture enables features no single-agent tool can replicate:

#### MA-1: Multi-Agent Orchestration Dashboard

Dashboard view showing all active sessions with status, progress, model, cost, adapter type. ~~**Prerequisite**: Refactor `ws.ts` from singleton WebSocket to `Map<string, WebSocket>` connection manager.~~ **Unblocked** — ws.ts refactor shipped in PR #22. Cursor 2.0 supports up to 8 agents in parallel; Copilot has Agent HQ.

**Effort**: L | **Impact**: High | **Blocked by**: ~~ws.ts refactor~~ **Nothing — ready to build**

#### MA-2: Embedded Terminal (xterm.js)

Add xterm.js in `ToolBlock.tsx` when `name === "Bash"` and content contains ANSI sequences. Companion already has this.

**Effort**: M | **Impact**: Medium

#### MA-3: Cross-Agent Routing

User describes a task. BeamCode suggests or auto-routes to the best agent (Aider for git ops, Codex for greenfield, Claude Code for refactoring). No competitor can build this because they're single-agent systems.

**Effort**: XL | **Impact**: High (unique to BeamCode)

#### MA-4: Agent Performance Benchmarking

Track which agent is fastest, cheapest, and most accurate per task type. Cross-agent visibility that no single-agent tool has.

**Effort**: L | **Impact**: High (unique to BeamCode)

### Borrowable Backend Ideas

Features observed in competitors that would strengthen BeamCode's backend:

| Priority | Feature | Source | Rationale |
|----------|---------|--------|-----------|
| 1 | Protocol recording (JSONL) | Companion | Debug aid for 25+ adapters; intercept at `SessionBridge` |
| 2 | Prometheus metrics | Happy | Visibility into rate limiter, circuit breaker, sessions |
| 3 | Protocol drift detection tests | Companion | Prevent silent adapter breakage across 4 protocols |
| 4 | Idempotent message delivery | Happy | Correctness fix for reconnection replay — add idempotency keys to `UnifiedMessage` |
| 5 | V2 Session process reuse | Halo | Reuse running Claude Code process across messages — avoids 3-5s cold start per turn. Halo's biggest perf win. |
| 6 | MCP transport (expose BeamCode as MCP server) | Happy | Future-proof as MCP becomes the standard |
| 7 | Zero-knowledge encryption upgrade | Happy | Per-message encryption, not just transport-level — daemon becomes dumb relay |
| 8 | macOS launchd integration | Happy | "Install and forget" daemon management |
| 9 | Lazy thought storage | Halo | Separate thought/reasoning data from conversation JSON (~97% reduction). Applies to message history caching. |

### Competitive Threat Assessment

| Competitor | Can Replicate Moat? | Threat |
|------------|---------------------|--------|
| VS Code Copilot (Agent HQ) | Yes — already announced | **CRITICAL** |
| Cursor 2.0 | Yes — resources + Composer | HIGH |
| Windsurf | Yes — Cascade autonomous mode | HIGH |
| Continue | Yes — open-source, extensible | MEDIUM |
| Hello Halo | No — single-agent, desktop-first | LOW |
| LibreChat | Maybe — multi-model, not multi-agent | LOW |

**What BeamCode can do that they can't:**
1. **Protocol-agnostic**: VS Code will likely lock to Microsoft models. BeamCode connects to ANY CLI.
2. **Remote access**: VS Code can't run on an iPad. BeamCode can.
3. **Cross-agent routing**: Single-agent tools have no incentive to recommend competitors.
4. **Agent benchmarking**: No cross-agent visibility in single-agent tools.

**What Halo does better than BeamCode today:**
1. **Content Canvas**: Rich artifact preview (CodeMirror, HTML iframe, image zoom/pan, CSV tables) — BeamCode has basic PreBlock/MarkdownBlock renderers.
2. **AI Browser**: 26-tool embedded Chromium with accessibility tree — BeamCode has nothing comparable.
3. **One-click install**: Native desktop installers — BeamCode requires npm setup.
4. **i18n**: 7 languages — BeamCode is English-only.
5. **File explorer**: Interactive tree view of workspace files — BeamCode has no file browser.

**Why Halo is LOW threat:**
- Locked to Claude Code SDK (not CLI adapter, not multi-agent)
- Desktop-first (Electron) limits deployment flexibility — no headless daemon mode
- No multi-agent orchestration, no cross-agent routing
- No E2E encryption
- BeamCode's adapter architecture is fundamentally more extensible

#### P3-8: File Explorer Tree (New from Halo)

**Competitive evidence**: Halo ships a full interactive file tree (react-arborist) with file watching via a separate worker process. Companion has a folder picker in its bottom toolbar.

**Backend has**: `cwd` and `repo_root` per session. No file listing API.

**Proposed UI**: Collapsible file tree in TaskPanel or dedicated panel:
- Show workspace files from `cwd`
- Click to open in external editor
- Highlight files modified by agent (from Edit/Write tool calls)

**Effort**: M (needs backend API for directory listing) | **Impact**: Medium — useful for workspace awareness but most users have IDE open alongside

#### MA-5: AI Browser Module (New from Halo)

**Competitive evidence**: Halo ships a 26-tool embedded Chromium browser using CDP with accessibility tree element identification (lower token cost than CSS selectors).

**Relevance to BeamCode**: BeamCode is web-based (not Electron), so embedded BrowserView is not directly available. Browser automation could be surfaced via MCP tools or a companion service, but this is a different architectural approach.

**Effort**: XL | **Impact**: Medium — niche use case
**Decision**: Not planned — wrong abstraction layer for a web-based product. Cut.

### Cut List (decided not to build)

| Feature | Why Cut |
|---------|---------|
| Artifact/Canvas rendering | Wrong product category — users have code in their IDE. Security risk. Halo does this well but targets non-developers. |
| Voice input | Developers don't dictate code. Web Speech API unreliable for technical vocab. |
| Conversation branching | Requires complex tree data model. Low ROI — users just create new sessions. |
| MCP server management UI | Setup-time operation, not daily workflow. Agents manage their own configs. |
| Persistent agent memory UI | Creates conflict with file-based CLAUDE.md system. |
| Embedded AI browser | Web-based product can't use Electron BrowserView. Browser automation better served by MCP tools. Halo differentiator, not ours. |
| Native desktop installers | BeamCode is web-first daemon architecture. Electron packaging adds complexity without clear benefit for developer audience. |
| i18n (multi-language) | Low priority for developer-focused tool. Code and agent output is English. May reconsider later. |

---

## Priority 0 — Critical Gaps (Users Are Flying Blind)

### P0-1: Circuit Breaker State Visibility — **SHIPPED (PR #26)**

**Shipped in PR #26**:
- ✅ `SlidingWindowBreaker.getSnapshot()` returns `{ state, failureCount, recoveryTimeRemainingMs }` (relative, no server clock leak)
- ✅ `ProcessSupervisor` enriches `process:exited` event payload with breaker snapshot when OPEN/HALF_OPEN
- ✅ `SessionBridge` broadcasts `circuitBreaker` field in `session_update`
- ✅ `ConnectionBanner.tsx` renders state-aware messaging with countdown timer:
  - OPEN: "CLI restart protection active — cooling down (Ns remaining)..."
  - HALF_OPEN: "Testing connection stability..."
- ✅ `useCountdown` hook for live countdown display
- ✅ Types added to `ConsumerSessionState` and `shared/consumer-types.ts`

---

### P0-2: Process State Machine

**Problem**: Sessions have 4 states (starting → connected → running → exited) but UI only tracks a boolean `cliConnected`.

**Backend has** (`src/types/session-state.ts`):
- `state`: "starting" | "connected" | "running" | "exited"
- `pid`, `exitCode`, `cliSessionId`, `archived`
- Process events: spawned, exited (with uptimeMs), resume_failed

**Frontend shows**: Green/yellow/red dot for connection status.

**Proposed UI**: Color-coded session state badge:
- 🟢 Running — normal operation
- 🟡 Starting — process spawned, waiting for WebSocket
- 🔴 Exited (code 1) — show exit code, link to logs
- ⚪ Archived — hibernated session

**Effort**: S (map existing state to badge)
**Impact**: High — users understand session lifecycle

---

### P0-3: Reconnection Watchdog Visibility — **SHIPPED (PR #26)**

**Shipped in PR #26**:
- ✅ `SessionManager` emits `watchdog:active` with `{ gracePeriodMs, startedAt }` and `watchdog:timeout`
- ✅ `SessionBridge` broadcasts `watchdog` field in `session_update`
- ✅ `ConnectionBanner.tsx` shows live countdown: "Waiting for CLI to reconnect (Ns remaining)..."
- ✅ After timeout: "CLI did not reconnect — relaunching..."
- ✅ `useCountdown` hook powers the timer display

---

### P0-4: Encryption Status Indicator — **SHIPPED (PR #26)**

**Shipped in PR #26**:
- ✅ `encryption: { isActive, isPaired }` included in `session_init` message (participant-only for security)
- ✅ `TopBar.tsx` renders lock icon when encrypted+paired, warning icon when active but unpaired
- ✅ Tooltip: "E2E encrypted" / "Encryption active — not yet paired"
- ✅ Only shown when `encryption.isActive` is true (no icon for local-only sessions)
- ✅ Types added to `ConsumerSessionState` and `shared/consumer-types.ts`

---

### P0-5: Observer Role UI Enforcement — **SHIPPED (PR #23/#25/#26)**

**Shipped in PR #23/#25**:
- ✅ Composer disabled for observers, placeholder shows "Observer mode — read-only"
- ✅ Send button disabled for observers
- ✅ Model picker disabled for observers
- ✅ Permission mode picker disabled for observers
- ✅ Observer badge shown in TopBar
- ✅ Identity/role received via `identity` WS message and stored

**Shipped in PR #26** (completing the gaps):
- ✅ Observer banner above composer: "You are observing this session (read-only)"
- ✅ Permission action buttons hidden in `PermissionBanner` for observers
- ✅ New message types (`process_output`, circuit breaker) added to `PARTICIPANT_ONLY_TYPES`
- ✅ Doc comment on `createAnonymousIdentity()` noting observer mode requires a configured `Authenticator`

---

## Priority 1 — High-Impact Gaps

### P1-1: Process Output Streams (Logs) — **SHIPPED (PR #26)**

**Shipped in PR #26**:
- ✅ `SessionBridge` forwards `process:stdout`/`process:stderr` as `{ type: "process_output", stream, data }` messages
- ✅ Secret redaction filter applied before forwarding (strips `sk-ant-*`, `ghp_*`, `Bearer *`, API keys, etc.)
- ✅ `process_output` added to `PARTICIPANT_ONLY_TYPES` — observers cannot see process logs
- ✅ Backend ring buffer: last 500 lines per session
- ✅ `LogDrawer.tsx` — side panel with scrollable monospace output, auto-scroll, Escape-to-close
- ✅ Frontend caps at 200 lines (FIFO eviction)
- ✅ "View Logs" button in StatusBar
- ✅ Store: `processLogs: Record<sessionId, string[]>`, `logDrawerOpen: boolean`

---

### P1-2: Tunnel URL Display & Sharing

**Backend has** (`src/relay/cloudflared-manager.ts`):
- Dev mode: free `https://<random>.trycloudflare.com` tunnels
- Prod mode: custom domain with `CLOUDFLARE_TUNNEL_TOKEN`
- `tunnelUrl` getter, auto-restart with backoff

**Frontend shows**: Nothing. Remote access feature is completely invisible.

**Proposed UI**: "Share Session" button in TopBar → modal:
- Full shareable URL
- QR code for mobile/tablet
- Tunnel status badge ("Tunneled via Cloudflare" vs. "Local only")
- Security note: "Pair device for encrypted access"

**Effort**: M
**Impact**: Unlocks the entire remote access feature

---

### P1-3: Device Pairing Flow

**Backend has** (`src/utils/crypto/pairing.ts`):
- 60-second expiring pairing links
- One-time use (invalidated after first pair)
- QR-ready URL format: `https://<tunnel>/pair?pk=<base64>&fp=<hex>&v=1`
- Revocation API (destroys keypair, forces re-pair)

**Frontend shows**: Nothing.

**Proposed UI**: Pairing modal (triggered from "Share Session"):
1. Generate pairing link with 60s countdown timer
2. Show QR code + copy-to-clipboard
3. "Revoke Link" button
4. Post-pair: show "Device paired ✓" with fingerprint

**Effort**: M
**Impact**: Critical for secure multi-device access

---

### P1-4: Session Archive Management — **SHIPPED (PR #25)**

**Backend has** (`src/types/operational-commands.ts:52-73`, `src/interfaces/storage.ts`):
- `archive_session` / `unarchive_session` commands
- `setArchived(sessionId, archived)` in storage layer
- Both FileStorage and MemoryStorage implement it

**Shipped in PR #25**:
- ✅ REST endpoints: `PUT /api/sessions/:id/archive` and `PUT /api/sessions/:id/unarchive`
- ✅ Archive toggle button on session hover in sidebar
- ✅ Active/archived section split with collapsible "ARCHIVED (N)" section
- ✅ Archived sessions rendered with `opacity-60` visual distinction
- ✅ Archiving active session auto-switches to next active session
- ✅ Unarchive button on archived sessions
- ✅ 6 archive management tests

---

### P1-5: Permission Mode Display & Picker — **SHIPPED (PR #25)**

**Problem**: Approval fatigue is the #1 daily pain point. The existing "Allow All" button (CW-3) is ineffective because the backend sends permissions one at a time — the queue is almost always size 1. What users actually want is a session-scoped "Always Allow" mode like Cursor/Cline offer.

**Backend has** (`src/types/session-state.ts:30`, `src/types/inbound-messages.ts:21`):
- `permissionMode` tracked in session state
- `set_permission_mode` inbound message to change it

**Shipped in PR #25**:
- ✅ `PermissionModePicker` dropdown in StatusBar with 3 modes: Default, Plan, YOLO (bypassPermissions)
- ✅ Sends `set_permission_mode` message to backend on selection
- ✅ Optimistic UI with `pendingMode` state for instant visual feedback
- ✅ Color-coded badges (blue for Default, amber for Plan, red for YOLO)
- ✅ Mode descriptions in dropdown
- ✅ Observer-aware: disabled for non-participants
- ✅ Click-outside and Escape key to close dropdown

**Enhanced in PR #26** (YOLO mode safeguards):
- ✅ Renamed "YOLO" to "Auto-Approve (Unrestricted)" for clarity
- ✅ Confirmation dialog when selecting `bypassPermissions`: "Auto-approve all tool executions? This grants unrestricted access."
- ✅ Visual warning indicator (yellow/orange border on StatusBar) when `bypassPermissions` is active

**Remaining gap**:
- ❌ No auto-respond behavior — `PermissionBanner` still appears. Backend may need to handle auto-approval, or frontend could auto-respond with `behavior: "allow"` when mode is `bypassPermissions`.

---

### P1-6: Resume Failure Notification — **SHIPPED (PR #26)**

**Shipped in PR #26**:
- ✅ `SessionBridge` listens to `process:resume_failed`, broadcasts `{ type: "resume_failed", sessionId }` to consumers
- ✅ `ws.ts` handles `resume_failed` → `store.addToast("Could not resume previous session — starting fresh", "error")`
- ✅ Toast system (foundation) with auto-dismiss for info/success (5s), manual close for errors
- ✅ `ToastContainer.tsx` with fade-slide-in animation, max 5 visible (FIFO eviction)

---

## Priority 2 — Operational Visibility

### P2-1: Connection Health Dashboard — **SHIPPED (PR #26)**

**Shipped in PR #26**:
- ✅ `HealthSection` in `TaskPanel.tsx` showing:
  - Connection status dot (green/yellow/red) with label (Healthy/CLI disconnected/Connecting/Disconnected)
  - Reconnect attempt counter
  - Circuit breaker state and failure count when OPEN/HALF_OPEN
- ✅ Data sourced from existing store (connectionStatus, cliConnected, reconnectAttempt, circuitBreaker)

---

### P2-2: Latency Breakdown — **SHIPPED (PR #23)**

**Backend has**:
- `duration_ms` (total turn time) — already sent to frontend
- `duration_api_ms` (API-only time) — sent but not displayed
- `latency` metric events with operation names

**Shipped in PR #23** (ResultBanner):
- ✅ Shows total duration with API breakdown: "2.3s (API 1.9s)"
- ✅ Highlights slow turns (>5s) with warning color
- ✅ Handles clock skew by clamping `duration_api_ms` to `duration_ms`
- ✅ Omits API breakdown when value is 0 or absent
- ✅ Comprehensive tests (5 latency-related test cases)

**Remaining gap**:
- ❌ No "slow turn" detection relative to rolling average (just absolute >5s threshold)

---

### P2-3: Rate Limit Proximity Warning

**Backend has** (`src/adapters/token-bucket-limiter.ts`):
- Per-consumer token bucket: 50 tokens/sec, 20 burst
- `getTokens()` returns current bucket level

**Frontend shows**: Nothing. Messages silently ignored when rate limited.

**Proposed UI**:
- Composer disable when rate limited: "Sending too fast. Wait 2s..."
- Subtle indicator at 80% capacity

**Effort**: S (needs backend to send rate limit state)
**Impact**: Prevents silent message drops

---

### P2-4: System Health Dashboard

**Backend has** (`src/types/operational-commands.ts:75-87`):
- `GetHealthResponse`: status (ok/degraded/error), active sessions, CLI connections, consumer connections, uptime

**Frontend shows**: Nothing.

**Proposed UI**: Admin-accessible health panel:
- Status badge (🟢/🟡/🔴)
- Session capacity: "3/50 active sessions"
- Connection metrics
- System uptime

**Effort**: M
**Impact**: Essential for multi-user deployments

---

### P2-5: MCP Server Status Display — **SHIPPED (PR #23)**

**Backend has** (`src/types/session-state.ts:32`):
- `mcp_servers: { name: string; status: string }[]`
- Sent to frontend via `ConsumerSessionState`

**Shipped in PR #23** (TaskPanel):
- ✅ `McpServersSection` component with collapsible `<details>` element
- ✅ Server name + color-coded status badge (`MCP_STATUS_STYLES` maps connected/failed/retrying)
- ✅ Header shows "MCP Servers (N)" count
- ✅ Conditional render (null when no servers)
- ✅ Real-time updates from `session_update` messages

---

### P2-6: Active Users & Presence — **SHIPPED (PR #23)**

**Backend has**: `presence_update` messages with `{ userId, displayName, role }[]`

**Shipped in PR #23** (TaskPanel):
- ✅ `PresenceSection` component with "Connected Users (N)" header
- ✅ User list with display name and color-coded role badge (`ROLE_BADGE_STYLES`)
- ✅ Supports owner/operator/participant/observer roles with distinct colors
- ✅ Receives `presence_update` via WS handler (`ws.ts:207-208`)
- ✅ Uses `useShallow` for array selector performance

**Remaining gap**:
- ❌ No active/idle status indicator per user
- ❌ No role assignment dropdown for owners

---

## Priority 3 — Power User & Admin Features

### P3-1: Backend Adapter Selector — **SHIPPED (PR #26)**

**Competitive evidence**: Companion ships an inline "Claude Code | Codex" backend toggle. BeamCode has 4 adapters ready but zero UI to choose between them.

**Shipped in PR #26** (frontend UI only):
- ✅ `AdapterSelector` dropdown in `StatusBar.tsx` (replaced static `AdapterBadge`)
- ✅ Available adapters sourced from `capabilities_ready` message
- ✅ Sends `set_adapter` inbound message on selection
- ✅ Same dropdown pattern as `PermissionModePicker` (click-outside + Escape to close)
- ✅ `set_adapter` added to `InboundMessage` type and `shared/consumer-types.ts`
- ⚠️ **Backend handler deferred** — `routeConsumerMessage()` has no `case "set_adapter"` yet; adapter switching requires launcher-level changes (process teardown + relaunch with different adapter config)

### P3-2: Configuration Settings Panel

**Backend has** (`src/types/config.ts`): 50+ settings for timeouts, rate limits, circuit breaker, CLI binary, PTY execution.

**Proposed UI**: Settings modal with categorized sections (view-only for most, adjustable for key settings).
**Effort**: L | **Impact**: Unblocks enterprise/power users

### P3-3: Daemon Health Panel

**Backend has** (`src/daemon/`): PID, heartbeat, version, control API, lock file.

**Proposed UI**: Diagnostics panel showing daemon status, uptime, managed sessions.
**Effort**: M | **Impact**: Debugging tool

### P3-4: Slash Command Execution Method Badges

**Backend has**: 3 execution strategies (emulated, native, PTY).

**Proposed UI**: Icons in SlashMenu showing which commands work offline.
**Effort**: S | **Impact**: Low

### P3-5: Event Timeline / Activity Log

**Backend has**: All 13 metric event types + bridge events + launcher events.

**Proposed UI**: Scrollable event timeline in diagnostics panel.
**Effort**: L | **Impact**: Advanced debugging

### P3-6: Idle Session Timeout Warning

**Backend has** (`src/core/session-manager.ts:308-349`): Configurable idle reaper.

**Proposed UI**: Warning toast 5 minutes before auto-close.
**Effort**: S | **Impact**: Prevents surprise data loss

### P3-7: API Key Management

**Backend has**: Bearer token auth for `/api/*` endpoints.

**Proposed UI**: Settings panel with key display (masked), regenerate, copy.
**Effort**: M | **Impact**: Admin feature

---

## Implementation Roadmap

### Already Shipped (PR #14)

| Item | Implementation |
|------|---------------|
| ~~CW-1: Keyboard shortcuts~~ | `useKeyboardShortcuts` + `ShortcutsModal` |
| ~~CW-2: Session search~~ | `filterSessionsByQuery()` in Sidebar |
| ~~CW-3: "Allow All" permissions~~ | Batch approval when `permList.length > 1` |
| ~~CW-4: Code diff view~~ | `DiffView.tsx` in PermissionBanner + ToolBlock |
| ~~CW-5: Image drag-and-drop~~ | Drag + paste, 10MB limit, base64, previews |
| ~~CW-6: Conversation export~~ | JSON + Markdown from TaskPanel |

### Shipped in PRs #22–#25

| Item | PR | Implementation |
|------|-----|---------------|
| ~~ws.ts singleton→Map refactor~~ | #22 | Per-session `Map<string, WebSocket>` connection manager — **unblocks MA-1** |
| ~~P0-5: Observer role enforcement~~ | #23/#25 | Composer/buttons disabled, observer badge, identity WS handler |
| ~~P1-4: Archive management~~ | #25 | REST endpoints + sidebar UI with active/archived sections |
| ~~P1-5: Permission mode picker~~ | #25 | 3-mode dropdown in StatusBar with `set_permission_mode` backend integration |
| ~~P1-7: Context toolbar~~ | #25 | Full StatusBar: adapter, cwd, branch, ahead/behind, worktree, model |
| ~~P1-8: Session naming (partial)~~ | #25 | Protocol + handler + display wired |
| ~~P2-2: Latency breakdown~~ | #23 | ResultBanner shows "Total (API Xs)" with clamping |
| ~~P2-5: MCP server status~~ | #23 | `McpServersSection` in TaskPanel with status badges |
| ~~P2-6: Active users & presence~~ | #23 | `PresenceSection` in TaskPanel with role badges |
| ~~P2-7: Notification prefs (UI only)~~ | #25 | Sound/alerts/dark-mode toggles in sidebar footer |
| ~~P2-8: Git ahead/behind~~ | #25 | ↑N/↓N indicators in StatusBar |
| ~~P2-9: Session grouping~~ | #25 | Groups by project with running count |
| ~~CW-7: Tool result rendering (improved)~~ | #25 | PreBlock/MarkdownBlock/JsonBlock renderers per tool type |

### Shipped in PR #26 (UI Gap Phase 1 & 2)

| Item | Implementation |
|------|---------------|
| ~~P0-1: Circuit breaker banner~~ | `ConnectionBanner` with OPEN/HALF_OPEN states, countdown timer, `useCountdown` hook |
| ~~P0-3: Reconnect watchdog timer~~ | `ConnectionBanner` with watchdog countdown, backend `watchdog:active`/`watchdog:timeout` events |
| ~~P0-4: Encryption status icon~~ | Lock/warning icon in `TopBar`, participant-only `encryption` field in `session_init` |
| ~~P0-5: Observer banner (finish)~~ | Observer banner in `ChatView`, permission buttons hidden for observers |
| ~~P1-1: Process logs drawer~~ | `LogDrawer.tsx`, secret redaction, `PARTICIPANT_ONLY_TYPES` gating, ring buffer |
| ~~P1-6: Resume failure toast~~ | Toast system (`ToastContainer.tsx`), `resume_failed` WS handler |
| ~~P1-8: Session naming (finish)~~ | Auto-name on `first_turn_completed`, secret redaction, persist + broadcast |
| ~~P2-1: Connection health panel~~ | `HealthSection` in `TaskPanel` with status, reconnect attempts, circuit breaker |
| ~~P2-7: Notification behavior (finish)~~ | Web Audio API beep, Browser Notifications, gated on `document.hidden` |
| ~~CW-7: Tool result polish~~ | Line numbers, copy button, ANSI stripping, grep match highlighting |
| ~~P3-1: Adapter selector~~ | `AdapterSelector` dropdown in `StatusBar`, `set_adapter` inbound message (backend handler deferred — requires launcher-level changes) |
| ~~P1-5: YOLO safeguards~~ | Renamed to "Auto-Approve", confirmation dialog, warning indicator |

### Phase 1: Critical Visibility — **SHIPPED (PR #26)**

All 8 remaining Phase 1 items shipped in PR #26.

| Item | Effort | Backend Changes Needed | Status |
|------|--------|----------------------|--------|
| P0-1: Circuit breaker banner | S | Enriched `process:exited` payload + `getSnapshot()` | **✅ Shipped** (PR #26) |
| P0-2: Session state badge | S | None (data in session_update) | **✅ Already shipped** (PR #25) |
| P0-3: Reconnect watchdog timer | S | Watchdog events on SessionManager | **✅ Shipped** (PR #26) |
| P0-4: Encryption status icon | S | Encryption state in `session_init` | **✅ Shipped** (PR #26) |
| P0-5: Observer banner (finish) | XS | None | **✅ Shipped** (PR #26) |
| P1-6: Resume failure toast | S | Forward `process:resume_failed` via WS | **✅ Shipped** (PR #26) |
| P1-8: Session naming (finish) | S | Auto-name on `first_turn_completed` + secret redaction | **✅ Shipped** (PR #26) |
| P2-7: Notification behavior (finish) | S | None | **✅ Shipped** (PR #26) — Web Audio + Browser Notifications |

**0 items remaining.** Phase 1 is complete.

### Phase 2: Coding Workflow + Sharing — **MOSTLY SHIPPED (PR #26)**

6 of 8 items shipped in PR #26. Tunnel URL sharing and device pairing deferred to future PR.

| Item | Effort | Backend Changes Needed | Status |
|------|--------|----------------------|--------|
| CW-7: Tool result polish (syntax/ANSI) | S-M | None | **✅ Shipped** (PR #26) — line numbers, copy button, ANSI stripping, grep highlighting |
| CW-8: Plan/Act mode toggle | M | New inbound message type | **Superseded** — covered by PermissionModePicker "Plan" option (PR #25) |
| P1-1: Process logs drawer | M | Forward stdout/stderr via new WS msg + secret redaction | **✅ Shipped** (PR #26) |
| P1-2: Tunnel URL sharing | M | Expose tunnelUrl via WS or API | **Deferred** — future PR |
| P1-3: Device pairing flow | M | Expose pairing API to frontend | **Deferred** — future PR |
| P2-1: Connection health panel | M | Uses existing store data | **✅ Shipped** (PR #26) — HealthSection in TaskPanel |
| P2-4: Health dashboard | M | Merged into P2-1 | **✅ Shipped** (PR #26) — combined with connection health |
| P3-1: Adapter selector | S-M | `set_adapter` inbound message type | **✅ Shipped** (PR #26) |

**2 items remaining** (P1-2, P1-3) — deferred to future PR.

### Phase 3: Multi-Agent Moat + Advanced (4-6 weeks)

| Item | Effort | Backend Changes Needed | Status |
|------|--------|----------------------|--------|
| MA-1: Multi-agent dashboard | L | ~~ws.ts refactor~~ **Done (PR #22)** | Unblocked |
| MA-2: Embedded terminal (xterm.js) | M | None (data in tool results) | Not started |
| MA-3: Cross-agent routing | XL | Agent capability registry | Not started |
| MA-4: Agent benchmarking | L | Metrics collection per agent | Not started |
| P2-3: Rate limit warning | S | Send rate limit state via WS | Not started |
| P3-2: Settings panel | L | Config read API endpoint | Not started |
| P3-3: Daemon health panel | M | Expose daemon state file | Not started |
| P3-5: Event timeline | L | Stream metrics events via WS | Not started |
| P3-7: API key management | M | Key rotation API endpoint | Not started |

### Phase 4: Backend Hardening (ongoing)

| Item | Effort | Source |
|------|--------|--------|
| Protocol recording (JSONL) | M | Companion — debug aid for 25+ adapters |
| Prometheus metrics | M | Happy — visibility into rate limiter, circuit breaker |
| Protocol drift detection tests | M | Companion — prevent silent adapter breakage |
| Idempotent message delivery | S | Happy — correctness for reconnection replay |
| MCP transport (BeamCode as MCP server) | L | Happy — future-proof as MCP becomes standard |
| Zero-knowledge encryption | L | Happy — per-message encryption upgrade |
| macOS launchd integration | M | Happy — "install and forget" daemon |

---

## Technical Architecture Notes

### ~~The ws.ts Bottleneck~~ — **RESOLVED (PR #22)**

The singleton WebSocket was refactored to a per-session connection manager in PR #22:

```
// Before (PR #22):
let ws: WebSocket | null = null;
let activeSessionId: string | null = null;

// After (PR #22):
const connections = new Map<string, WebSocket>();
```

This unblocks: MA-1 (multi-agent dashboard), multi-model comparison, and the orchestration features that define BeamCode's moat. **Phase 3 is no longer blocked by ws.ts.**

### Protocol Gaps

| Feature | What's Missing |
|---------|---------------|
| Full file diff (CW-4) | `tool_result` for Edit is just "success" text, not before/after file content — partial diff from `input.old_string` vs `input.new_string` is available today |
| Plan/Act mode (CW-8) | No `set_mode` inbound message type |
| File upload (non-image) | No upload endpoint — image protocol exists though |

---

## Data Flow Gap Summary

Most backend data already exists and flows through existing channels. **Significant progress since the initial analysis** — 12+ items shipped across PRs #22–#25.

The remaining engineering work is:

1. **Frontend rendering** — most data is now displayed; remaining gaps are Phase 3 features
2. **New HTTP endpoints** (few) — health, config need REST API exposure
3. ~~**One critical refactor**~~ — ws.ts singleton → Map **completed in PR #22**
4. ~~**Behavior wiring**~~ — notification sound/alerts **completed in PR #26**; permission mode auto-approve still pending

**Key principle**: Phases 1-2 are complete. Phase 3 (multi-agent moat) is unblocked.

**Progress update**: Phase 1 is **100% complete** (all 8 items shipped across PRs #23–#26). Phase 2 is **~85% complete** (6 of 8 items shipped; tunnel URL sharing and device pairing deferred). The ws.ts refactor (Phase 3 blocker) is complete. PR #26 added 14 features spanning toast system, observer banner, resume failure toast, session auto-naming, notification wiring, encryption status, watchdog timer, circuit breaker banner, tool result polish, process logs drawer, connection health, YOLO safeguards, and adapter selector.

**Competitive insight**: The adapter selector (P3-1) is now shipped — BeamCode's strongest differentiator vs. both Companion and Happy, since the backend supports 4 adapters with compliance-tested interfaces.

**Strategic insight**: BeamCode cannot out-Cursor Cursor. The revised plan front-loaded quick wins that fix daily pain points. **Next priority**: multi-agent features (Phase 3) that no competitor can replicate.

---

## Appendix: Fields Available But Not Rendered

These fields are sent to the frontend in `ConsumerSessionState` or `session_update` messages. **Updated status after PRs #22–#25:**

| Field | Source | Rendering Status |
|-------|--------|-----------------|
| `permissionMode` | session_update | **✅ Rendered** — PermissionModePicker in StatusBar (PR #25) |
| `mcp_servers` | session_update | **✅ Rendered** — McpServersSection in TaskPanel (PR #23) |
| `is_worktree` | session_update | **✅ Rendered** — Worktree badge in StatusBar (PR #25) |
| `repo_root` | session_update | **✅ Rendered** — Used by StatusBar cwd display (PR #25) |
| `git_ahead` / `git_behind` | session_update | **✅ Rendered** — ↑N/↓N in StatusBar (PR #25) |
| `claude_code_version` | session_update | Not rendered |
| `last_duration_api_ms` | result message | **✅ Rendered** — ResultBanner API breakdown (PR #23) |
| `skills` (beyond slash menu) | capabilities_ready | Partially rendered |
| `archived` | session metadata | **✅ Rendered** — Archive sections in Sidebar (PR #25) |
| Role from `identity` message | identity | **✅ Enforced** — Observer mode in Composer/TopBar/StatusBar (PR #23/#25) |
| `adapterType` | session metadata | **✅ Rendered** — Adapter badge in StatusBar (PR #25) |
| `cwd` (for project grouping) | session metadata | **✅ Rendered** — Session grouping in Sidebar (PR #25) |

**Only `claude_code_version` and deep `skills` data remain unrendered.**

---

## Appendix B: Competitive Feature Matrix

### Frontend Features

| Feature | Companion | Happy | Halo | BeamCode (Current) | Status |
|---------|-----------|-------|------|--------------------|--------|
| Multi-backend selector | Claude Code + Codex | No | Multi-provider (OpenAI compat) | **✅ 4 adapters + selector UI** | P3-1 (PR #26) |
| Code diff view | Yes (DiffPanel) | Yes | Yes (react-diff-viewer) | **✅ Shipped** | CW-4 (PR #14) |
| Keyboard shortcuts | Unknown | Unknown | Unknown | **✅ Shipped** | CW-1 (PR #14) |
| "Allow All" permissions | Unknown | Unknown | Tool approve/reject | **✅ Permission mode picker** | P1-5 (PR #25) |
| Image upload | Composer button | Unknown | Unknown | **✅ Drag-and-drop** | CW-5 (PR #14) |
| Session archiving | ARCHIVED (N) section | No | No | **✅ Shipped** | P1-4 (PR #25) |
| Session naming | Creative auto-names | Task-derived names | No | **✅ Auto-naming + redaction** | P1-8 (PR #25/#26) |
| Session search | Unknown | Unknown | Full-text search | **✅ Shipped** | CW-2 (PR #14) |
| Session grouping | By project + count | Flat list | By space | **✅ Shipped** | P2-9 (PR #25) |
| Context toolbar (branch/folder) | Bottom toolbar bar | Git status bar | No | **✅ Full StatusBar** | P1-7 (PR #25) |
| Git ahead/behind | Branch picker | +N -N status bar | No | **✅ Shipped** | P2-8 (PR #25) |
| Notification controls | Sound/Alerts toggles | Native push | No | **✅ UI + Web Audio + Notifications** | P2-7 (PR #25/#26) |
| Terminal emulator (xterm.js) | Yes | No | No | No | MA-2 planned |
| E2E encryption indicator | Not visible | Headline feature | No | **✅ Lock icon in TopBar** | P0-4 (PR #26) |
| Observer role enforcement | Unknown | Unknown | No | **✅ Mostly shipped** | P0-5 (PR #23/#25) |
| Permission mode display | Unknown | Unknown | No | **✅ Shipped** | P1-5 (PR #25) |
| MCP server status | Unknown | Unknown | MCP support (config) | **✅ Shipped** | P2-5 (PR #23) |
| Plan/Act mode toggle | Unknown | Unknown | No | No | CW-8 not started |
| Conversation export | Unknown | Unknown | No | **✅ Shipped** | CW-6 (PR #14) |
| Tool result rendering | Unknown | Unknown | Tool approval UI | **✅ Per-tool renderers** | CW-7 (PR #25) |
| Latency breakdown | Unknown | Unknown | Token usage tracking | **✅ Shipped** | P2-2 (PR #23) |
| Connected users/presence | Unknown | Unknown | No (single-user) | **✅ Shipped** | P2-6 (PR #23) |
| Content Canvas (rich preview) | No | No | **Yes** (Code/HTML/MD/Image/JSON/CSV/Browser) | No | Cut |
| AI Browser (embedded) | No | No | **Yes** (26 tools, CDP, a11y tree) | No | Cut |
| File explorer tree | Folder picker | No | **Yes** (react-arborist + file watcher) | No | P3-8 |
| i18n (multi-language) | No | No | **Yes** (7 languages) | No | Cut |
| Dark/light theme | Unknown | Unknown | **Yes** (CSS variables, system-aware) | **✅ Shipped** | PR #25 |
| Remote access UI | No | QR linking | **Yes** (PIN + Cloudflare tunnel) | **Backend only** | P1-2 not started |

### Backend/Infrastructure Features

| Feature | Companion | Happy | Halo | BeamCode (Current) | Status |
|---------|-----------|-------|------|--------------------|--------|
| Multi-agent adapter abstraction | No | No | No | **Yes** (4 adapters) | ✅ Backend ready |
| Per-session WebSocket connections | Unknown | Unknown | Per-conversation V2 session | **Yes** (Map refactor) | ✅ PR #22 |
| E2E encryption | No | **Yes** (zero-knowledge) | No (deprecated safeStorage) | **Yes** (relay-level) | Phase 4 upgrade |
| RBAC (participant/observer) | No | No | No (single-user) | **Yes** + **UI enforcement** | ✅ PR #23/#25 |
| Rate limiting | No | No | No | **Yes** | ✅ Backend ready |
| Circuit breaker | No | No | Health system (recovery) | **Yes** | **✅ UI shipped** (PR #26) |
| Sequenced message replay | No | No | No | **Yes** | ✅ Backend ready |
| Protocol recording | **Yes** (JSONL) | **Yes** (JSONL) | No | No | Phase 4 |
| Protocol drift detection tests | **Yes** | No | No | No | Phase 4 |
| Prometheus metrics | No | **Yes** | No | No | Phase 4 |
| MCP protocol support | No | **Yes** | **Yes** (Claude Desktop compat) | No | Phase 4 |
| Idempotent messages | No | **Yes** | No | No | Phase 4 |
| macOS launchd daemon | No | **Yes** | No | No | Phase 4 |
| Session process reuse (V2) | Unknown | Unknown | **Yes** (avoids cold start) | No | Borrowable idea |
| Lazy thought storage | No | No | **Yes** (97% data reduction) | No | Borrowable idea |
| Cron scheduled tasks | **Yes** | No | No | No | Not planned |
| Voice input | No | **Yes** (GPT-4.1) | No | No | Cut |
| Mobile native | No | **Yes** (Expo) | No | No | Not planned |
| Desktop native | No | **Yes** (Tauri) | **Yes** (Electron 28) | No | Cut |
| AI Browser (embedded CDP) | No | No | **Yes** (26 tools) | No | Cut |
| Team/multi-agent observation | No | No | No | **Yes** | MA-1 (unblocked) |
| OpenAI-compatible API router | No | No | **Yes** (transparent SDK adapter) | No (different approach: CLI adapters) | — |
