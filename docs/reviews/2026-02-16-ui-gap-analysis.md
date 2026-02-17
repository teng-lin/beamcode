# UI Gap Analysis: Backend Capabilities Not Exposed in Frontend

**Date**: 2026-02-17 (updated with full competitive landscape — 25+ projects surveyed)
**Methodology**: 5-agent parallel review — session management, metrics/observability, process lifecycle, security/relay, and configuration/adapters + competitive analysis of 25+ competitor UIs and platforms
**Scope**: All `src/` backend capabilities vs. `web/` frontend coverage + comprehensive competitor feature comparison

---

## Executive Summary

BeamCode's backend is **production-grade** with sophisticated session management, fault tolerance, E2E encryption, multi-adapter support, and observability infrastructure. The frontend exposes **the core chat experience well** (messaging, streaming, permissions, teams, slash commands) and **now covers most session state and management features** thanks to PRs #22–#25. However, **3 capability domains remain largely invisible**: process lifecycle (circuit breaker, reconnect), security (encryption, pairing, tunnels), and advanced configuration.

### Coverage by Domain

| Domain | Backend Features | UI Coverage | Gap Severity |
|--------|-----------------|-------------|-------------|
| Core Chat (messaging, streaming, permissions) | 31 message types | ~95% | Low |
| Session State (model, cost, context, git) | 25+ fields | **~95%** | **Low** |
| Session Management (admin, archive, health) | 10 operational commands | **~60%** | **Medium** |
| Observability (metrics, latency, errors) | 15 metric event types | **~25%** | **High** |
| Process Lifecycle (circuit breaker, reconnect) | 22+ state dimensions | ~10% | **Critical** |
| Security (encryption, pairing, tunnels, roles) | 7 crypto modules + relay | ~0% | **Critical** |
| Configuration (adapters, settings, MCP) | 50+ config options, 4 adapters | **~25%** | **High** |

> **Note**: Coverage improved significantly in PRs #23–#25 (session management from 20%→60%, observability from 5%→25%, configuration from 5%→25%). See "Shipped in PRs #23–#25" section below for details.

---

## Competitive Landscape

The coding agent GUI market has **exploded** — 25+ active projects exist as of Feb 2026, most created in the last year. Analysis of direct competitors and the broader landscape reveals features that validate our gap findings and surface new opportunities.

> **Key market insight**: Claude Code has the most GUI wrappers (15+) of any coding agent CLI. Multi-agent support is the emerging differentiator — single-agent GUIs are commoditized. Tauri 2 dominates desktop; web-first remains rare. BeamCode's web-first daemon architecture and protocol-level adapter abstraction remain unique.

### Market Overview (25+ projects)

| Tier | Projects | Stars Range | Description |
|------|----------|-------------|-------------|
| **Platforms** | OpenHands, Cline, Aider, Tabby, Continue | 31K–68K | Complete agents with built-in UI (set UX standards) |
| **Major GUIs** | Opcode, CC-Switch, CloudCLI, Crystal, CUI, AiderDesk | 1K–21K | Dedicated GUI wrappers for coding agent CLIs |
| **Notable** | OpenWork, claude-code-webui, claude-code-viewer, CCManager, Agentrooms, claude-run, Codexia, Agent Sessions | 250–10K | Smaller but differentiated projects |
| **Niche** | Yume, sunpix/claude-code-web, vultuk/claude-code-web, claudeCO-webui, Codex-CLI-UI | <100 | Early-stage or single-purpose |
| **Infrastructure** | claude-flow, AG-UI Protocol | 3K–14K | Orchestration frameworks and protocols |

### Deep-Dive Competitors (directly relevant to BeamCode)

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

### Opcode (formerly Claudia)

The most-starred dedicated Claude Code GUI. Tauri 2 desktop app with React frontend and Rust backend. Built by Asterisk (YC-backed). AGPL-3.0 licensed. ~20.5K stars.

**Key features observed:**
- **OS-level sandboxing**: seccomp (Linux), macOS Seatbelt — enforces agent permissions at the OS level, not just UI
- **Custom agent creation**: Define permission-scoped agents with different capabilities
- **Checkpoint system**: Save/restore agent state mid-session
- **Background agents**: Run agents without active UI focus
- **Usage analytics**: Dashboard showing cost, tokens, session metrics
- **MCP server management**: Full UI for configuring MCP servers
- **Session management**: Persistence, archiving, history browsing

**Architecture notes:**
- Tauri 2 + React 18 + Rust backend + SQLite
- Claude Code SDK / CLI subprocess connection
- Native installers (macOS DMG, Windows MSI, Linux AppImage)

### CC-Switch

Cross-platform desktop all-in-one assistant supporting **4 coding agent CLIs**: Claude Code, Codex, OpenCode, AND Gemini CLI. ~18.5K stars. MIT licensed.

**Key features observed:**
- **4-agent provider management**: One-click switching between Claude Code, Codex, OpenCode, Gemini CLI
- **Multi-endpoint API key management**: Configure multiple API keys per provider with speed testing
- **Skills store ecosystem**: Marketplace for downloadable agent skills/presets
- **System prompt presets**: Pre-configured system prompts for different workflows
- **MCP server management**: Both stdio and HTTP/SSE MCP server support

**Architecture notes:**
- Tauri 2 + React + TypeScript
- CLI subprocess for all 4 agents
- Native installers including ARM64 Linux

### CloudCLI (Claude Code UI)

Web + mobile UI for Claude Code, Cursor CLI, and Codex. npm-distributed. ~6.3K stars. GPL-3.0.

**Key features observed:**
- **Mobile-first responsive design**: Strong mobile experience, usable on phones/tablets
- **Multi-CLI support**: Claude Code + Cursor CLI + Codex via CLI subprocess
- **Integrated shell terminal**: In-browser terminal access
- **File explorer**: Browse workspace files
- **Git explorer**: Visual git status and operations
- **Remote session management**: Access sessions from other devices

**Architecture notes:**
- JavaScript, distributed as npm package (`@siteboon/claude-code-ui`)
- CLI subprocess connection model

### Crystal

Electron desktop app focused on **parallel multi-session workflows** with git worktree isolation. ~2.9K stars. MIT licensed.

**Key features observed:**
- **Multi-session parallel execution**: Run multiple Claude Code + Codex sessions simultaneously
- **Git worktree isolation**: Each session gets its own worktree — prevents file conflicts between parallel agents
- **Built-in rebase/squash**: Merge worktree results back to main branch
- **Diff viewing**: Compare changes across sessions
- **AI session name generation**: Auto-generates descriptive session names
- **Desktop notifications**: Native OS notifications on session completion

**Architecture notes:**
- Electron + TypeScript + SQLite
- Claude Code CLI subprocess + git worktree orchestration

### CUI (Common Agent UI)

Web UI powered by Claude Code SDK with push notifications, dictation, and cron scheduling. ~1.1K stars. Apache-2.0.

**Key features observed:**
- **Cron scheduling**: Schedule agent tasks with cron expressions — unique feature
- **Dictation**: Voice-to-text input via Gemini 2.5 Flash
- **Push notifications**: Browser push on session completion/error
- **Parallel background agents**: Stream multiple agents simultaneously
- **Task forking/resuming/archiving**: Full task lifecycle management
- **Auto-scan ~/.claude/ history**: Imports existing Claude Code sessions
- **Stateless server design**: Kill/restart server without data loss

**Architecture notes:**
- React + Tailwind + Node.js
- Claude Code SDK via stdio proxy (cui-server spawns processes)
- npm / self-hosted distribution

### Other Notable Projects

| Project | Stars | Description | Unique Feature |
|---------|-------|-------------|----------------|
| **OpenWork** | 9,871 | Free Cowork alternative, wraps OpenCode engine (Tauri) | WhatsApp/Slack/Telegram connector; positions against $200/mo Cowork |
| **CCManager** | 859 | CLI session manager for **8+ coding agents** | Broadest agent support (CC, Gemini, Codex, Cursor, Copilot, Cline, OpenCode, Kimi); devcontainer sandboxing; auto-approval |
| **Agentrooms** | 775 | Multi-agent orchestration via @mentions (Electron) | Remote agent coordination across machines (Mac Mini, cloud); @mention-based routing |
| **claude-code-webui** | 914 | Lightweight web interface (React + Node/Deno) | Supports both Deno and Node.js runtimes; almost entirely AI-written |
| **claude-code-viewer** | 889 | Full-featured web client with zero info loss (Zod schemas) | Cron scheduling; web app preview panel; i18n (EN/JP/ZH) |
| **claude-run** | 511 | Read-only session history viewer (by roadmap.sh author) | SSE streaming for live sessions; useful as debugging tool |
| **Codexia** | 437 | Tauri GUI for Codex + Claude Code | PDF/CSV/XLSX preview; prompt notepad for reusable prompts |
| **Agent Sessions** | 253 | Native macOS app for browsing 7+ agent sessions (Swift) | Rate limit tracking; analytics dashboard; broadest read-only support |
| **Open Claude Cowork** | 3,065 | Composio-backed open Cowork alternative | 500+ SaaS app integrations via Composio platform |

### AG-UI Protocol

Open standard protocol by CopilotKit bridging any AI agent backend to any UI frontend via Server-Sent Events. Not a product but a protocol — could become the HTTP of agent-UI communication. Relevant to BeamCode's adapter architecture.

### Project Comparison

| Dimension | BeamCode | Companion | Happy | Halo | Opcode | CC-Switch |
|-----------|----------|-----------|-------|------|--------|-----------|
| Identity | Universal adapter library | Web application | Full-stack product | Desktop app (Electron) | Desktop app (Tauri) | Desktop app (Tauri) |
| Scale | ~40K LOC | ~45K LOC | ~129K LOC | ~78K LOC | Unknown | Unknown |
| Agents supported | 25+ (4 adapters) | 2 | 3 | 1 (SDK) + multi-provider | 1 (Claude Code) | 4 (CC+Codex+OC+Gemini) |
| Runtime | Node.js ≥ 22 | Bun | Node.js ≥ 20 | Electron 28 | Tauri 2 (Rust) | Tauri 2 |
| Database | JSON files | JSON files | PostgreSQL + Redis | JSON files | SQLite | Unknown |
| Encryption | libsodium (relay) | None | libsodium + tweetnacl | None | OS-level sandbox | None |
| Agent protocol | BackendAdapter interface | Inline ws-bridge | Inline per-agent | SDK direct | SDK / CLI subprocess | CLI subprocess |
| Monitoring | None | PostHog | Prometheus | GA4 (optional) | Usage analytics | None |
| Distribution | npm / web | npm | npm | Native (DMG/EXE/AppImage) | Native (DMG/MSI/AppImage) | Native (DMG/MSI/AppImage) |
| Remote access | Cloudflare Tunnel + token | None observed | QR device linking | Cloudflare Quick Tunnel + PIN | None observed | None observed |
| Stars | — | ~2K | ~1K | ~1K | ~20.5K | ~18.5K |
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
| Multi-backend toggle | Companion | 4 adapters ready | P3-1 | Badge shipped (PR #25), **selector UI still needed** |
| Session archiving with count | Companion | archive/unarchive commands | P1-4 | **✅ Shipped** (PR #25) |
| E2E encryption indicator | Happy | Full crypto stack | P0-4 | **Not started** |
| Branch/folder picker toolbar | Companion | `repo_root`, `git_branch` in state | P1-7 | **✅ Shipped** (PR #25) — StatusBar |
| Environment management | Companion | Not yet in backend | — | Future consideration |
| Notification controls | Companion | Not yet in backend | P2-7 | **UI shipped** (PR #25), behavior not wired |
| Image upload in composer | Companion | Depends on backend adapter | — | **✅ Shipped** (PR #14) — CW-5 |
| Voice input | Happy | Not in scope | — | Differentiator for Happy, not us |
| Mobile native apps | Happy | Not in scope | — | Differentiator for Happy, not us |
| Git status bar (ahead/behind) | Happy | `git_ahead`/`git_behind` in state | P2-8 | **✅ Shipped** (PR #25) |
| Session naming | Companion, Happy | Auto-generated IDs currently | P1-8 | **Plumbing done** (PR #25), trigger missing |
| Project grouping with count | Companion | `cwd` available per session | P2-9 | **✅ Shipped** (PR #25) |
| Content Canvas (artifact preview) | Halo | Tool results in messages | CW-7 | **Partially shipped** — PreBlock/MarkdownBlock, no rich viewers |
| AI Browser (embedded Chromium) | Halo | Not in backend | — | New consideration — see MA-5 |
| Workspace/Space system | Halo | `cwd` per session | — | Sessions approximate this, no explicit "space" abstraction |
| File explorer tree | Halo | Not in frontend | — | New consideration — see P3-8 |
| i18n (7 languages) | Halo | Not implemented | — | Future consideration for international adoption |
| One-click native install | Halo | npm-based install | — | Different distribution model (web-first vs. desktop-first) |
| Multi-provider (OpenAI compat router) | Halo | 4 adapters (different approach) | P3-1 | BeamCode adapts to CLIs; Halo adapts API protocols |
| Tool permission previews | Halo | Full permission system | — | **✅ Shipped** — DiffView, PreBlock in PermissionBanner |
| Conversation search | Halo | Session search in sidebar | — | **✅ Shipped** (PR #14) — CW-2 |
| Process health/recovery | Halo | Circuit breaker + reconnect | P0-1/P0-3 | Backend ready, **UI not started** |
| OS-level sandboxing | Opcode | Not in backend | — | Different security model — BeamCode trusts CLI permissions |
| Checkpoint/save state | Opcode | Not in backend | — | Future consideration |
| Custom agent creation | Opcode | Adapter system (different) | — | BeamCode adapts to existing CLIs rather than creating agents |
| Skills store/marketplace | CC-Switch | Not in backend | — | Future consideration |
| Git worktree per session | Crystal | `is_worktree` in state | — | Related to MA-1; Crystal validates parallel-session-per-worktree model |
| Cron scheduling | CUI, claude-code-viewer | Not in backend | — | New consideration — see Borrowable Ideas |
| Dictation (voice-to-text) | CUI | Not in scope | — | Cut |
| Multi-machine agent orchestration | Agentrooms | Remote relay exists | — | BeamCode's relay/tunnel enables this; no UI for it yet |
| Session history import | CUI | Not in backend | — | Useful for onboarding — import ~/.claude/ history |
| 8-agent CLI support | CCManager | 4 adapters | — | BeamCode's adapter model is more extensible but has fewer adapters |
| Devcontainer sandboxing | CCManager | Not in backend | — | Future consideration for enterprise |
| Rate limit visibility | Agent Sessions | Token bucket in backend | P2-3 | Backend ready, **UI not started** |

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

#### P1-8: Descriptive Session Names — **PARTIALLY WIRED (PR #25)**

**Competitive evidence**: Both competitors auto-generate meaningful session names — Companion uses creative names ("Deft Quartz"), Happy uses task-derived names ("OpenTunnel Dependency Upgrade").

**Wired in PR #25**:
- ✅ `session_name_update` WS message type defined in protocol (`consumer-messages.ts:158`)
- ✅ Frontend handler in `ws.ts:195-196` stores name via `store.updateSession(sessionId, { name: msg.name })`
- ✅ Sidebar displays `info.name` with fallback to `cwdBasename(info.cwd)` (`Sidebar.tsx:74`)
- ✅ Backend `broadcastNameUpdate()` API in `SessionBridge` with tests

**Not wired**:
- ❌ No auto-naming trigger — `broadcastNameUpdate()` is defined but never called from any production code path
- ❌ No name derivation logic (from first message, LLM summary, or creative generator)
- ❌ No click-to-rename UI in sidebar

**Effort**: S (just need to call `broadcastNameUpdate` when first user message arrives + add rename UI)
**Impact**: Medium — significantly improves session identification in sidebar

#### P2-7: Notification Preferences — **UI SHIPPED, BEHAVIOR NOT WIRED (PR #25)**

**Competitive evidence**: Companion has Sound on/off and Alerts on/off toggles in sidebar.

**Shipped in PR #25** (sidebar footer):
- ✅ Sound toggle (speaker icon with on/off state) — persists to localStorage via `beamcode_sound`
- ✅ Alerts toggle (bell icon with on/off state) — persists to localStorage via `beamcode_alerts`
- ✅ Dark mode toggle (sun/moon icon) — persists to localStorage, fully functional
- ✅ Settings button (scaffolded, no onClick handler)

**Not wired**:
- ❌ `soundEnabled` state is stored but never consumed — no audio playback on completion/error
- ❌ `alertsEnabled` state is stored but never consumed — no `Notification.requestPermission()` or desktop notification dispatch
- ❌ No per-session notification override

**Effort**: S (wire `soundEnabled` to audio playback on `result` messages, wire `alertsEnabled` to Notification API)
**Impact**: Medium — quality-of-life for multi-session workflows

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

**Remaining gaps**:
- ❌ No line numbers on monospace blocks
- ❌ No syntax highlighting for language-specific output
- ❌ No grep match highlighting (matches not color-coded)
- ❌ No ANSI color support for Bash output

**Effort**: S-M | **Impact**: Medium — core rendering works, enhancements are polish

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
| 10 | Cron scheduling for agent tasks | CUI, claude-code-viewer | Schedule recurring or delayed agent tasks — useful for CI-like workflows and overnight runs |
| 11 | Session history import (~/.claude/) | CUI | Auto-scan and import existing Claude Code session history — smooth onboarding for existing users |
| 12 | Git worktree-per-session orchestration | Crystal | Automatic worktree creation per parallel session with built-in rebase/squash — validates MA-1 approach |
| 13 | AG-UI protocol adoption | AG-UI (CopilotKit) | Open SSE-based protocol for agent-UI communication — potential standard to adopt or align with |

### Competitive Threat Assessment

| Competitor | Can Replicate Moat? | Threat | Rationale |
|------------|---------------------|--------|-----------|
| VS Code Copilot (Agent HQ) | Yes — already announced | **CRITICAL** | Resources + distribution + ecosystem lock-in |
| Cursor 2.0 | Yes — resources + Composer | **HIGH** | VC-funded, strong UX team |
| Windsurf | Yes — Cascade autonomous mode | **HIGH** | Autonomous agent + IDE integration |
| **Opcode** | Partially — single-agent, desktop-only | **HIGH** | 20.5K stars, YC-backed, strong community. But locked to Claude Code. |
| **CC-Switch** | Partially — 4 agents via CLI subprocess | **HIGH** | 18.5K stars, closest to multi-agent vision. But CLI subprocess, no adapter abstraction. |
| Continue | Yes — open-source, extensible | MEDIUM | IDE-first, not web-first |
| **Crystal** | No — Claude Code + Codex only | MEDIUM | Validates worktree-per-session model; could inspire similar features |
| **CloudCLI** | Partially — web + multi-CLI | MEDIUM | 6.3K stars, web-based like BeamCode, but simpler architecture |
| **CUI** | No — single-agent, web-based | MEDIUM | Web-based competitor with cron scheduling and dictation |
| **OpenWork** | No — wraps OpenCode, not multi-agent | LOW | Anti-Cowork positioning; different market |
| Hello Halo | No — single-agent, desktop-first | LOW | Electron-locked, no multi-agent |
| LibreChat | Maybe — multi-model, not multi-agent | LOW | Chat-focused, not coding-agent-focused |

**What BeamCode can do that they can't:**
1. **Protocol-agnostic adapter abstraction**: CC-Switch uses CLI subprocess; CCManager is CLI-only TUI. BeamCode's `BackendAdapter` interface with compliance tests is architecturally superior.
2. **Web-first remote access**: Opcode, CC-Switch, Crystal are all desktop-only. Only CloudCLI and CUI are web-based, but lack BeamCode's tunnel/encryption/RBAC stack.
3. **Cross-agent routing**: No competitor routes tasks to the best agent. Single-agent tools have no incentive.
4. **Agent benchmarking**: No cross-agent performance visibility anywhere in the market.
5. **E2E encryption + RBAC**: No competitor combines relay encryption with participant/observer roles.
6. **Multi-user/multi-consumer**: BeamCode's daemon serves multiple consumers per session. All competitors are single-user.

**What competitors do better than BeamCode today:**
1. **Opcode**: OS-level sandboxing (seccomp/Seatbelt), checkpoint system, custom agent creation, usage analytics dashboard
2. **CC-Switch**: 4-agent switching with skills marketplace
3. **Crystal**: Git worktree isolation per parallel session with built-in rebase/squash
4. **CUI**: Cron scheduling, dictation, push notifications, ~/.claude/ history import
5. **CloudCLI**: Mobile-first responsive design, integrated terminal + file explorer + git explorer
6. **Halo**: Content Canvas, AI Browser, i18n, one-click install, file explorer
7. **CCManager**: 8-agent support, devcontainer sandboxing, auto-approval

**Why BeamCode's position is defensible:**
- **Adapter abstraction** is fundamentally more extensible than CLI subprocess — adding a new agent is a single class implementation, not fork-and-hack
- **Web-first daemon** enables use cases desktop apps can't: headless server, iPad access, multi-user collaboration
- **Encryption + RBAC** enables enterprise/team use cases that no competitor addresses
- **The market is fragmenting by CLI** (Opcode=Claude, AiderDesk=Aider, Codexia=Codex). BeamCode is the only project designed to unify them all.

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
| Native desktop installers | BeamCode is web-first daemon architecture. Electron/Tauri packaging adds complexity without clear benefit for developer audience. Opcode/CC-Switch own this space. |
| i18n (multi-language) | Low priority for developer-focused tool. Code and agent output is English. May reconsider later. |
| OS-level sandboxing | Opcode's seccomp/Seatbelt approach is desktop-only. BeamCode trusts CLI permissions. Enterprise sandboxing better via devcontainers. |
| Skills store/marketplace | CC-Switch differentiator. BeamCode's adapter model is the abstraction layer — skills are agent-specific (CLAUDE.md, .cursorrules, etc.). |
| Dictation/voice-to-text | CUI feature via Gemini Flash. Not developer workflow. |
| Custom agent creation UI | Opcode feature. BeamCode adapts to existing CLIs — users create agents in their respective tools, not in our UI. |

---

## Priority 0 — Critical Gaps (Users Are Flying Blind)

### P0-1: Circuit Breaker State Visibility

**Problem**: When CLI crashes repeatedly, the circuit breaker blocks restarts for 30s. User sees "CLI disconnected," clicks Retry, gets silently blocked — no feedback.

**Backend has** (`src/adapters/sliding-window-breaker.ts`):
- States: CLOSED (normal) → OPEN (blocked, 30s cooldown) → HALF_OPEN (testing recovery)
- Failure count in sliding window (5 failures / 60s triggers OPEN)
- Recovery timer, success threshold (2 successes to close)

**Frontend shows**: A yellow "CLI disconnected" banner with retry button.

**Proposed UI**: Replace generic banner with state-aware messaging:
- OPEN: "CLI restart protection active — too many failures. Cooling down for 20s..."
- HALF_OPEN: "Testing connection stability (1/2 successes needed)"
- Include failure count and countdown timer

**Effort**: S (small banner logic change)
**Impact**: High — eliminates the most confusing UX in the product

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

### P0-3: Reconnection Watchdog Visibility

**Problem**: After daemon restart, a 30s watchdog timer runs to reconnect CLI processes. User sees "disconnected" with no context.

**Backend has** (`src/core/session-manager.ts:289-306`):
- 30s grace period (configurable `reconnectGracePeriodMs`)
- Auto-kills stale processes after timeout
- Triggers relaunch

**Frontend shows**: "CLI disconnected — waiting for reconnection" (no timer, no context)

**Proposed UI**: Countdown banner:
- "Waiting for CLI to reconnect (25s remaining)..."
- After timeout: "CLI did not reconnect — relaunching..."

**Effort**: S (timer display, needs small backend event)
**Impact**: High — explains automatic recovery

---

### P0-4: Encryption Status Indicator

**Problem**: BeamCode has full E2E encryption (X25519 + XSalsa20-Poly1305) but users have zero indication whether their session is encrypted or plaintext.

**Backend has** (`src/utils/crypto/`):
- `EncryptionLayer.isActive()`, `isPaired()`
- Device fingerprints via `fingerprintPublicKey()`
- Authenticated encryption for all post-pairing messages

**Frontend shows**: Nothing about encryption.

**Competitive evidence**: Happy headlines E2E encryption as a top-3 marketing feature. Companion doesn't surface it.

**Proposed UI**:
- 🔒 icon in TopBar when encrypted (hover: "E2E encrypted — fingerprint: 4a7c...")
- ⚠️ "Unencrypted" warning when tunnel active but no pairing

**Effort**: S (badge + tooltip)
**Impact**: Critical for security trust — competitors are marketing this, we should at minimum show it

---

### P0-5: Observer Role UI Enforcement — **MOSTLY SHIPPED (PR #23/#25)**

**Problem**: Backend enforces observer role (blocks user_message, permission_response, interrupt, set_model, set_permission_mode, slash_command) but UI still shows all controls.

**Backend has** (`src/core/session-bridge.ts:115-123`):
- `PARTICIPANT_ONLY_TYPES` set for message filtering
- Returns error: "Observers cannot send user_message messages"

**Shipped in PR #23/#25**:
- ✅ Composer disabled for observers (`Composer.tsx:262`), placeholder shows "Observer mode — read-only"
- ✅ Send button disabled for observers
- ✅ Model picker disabled for observers (`TopBar.tsx:141`)
- ✅ Permission mode picker disabled for observers (`StatusBar.tsx:44,97`)
- ✅ Observer badge shown in TopBar (`TopBar.tsx:110-114`)
- ✅ Identity/role received via `identity` WS message and stored

**Remaining gaps**:
- ❌ No explicit observer banner explaining the read-only state
- ❌ Permission buttons in `PermissionBanner` still visible (backend rejects, but UI shows them)

**Effort**: XS (add banner + hide permission buttons)
**Impact**: Completes the observer UX

---

## Priority 1 — High-Impact Gaps

### P1-1: Process Output Streams (Logs)

**Backend has** (`src/types/events.ts:108-109`):
- `process:stdout` and `process:stderr` events with full CLI output
- Error messages, model loading status, API failures

**Frontend shows**: Nothing. When CLI fails to spawn, user only sees "disconnected."

**Proposed UI**: Collapsible "Process Logs" drawer accessible from error states:
- "CLI exited (code 1) [View Logs →]"
- Last 100 lines of stdout/stderr
- Filter by stream, search by keyword

**Effort**: M
**Impact**: Transforms debugging from impossible to self-service

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

**Remaining gap**:
- ❌ No auto-respond behavior in "YOLO" mode — `PermissionBanner` still appears. The frontend sends the mode change but doesn't suppress incoming permission requests client-side. Backend may need to handle auto-approval, or frontend could auto-respond with `behavior: "allow"` when mode is `bypassPermissions`.

---

### P1-6: Resume Failure Notification

**Backend has** (`src/adapters/sdk-url/sdk-url-launcher.ts:102-127`):
- Detects when `--resume` fails (CLI exits within 5s)
- Clears `cliSessionId`, falls back to fresh start
- Emits `process:resume_failed` event

**Frontend shows**: Nothing. Conversation context silently disappears.

**Proposed UI**: Toast notification:
- "Could not resume previous session — starting fresh conversation"
- Explanation that conversation history may be lost

**Effort**: S
**Impact**: Prevents user confusion when context is lost

---

## Priority 2 — Operational Visibility

### P2-1: Connection Health Dashboard

**Backend has** (`src/interfaces/metrics.ts`):
- 13 metric event types: session lifecycle, connections, messages, errors, rate limits, latency, queue depth
- `ConsoleMetricsCollector` records everything

**Frontend shows**: Connection dot (green/yellow/red), per-turn cost/duration in ResultBanner.

**Proposed UI**: Expandable connection health section in TaskPanel:
- Last error reason (from `backend:disconnected` code + reason)
- Failure count in window: "3/5 failures in last 60s"
- Next retry countdown
- Circuit breaker state indicator

**Effort**: M (needs new WS message type for metrics)
**Impact**: Self-service debugging for connection issues

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

### P3-1: Backend Adapter Selector (**Elevated from P3 — see Competitive Analysis**)

**Competitive evidence**: Companion ships an inline "Claude Code | Codex" backend toggle. BeamCode has 4 adapters ready but zero UI to choose between them.

**Backend has** (`src/adapters/`): 4 adapters — sdk-url, acp, codex, agent-sdk — each with different capabilities (teams, slash commands, streaming). All conform to `BackendAdapter` interface with compliance tests.

**Proposed UI**: Segmented control or dropdown in toolbar (like Companion's bottom bar):
- Show available adapters with capability badges
- Persist selection per session
- Tooltip showing adapter capabilities (streaming, teams, slash commands)

**Effort**: S-M (frontend selector + adapter factory wiring) | **Impact**: **High** — unique multi-backend story, already built on backend

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
| ~~P0-5: Observer role enforcement~~ | #23/#25 | Composer/buttons disabled, observer badge, identity WS handler (banner still missing) |
| ~~P1-4: Archive management~~ | #25 | REST endpoints + sidebar UI with active/archived sections |
| ~~P1-5: Permission mode picker~~ | #25 | 3-mode dropdown in StatusBar with `set_permission_mode` backend integration |
| ~~P1-7: Context toolbar~~ | #25 | Full StatusBar: adapter, cwd, branch, ahead/behind, worktree, model |
| ~~P1-8: Session naming (partial)~~ | #25 | Protocol + handler + display wired, but no auto-naming trigger |
| ~~P2-2: Latency breakdown~~ | #23 | ResultBanner shows "Total (API Xs)" with clamping |
| ~~P2-5: MCP server status~~ | #23 | `McpServersSection` in TaskPanel with status badges |
| ~~P2-6: Active users & presence~~ | #23 | `PresenceSection` in TaskPanel with role badges |
| ~~P2-7: Notification prefs (UI only)~~ | #25 | Sound/alerts/dark-mode toggles in sidebar footer (behavior not wired) |
| ~~P2-8: Git ahead/behind~~ | #25 | ↑N/↓N indicators in StatusBar |
| ~~P2-9: Session grouping~~ | #25 | Groups by project with running count |
| ~~CW-7: Tool result rendering (improved)~~ | #25 | PreBlock/MarkdownBlock/JsonBlock renderers per tool type |

### Phase 1: Critical Visibility (remaining — ~1 week)

Items remaining from original Phase 1, all S effort.

| Item | Effort | Backend Changes Needed | Status |
|------|--------|----------------------|--------|
| P0-1: Circuit breaker banner | S | New WS event for breaker state | Not started |
| P0-2: Session state badge | S | None (data in session_update) | Not started |
| P0-3: Reconnect watchdog timer | S | New WS event for watchdog | Not started |
| P0-4: Encryption status icon | S | Expose isPaired/isActive via WS | Not started |
| P0-5: Observer banner (finish) | XS | None | Missing banner text only |
| P1-6: Resume failure toast | S | Forward process:resume_failed | Not started |
| P1-8: Session naming (finish) | S | Call broadcastNameUpdate on first message | Plumbing done, trigger missing |
| P2-7: Notification behavior (finish) | S | None | UI done, wire sound/alerts |

**8 items remaining** (down from 13), most are truly S effort.

### Phase 2: Coding Workflow + Sharing (3-4 weeks)

| Item | Effort | Backend Changes Needed | Status |
|------|--------|----------------------|--------|
| CW-7: Tool result polish (syntax/ANSI) | S-M | None | Core rendering shipped, polish remaining |
| CW-8: Plan/Act mode toggle | M | New inbound message type | Not started |
| P1-1: Process logs drawer | M | Forward stdout/stderr via new WS msg | Not started |
| P1-2: Tunnel URL sharing | M | Expose tunnelUrl via WS or API | Not started |
| P1-3: Device pairing flow | M | Expose pairing API to frontend | Not started |
| P2-1: Connection health panel | M | New metrics snapshot WS message | Not started |
| P2-4: Health dashboard | M | Expose GET /health to frontend | Not started |
| P3-1: Adapter selector | S-M | Adapter factory wiring | Not started |

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

1. **Frontend rendering** (majority) — data is already in the store or available via existing messages, just not displayed
2. **New WS message types** (some) — circuit breaker state, process logs, metrics snapshots need new message types
3. **New HTTP endpoints** (few) — ~~archive~~, health, config need REST API exposure
4. ~~**One critical refactor**~~ — ws.ts singleton → Map **completed in PR #22**
5. **Behavior wiring** (new category) — notification sound/alerts toggles exist in UI but don't trigger actual notifications; permission mode picker sends mode but doesn't auto-approve

**Key principle**: Phases 1-2 are almost entirely frontend work. The backend is ready.

**Progress update**: Of the original 13 Phase 1 items, **8 are fully shipped** and 5 are partially done or have remaining polish. Phase 2 lost 4 items (P1-7, P2-6, P2-9, CW-7 core) that shipped early. The ws.ts refactor (Phase 3 blocker) is complete.

**Competitive insight**: Phase 2 includes the adapter selector (P3-1, elevated) — BeamCode's strongest differentiator vs. both Companion and Happy, since the backend supports 4 adapters with compliance-tested interfaces.

**Strategic insight**: BeamCode cannot out-Cursor Cursor. The revised plan front-loads quick wins that fix daily pain points, then pivots to multi-agent features that no competitor can replicate.

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

| Feature | Companion | Happy | Halo | Opcode | CC-Switch | Crystal | CUI | BeamCode | Status |
|---------|-----------|-------|------|--------|-----------|---------|-----|----------|--------|
| Multi-backend selector | CC+Codex | No | Multi-provider | No | **4 CLIs** | CC+Codex | No | 4 adapters, **no selector UI** | P3-1 |
| Code diff view | DiffPanel | Yes | react-diff-viewer | Unknown | Unknown | **Yes** | Unknown | **✅ Shipped** | CW-4 |
| Keyboard shortcuts | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | **✅ Shipped** | CW-1 |
| Permission mode picker | Unknown | Unknown | Approve/reject | Scoped agents | Unknown | Unknown | Unknown | **✅ Shipped** | P1-5 |
| Image upload | Composer btn | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | **✅ Drag-drop** | CW-5 |
| Session archiving | ARCHIVED (N) | No | No | **Yes** | Unknown | **Yes** | **Yes** (fork/archive) | **✅ Shipped** | P1-4 |
| Session naming | Creative | Task-derived | No | Unknown | Unknown | **AI-generated** | Unknown | **⚠️ Partial** | P1-8 |
| Session search | Unknown | Unknown | Full-text | Unknown | Unknown | Unknown | Unknown | **✅ Shipped** | CW-2 |
| Session grouping | By project | Flat | By space | Unknown | Unknown | Unknown | Unknown | **✅ Shipped** | P2-9 |
| Context toolbar | Bottom bar | Status bar | No | Unknown | Unknown | Unknown | Unknown | **✅ StatusBar** | P1-7 |
| Git ahead/behind | Branch picker | +N -N | No | Unknown | Unknown | Unknown | Unknown | **✅ Shipped** | P2-8 |
| Notifications | Sound/Alerts | Native push | No | Unknown | Unknown | **Desktop** | **Push** | **⚠️ UI only** | P2-7 |
| Terminal emulator | xterm.js | No | No | Unknown | Unknown | Unknown | Unknown | No | MA-2 |
| E2E encryption indicator | No | Headline | No | No | No | No | No | **Backend only** | P0-4 |
| Observer enforcement | Unknown | Unknown | No | No | No | No | No | **✅ Shipped** | P0-5 |
| MCP server management | Unknown | Unknown | Config | **Full UI** | **stdio+HTTP** | Unknown | Unknown | **✅ Status** | P2-5 |
| Plan/Act mode | Unknown | Unknown | No | Unknown | Unknown | Unknown | Unknown | No | CW-8 |
| Export | Unknown | Unknown | No | Unknown | Unknown | Unknown | Unknown | **✅ Shipped** | CW-6 |
| Tool result rendering | Unknown | Unknown | Approval UI | Unknown | Unknown | Unknown | Unknown | **✅ Per-tool** | CW-7 |
| Usage analytics | Unknown | Unknown | Token tracking | **Dashboard** | Speed test | Unknown | Unknown | **✅ Latency** | P2-2 |
| Presence/multi-user | Unknown | Unknown | No | No | No | No | No | **✅ Shipped** | P2-6 |
| Content Canvas | No | No | **6 viewers** | Unknown | Unknown | Unknown | Unknown | No | Cut |
| AI Browser | No | No | **26 tools** | No | No | No | No | No | Cut |
| File explorer | Folder picker | No | **Tree view** | Unknown | Unknown | Unknown | Unknown | No | P3-8 |
| i18n | No | No | **7 langs** | Unknown | Unknown | Unknown | Unknown | No | Cut |
| Dark/light theme | Unknown | Unknown | System-aware | Unknown | Unknown | Unknown | Unknown | **✅ Shipped** | PR #25 |
| Remote access UI | No | QR | PIN+tunnel | No | No | No | Unknown | **Backend only** | P1-2 |
| Cron scheduling | **Yes** | No | No | No | No | No | **Yes** | No | Borrowable |
| Parallel sessions | Unknown | Unknown | Unknown | Background | Unknown | **Worktrees** | **Background** | Backend ready | MA-1 |
| Checkpoint/save state | No | No | No | **Yes** | No | No | No | No | Cut |
| Custom agent creation | No | No | No | **Yes** | Presets | No | No | No | Cut |
| Skills marketplace | No | No | No | No | **Yes** | No | No | No | Cut |
| OS-level sandboxing | No | No | No | **seccomp/Seatbelt** | No | No | No | No | Cut |
| Git worktree per session | No | No | No | No | No | **Yes** | No | No | MA-1 related |

### Backend/Infrastructure Features

| Feature | Companion | Happy | Halo | Opcode | CC-Switch | Crystal | CUI | BeamCode | Status |
|---------|-----------|-------|------|--------|-----------|---------|-----|----------|--------|
| Multi-agent adapters | No | No | No | No | 4 CLIs (subprocess) | 2 CLIs | No | **Yes** (4 typed adapters) | ✅ Ready |
| Per-session connections | Unknown | Unknown | V2 Session | Unknown | Unknown | Per-worktree | Per-process | **Yes** (Map) | ✅ PR #22 |
| E2E encryption | No | **Zero-knowledge** | No | No | No | No | No | **Yes** (relay) | Phase 4 |
| RBAC | No | No | No | Scoped agents | No | No | No | **Yes** + UI | ✅ PR #23/#25 |
| Rate limiting | No | No | No | No | No | No | No | **Yes** | ✅ Ready |
| Circuit breaker | No | No | Health system | No | No | No | No | **Yes** | UI pending |
| Message replay | No | No | No | No | No | No | No | **Yes** | ✅ Ready |
| Protocol recording | **JSONL** | **JSONL** | No | No | No | No | No | No | Phase 4 |
| Protocol drift tests | **Yes** | No | No | No | No | No | No | No | Phase 4 |
| Prometheus metrics | No | **Yes** | No | No | No | No | No | No | Phase 4 |
| MCP support | No | **Yes** | **Yes** | **Yes** | **stdio+HTTP** | No | No | No | Phase 4 |
| Idempotent messages | No | **Yes** | No | No | No | No | No | No | Phase 4 |
| Cron scheduling | **Yes** | No | No | No | No | No | **Yes** | No | Borrowable |
| Session process reuse | Unknown | Unknown | **V2 Sessions** | Unknown | Unknown | Unknown | Unknown | No | Borrowable |
| Lazy thought storage | No | No | **97% reduction** | No | No | No | No | No | Borrowable |
| History import | No | No | No | No | No | No | **~/.claude/** | No | Borrowable |
| Git worktree orchestration | No | No | No | No | No | **Yes** | No | No | MA-1 |
| Devcontainer sandbox | No | No | No | No | No | No | No | No | CCManager does |
| Desktop native | No | Tauri | **Electron** | **Tauri 2** | **Tauri 2** | **Electron** | No | No | Cut |
| Multi-user/consumer | No | No | No | No | No | No | No | **Yes** | ✅ Unique |
| Team/multi-agent obs. | No | No | No | No | No | No | No | **Yes** | MA-1 |
| AG-UI protocol compat | No | No | No | No | No | No | No | No | Evaluate |
