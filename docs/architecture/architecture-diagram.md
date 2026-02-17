# Architecture Diagram: Relay-First MVP

**Based on**: `docs/architecture/decisions.md` v2.1 (Relay-First MVP, post-review revision)
**Date**: 2026-02-17
**Status**: Phase 0–1 complete, Phase 2 in progress

---

## Strategic Overview

```
  v1 (Library-First)              v2.1 (Relay-First)            Parallel Tracks (2 eng)
  ─────────────────               ──────────────────            ───────────────────────

  Design abstractions             Build relay MVP               ┌─ Track 1: Adapters ───┐
        │                               │                       │  SdkUrl + ACP extract │
        ▼                               ▼                       │  (shapes interfaces)  │
  Build adapters (2-3)            Extract abstractions          └──────────┬────────────┘
        │                         from working code                       │ converge
        ▼                               │                       ┌─────────▼─────────────┐
  Hope relay fits                       ▼                       │  Track 2: Relay       │
  (10% ever ships)                Widen to other adapters       │  Daemon + Tunnel + E2E│
                                  (validated by ACP + Codex)    └───────────────────────┘

  12-14 weeks                     17-22 weeks (1 eng)           13-15 weeks (2 eng)
  Wrong thing, on time            Right thing, slower            Right thing, on time
```

---

## Current Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                        RELAY-FIRST MVP ARCHITECTURE (v2.1)                          │
│                                                                                     │
│  ╔══════════════════════╗  ╔═══════════╗                                            │
│  ║ React Consumer       ║  ║  Desktop  ║  Consumers                                 │
│  ║ (web/)               ║  ║  Browser  ║  (any WebSocket client)                    │
│  ║ React 19 + Zustand   ║  ╚═════╤═════╝                                            │
│  ║ + Tailwind v4 + Vite ║        │                                                  │
│  ║ ChatView, Sidebar,   ║        │  ws://localhost                                  │
│  ║ StatusBar, AgentPane ║        │  (direct, no tunnel)                             │
│  ╚═══════╤══════════════╝        │                                                  │
│          │                       │                                                  │
│          │  HTTPS                │                                                  │
│          │                       │                                                  │
│  ┌───────▼─────────┐             │                                                  │
│  │  Cloudflare     │             │                                                  │
│  │  Tunnel Edge    │             │  LOCAL PATH                                      │
│  │  (SLA 99.99%)   │             │                                                  │
│  └───────┬─────────┘             │                                                  │
│          │                       │                                                  │
│  ┌───────▼─────────┐             │                                                  │
│  │  cloudflared    │             │  ◄── sidecar process (Go binary)                 │
│  │  reverse proxy  │             │      proxies HTTPS → localhost:PORT              │
│  └───────┬─────────┘             │                                                  │
│          │ localhost:PORT        │                                                  │
│          │                       │                                                  │
│  ┌───────▼───────────────────────▼───────────────────────────────────────┐          │
│  │                     HTTP + WS SERVER (localhost:3456)                  │          │
│  │                                                                       │          │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │          │
│  │  │  http/ — HTTP Request Router                                    │  │          │
│  │  │  ┌──────────────┐ ┌──────────────┐ ┌─────────────────────────┐ │  │          │
│  │  │  │ api-sessions │ │ consumer-    │ │ health                  │ │  │          │
│  │  │  │ REST CRUD    │ │ html (serves │ │ GET /health             │ │  │          │
│  │  │  │ /api/sessions│ │ React app)   │ │                         │ │  │          │
│  │  │  └──────────────┘ └──────────────┘ └─────────────────────────┘ │  │          │
│  │  └─────────────────────────────────────────────────────────────────┘  │          │
│  │                                                                       │          │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │          │
│  │  │  server/ — WebSocket Layer                                      │  │          │
│  │  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────────────┐  │  │          │
│  │  │  │ Origin       │ │ Auth Token   │ │ Reconnection Handler   │  │  │          │
│  │  │  │ Validation   │ │ Gate         │ │  Stable consumer IDs   │  │  │          │
│  │  │  └──────────────┘ └──────────────┘ │  Message replay        │  │  │          │
│  │  │                                    └────────────────────────┘  │  │          │
│  │  │  ┌──────────────┐ ┌──────────────┐                             │  │          │
│  │  │  │ Consumer     │ │ Consumer     │                             │  │          │
│  │  │  │ Channel      │ │ Rate Limit   │                             │  │          │
│  │  │  │ (per-client  │ │ 10 msg/s     │                             │  │          │
│  │  │  │  send queue) │ │ 100 KB/s     │                             │  │          │
│  │  │  └──────────────┘ └──────────────┘                             │  │          │
│  │  └─────────────────────────────────────────────────────────────────┘  │          │
│  └───────────────────────────────┬───────────────────────────────────────┘          │
│                                  │                                                  │
│          ConsumerMessage (30+ subtypes, typed union)                                │
│          InboundMessage  (user_message, permission_response, interrupt, ...)        │
│                                  │                                                  │
│                                  ▼                                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐           │
│  │              core/ — SessionBridge + Extracted Modules               │           │
│  │                                                                      │           │
│  │  ┌──────────────────────────────────────────────────────────────┐    │           │
│  │  │  SessionBridge (orchestrator, TypedEventEmitter)             │    │           │
│  │  │  Delegates to:                                               │    │           │
│  │  │  ┌─────────────────┐ ┌─────────────────┐ ┌───────────────┐  │    │           │
│  │  │  │ SessionStore    │ │ Consumer        │ │ Consumer      │  │    │           │
│  │  │  │ • session CRUD  │ │ Broadcaster     │ │ Gatekeeper    │  │    │           │
│  │  │  │ • persistence   │ │ • WS fan-out    │ │ • auth/RBAC   │  │    │           │
│  │  │  │ • restore from  │ │ • backpressure  │ │ • rate limit  │  │    │           │
│  │  │  │   storage       │ │ • role filter   │ │ • observer    │  │    │           │
│  │  │  └─────────────────┘ └─────────────────┘ │   mode        │  │    │           │
│  │  │  ┌─────────────────┐ ┌─────────────────┐ └───────────────┘  │    │           │
│  │  │  │ SlashCommand    │ │ TeamEvent       │                     │    │           │
│  │  │  │ Registry +      │ │ Differ          │                     │    │           │
│  │  │  │ Executor        │ │ • pure state    │                     │    │           │
│  │  │  │ • per-session   │ │   diff logic    │                     │    │           │
│  │  │  │   commands      │ │ • team state    │                     │    │           │
│  │  │  └─────────────────┘ │   management    │                     │    │           │
│  │  │                      └─────────────────┘                     │    │           │
│  │  └──────────────────────────────────────────────────────────────┘    │           │
│  │                                                                      │           │
│  │  ┌──────────────────────────────────────────────────────────────┐    │           │
│  │  │  SessionManager (orchestrates SessionBridge + SdkUrlLauncher)│    │           │
│  │  └──────────────────────────────────────────────────────────────┘    │           │
│  │                                                                      │           │
│  │  ╔════════════════════════════════════════════════════════════╗      │           │
│  │  ║                    UnifiedMessage (Phase 0.1)              ║      │           │
│  │  ║  id, timestamp, type, role, content[], metadata            ║      │           │
│  │  ║  Supports: streaming (SdkUrl), request/response (ACP),    ║      │           │
│  │  ║  JSON-RPC (Codex), and query-based (AgentSdk)             ║      │           │
│  │  ║  + metadata escape hatch for adapter-specific data         ║      │           │
│  │  ║  + parentId for threading support                          ║      │           │
│  │  ╚════════════════════════════════════════════════════════════╝      │           │
│  │                                                                      │           │
│  │  ┌──────────────────────────────────────────────────────────────┐    │           │
│  │  │  State Hierarchy                                             │    │           │
│  │  │  CoreSessionState → DevToolSessionState → SessionState       │    │           │
│  │  │  (adapter-agnostic)  (git branch, repo)   (model, tools,     │    │           │
│  │  │                                            team, circuit      │    │           │
│  │  │                                            breaker, ...)      │    │           │
│  │  └──────────────────────────────────────────────────────────────┘    │           │
│  │                                                                      │           │
│  │  ┌──────────────────────────────────────────────────────────────┐    │           │
│  │  │  BackendAdapter interface (CORE)                             │    │           │
│  │  │  name: string                                                │    │           │
│  │  │  capabilities: BackendCapabilities                           │    │           │
│  │  │  connect(options): Promise<BackendSession>                   │    │           │
│  │  ├──────────────────────────────────────────────────────────────┤    │           │
│  │  │  BackendSession interface (CORE)                             │    │           │
│  │  │  sessionId: string                                           │    │           │
│  │  │  send(msg: UnifiedMessage): void                             │    │           │
│  │  │  messages: AsyncIterable<UnifiedMessage>                     │    │           │
│  │  │  close(): Promise<void>                                      │    │           │
│  │  ├──────────────────────────────────────────────────────────────┤    │           │
│  │  │  COMPOSED EXTENSIONS (additive, not baked in)                │    │           │
│  │  │  Interruptible:     interrupt(): void                        │    │           │
│  │  │  Configurable:      setModel(), setPermissionMode()          │    │           │
│  │  │  PermissionHandler: request/response bridging                │    │           │
│  │  │  Reconnectable:     onDisconnect(), replay()    ← relay      │    │           │
│  │  │  Encryptable:       encrypt(), decrypt()        ← relay      │    │           │
│  │  └─────────────────────┬────────────────────────────────────────┘    │           │
│  └────────────────────────┼─────────────────────────────────────────────┘           │
│                           │                                                         │
│        ┌──────────────────┼──────────────────┬──────────────────┐                   │
│        │                  │                  │                  │                   │
│        ▼                  ▼                  ▼                  ▼                   │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │ SdkUrl      │  │ ACP         │  │ Codex        │  │ AgentSdk     │               │
│  │ Adapter     │  │ Adapter     │  │ Adapter      │  │ Adapter      │               │
│  │ ✅ BUILT    │  │ ✅ BUILT    │  │ ✅ BUILT     │  │ ✅ BUILT     │               │
│  │ NDJSON/WS   │  │ JSON-RPC/   │  │ JSON-RPC/WS  │  │ JS query fn  │               │
│  │ --sdk-url   │  │ stdio       │  │ app-server   │  │ Anthropic    │               │
│  │ streaming,  │  │             │  │              │  │ Official SDK │               │
│  │ permissions,│  │             │  │ Thread/Turn/ │  │ teams        │               │
│  │ teams       │  │             │  │ Item model   │  │              │               │
│  └──────┬──────┘  └───────┬─────┘  └──────┬───────┘  └───────┬──────┘               │
│         │                 │                │                  │                      │
│         ▼                 ▼                ▼                  ▼                      │
│  ╔═══════════╗  ╔════════════════╗  ╔═══════════════╗  ╔═══════════════╗             │
│  ║ Claude    ║  ║ Goose / Kiro / ║  ║  Codex CLI    ║  ║   Anthropic   ║             │
│  ║ Code CLI  ║  ║ Gemini (ACP)   ║  ║  (OpenAI)     ║  ║   API         ║             │
│  ║ (child)   ║  ╚════════════════╝  ╚═══════════════╝  ╚═══════════════╝             │
│  ╚═══════════╝                                                                       │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐           │
│  │  CROSS-CUTTING INFRASTRUCTURE                                        │           │
│  │                                                                       │           │
│  │  ┌─────────────────┐ ┌─────────────────┐ ┌────────────────────────┐  │           │
│  │  │ errors.ts       │ │ state-migrator  │ │ structured-logger      │  │           │
│  │  │ BeamCodeError   │ │ Schema version  │ │ JSON-line logging      │  │           │
│  │  │ StorageError    │ │ + migration     │ │ component context      │  │           │
│  │  │ ProcessError    │ │ chain (v0→v1+)  │ │ level filtering        │  │           │
│  │  └─────────────────┘ └─────────────────┘ └────────────────────────┘  │           │
│  │                                                                       │           │
│  │  ┌─────────────────┐ ┌─────────────────┐ ┌────────────────────────┐  │           │
│  │  │ FileStorage     │ │ CircuitBreaker  │ │ ProcessManager         │  │           │
│  │  │ debounced write │ │ SlidingWindow   │ │ spawn, kill, isAlive   │  │           │
│  │  │ + schema vers.  │ │ + snapshot API  │ │ signal handling        │  │           │
│  │  └─────────────────┘ └─────────────────┘ └────────────────────────┘  │           │
│  └───────────────────────────────────────────────────────────────────────┘           │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐           │
│  │  DAEMON (Phase 2 — planned)                                           │           │
│  │  ┌───────────┐ ┌───────────┐ ┌──────────┐ ┌────────────────────┐     │           │
│  │  │ Lock File │ │ State     │ │ Health   │ │ Local Control API  │     │           │
│  │  │ O_CREAT|  │ │ File      │ │ Check    │ │ HTTP 127.0.0.1:0   │     │           │
│  │  │ O_EXCL    │ │ PID, port │ │ 60s loop │ │                    │     │           │
│  │  │           │ │ heartbeat │ │          │ │ • list sessions    │     │           │
│  │  │           │ │ version   │ │          │ │ • create session   │     │           │
│  │  │           │ │           │ │          │ │ • stop session     │     │           │
│  │  │           │ │           │ │          │ │ • revoke-device    │     │           │
│  │  └───────────┘ └───────────┘ └──────────┘ └────────────────────┘     │           │
│  └───────────────────────────────────────────────────────────────────────┘           │
│                                                                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐           │
│  │  E2E ENCRYPTION LAYER (Phase 2 — planned)                             │           │
│  │                                                                       │           │
│  │  ┌────────────────┐ ┌────────────────┐ ┌──────────────────────┐      │           │
│  │  │ libsodium      │ │ Pairing Link   │ │ HMAC-SHA256          │      │           │
│  │  │ Sealed Boxes   │ │ Key Exchange   │ │ Permission Signing   │      │           │
│  │  │ XSalsa20-      │ │ (URL with      │ │ + nonce              │      │           │
│  │  │ Poly1305       │ │  public key +  │ │ + timestamp (30s)    │      │           │
│  │  └────────────────┘ │  tunnel addr)  │ │ + request_id binding │      │           │
│  │                     └────────────────┘ └──────────────────────┘      │           │
│  │                                                                       │           │
│  │  ┌────────────────────┐  ┌──────────────────────────────────┐        │           │
│  │  │ Session Revocation │  │ EncryptedEnvelope (wire format)  │        │           │
│  │  │ • revoke-device    │  │ { v:1, sid, ct, len }            │        │           │
│  │  │ • new keypair      │  └──────────────────────────────────┘        │           │
│  │  │ • force re-pair    │                                               │           │
│  │  └────────────────────┘  TUNNEL-BLIND: relay cannot decrypt.         │           │
│  └───────────────────────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## React Consumer Architecture (web/)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     REACT CONSUMER (web/)                            │
│                     React 19 + Zustand + Tailwind v4 + Vite         │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  App.tsx (ErrorBoundary + Bootstrap)                           │ │
│  │                                                                │ │
│  │  ┌──────────────────────────────────────────────────────────┐  │ │
│  │  │  Layout                                                  │  │ │
│  │  │  ┌────────┐ ┌────────────────────────────┐ ┌──────────┐ │  │ │
│  │  │  │Sidebar │ │  Main Area                 │ │AgentPane │ │  │ │
│  │  │  │        │ │  ┌───────────────────────┐  │ │          │ │  │ │
│  │  │  │Sessions│ │  │ TopBar                │  │ │Agent grid│ │  │ │
│  │  │  │by date │ │  │ model, context gauge, │  │ │Team tasks│ │  │ │
│  │  │  │        │ │  │ connection status      │  │ │Members   │ │  │ │
│  │  │  │Archive │ │  └───────────────────────┘  │ │          │ │  │ │
│  │  │  │mgmt    │ │  ┌───────────────────────┐  │ └──────────┘ │  │ │
│  │  │  │        │ │  │ ChatView              │  │              │  │ │
│  │  │  │Settings│ │  │ AssistantMessage      │  │              │  │ │
│  │  │  │footer  │ │  │ ToolBlock             │  │              │  │ │
│  │  │  │        │ │  │ ToolResultBlock       │  │              │  │ │
│  │  │  │Sound / │ │  │ PermissionBanner      │  │              │  │ │
│  │  │  │Notifs  │ │  └───────────────────────┘  │              │  │ │
│  │  │  │Dark    │ │  ┌───────────────────────┐  │              │  │ │
│  │  │  │mode    │ │  │ Composer              │  │              │  │ │
│  │  │  └────────┘ │  │ /slash commands       │  │              │  │ │
│  │  │             │  └───────────────────────┘  │              │  │ │
│  │  │             │  ┌───────────────────────┐  │              │  │ │
│  │  │             │  │ StatusBar             │  │              │  │ │
│  │  │             │  │ adapter, git, model,  │  │              │  │ │
│  │  │             │  │ permissions, worktree │  │              │  │ │
│  │  │             │  └───────────────────────┘  │              │  │ │
│  │  └──────────────────────────────────────────────────────────┘  │ │
│  │                                                                │ │
│  │  ┌─────────── Overlays ───────────┐                            │ │
│  │  │ ToastContainer (FIFO, max 5)   │                            │ │
│  │  │ LogDrawer (process output)     │                            │ │
│  │  │ ConnectionBanner (circuit brk) │                            │ │
│  │  │ TaskPanel (team tasks)         │                            │ │
│  │  └────────────────────────────────┘                            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  store.ts — Zustand State                                     │ │
│  │  sessionData:  per-session messages, streaming state           │ │
│  │  sessions:     session list from API                           │ │
│  │  toasts:       notification queue                              │ │
│  │  processLogs:  per-session output ring buffer                  │ │
│  │  darkMode, sidebarOpen, taskPanelOpen, ...                    │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  ws.ts — WebSocket Connection                                 │ │
│  │  • Auto-reconnect with exponential backoff                    │ │
│  │  • Session handoff between tabs                               │ │
│  │  • Presence synchronization                                    │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  api.ts — HTTP Client                                         │ │
│  │  GET  /api/sessions         → list sessions                   │ │
│  │  GET  /api/sessions/:id     → session details                 │ │
│  │  POST /api/sessions/:id/msg → send message                    │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Core Module Decomposition (PR #28)

```
                        ┌──────────────────────────────┐
                        │      SessionManager          │
                        │  (orchestrates bridge +      │
                        │   SdkUrlLauncher)            │
                        └──────────────┬───────────────┘
                                       │
                        ┌──────────────▼───────────────┐
                        │      SessionBridge           │
                        │  (TypedEventEmitter)         │
                        │                              │
                        │  Unified message routing:    │
                        │  CLI → translateCLI()        │
                        │      → routeUnifiedMessage() │
                        │  Consumer → handleInbound()  │
                        └──┬────┬────┬────┬────┬───────┘
                           │    │    │    │    │
           ┌───────────────┘    │    │    │    └───────────────┐
           ▼                    ▼    │    ▼                    ▼
  ┌─────────────────┐ ┌──────────┐  │  ┌──────────────┐ ┌──────────────┐
  │  SessionStore   │ │ Consumer │  │  │ Consumer     │ │ SlashCommand │
  │                 │ │ Broad-   │  │  │ Gatekeeper   │ │ Registry +   │
  │  Map<Session>   │ │ caster   │  │  │              │ │ Executor     │
  │  CRUD ops       │ │          │  │  │ Pluggable    │ │              │
  │  Persistence    │ │ WS       │  │  │ Authenticator│ │ Per-session  │
  │  restore from   │ │ fan-out  │  │  │ RBAC (role-  │ │ command      │
  │  storage        │ │ Back-    │  │  │  based       │ │ dispatch     │
  │                 │ │ pressure │  │  │  visibility) │ │              │
  └─────────────────┘ │ Role     │  │  │ Observer     │ └──────────────┘
                      │ filter   │  │  │  mode        │
                      └──────────┘  │  └──────────────┘
                                    │
                        ┌───────────▼──────────┐
                        │  TeamEventDiffer     │
                        │                      │
                        │  Pure state diff     │
                        │  functions for team  │
                        │  members, tasks,     │
                        │  messages            │
                        └──────────────────────┘

  Before PR #28:  SessionBridge = 2,031 lines (god class)
  After PR #28:   SessionBridge = 1,458 lines + 4 extracted modules
                  18 characterization tests verify behavioral equivalence
```

---

## Data Flow: Local Session

```
Consumer (React)                                     BeamCode Server
     │                                                     │
     │  ws://localhost:3456/ws/consumer/:sessionId         │
     ├────────────────────────────────────────────────────►│
     │                                                     │
     │  InboundMessage (JSON)                              │
     │  { type: "user_message",                            │
     │    text: "fix the login bug" }                      │
     │         │                                           │
     │         ▼                                           │
     │  ConsumerGatekeeper.authenticate()                  │
     │         │                                           │
     │         ▼                                           │
     │  SessionBridge.handleConsumerMessage()               │
     │         │                                           │
     │         ▼                                           │
     │  BackendAdapter.send(UnifiedMessage)                 │
     │         │                                           │
     │         ▼                                           │
     │  SdkUrlAdapter → serializeNDJSON → Claude Code CLI  │
     │                                           │         │
     │                                     CLI response    │
     │                                           │         │
     │  CLIMessage → translateCLI() → UnifiedMessage       │
     │         │                                           │
     │         ▼                                           │
     │  routeUnifiedMessage()                              │
     │         │                                           │
     │         ▼                                           │
     │  ConsumerBroadcaster.broadcast(ConsumerMessage)     │
     │         │                                           │
     │ ◄───────┘                                           │
     │  ConsumerMessage (JSON)                             │
     │  { type: "assistant",                               │
     │    message: { ... } }                               │
```

---

## Data Flow: Remote Session (Relay MVP)

```
Web Consumer                   cloudflared (sidecar)          Daemon (localhost)
     │                         CF Tunnel Edge                       │
     │                               │                              │
     │  === ONE-TIME PAIRING ===     │                              │
     │                               │                              │
     │  1. Daemon generates keypair, │                              │
     │     prints pairing link:      │                              │
     │     https://tunnel.example.com/pair?pk=<base64>&v=1          │
     │                               │                              │
     │  2. User opens link on mobile │                              │
     │     Browser extracts daemon   │                              │
     │     public key from URL       │                              │
     │                               │                              │
     │  3. Browser generates own     │                              │
     │     keypair, sends public     │                              │
     │     key encrypted with        │                              │
     │     daemon's public key       │                              │
     │     (sealed box)              │                              │
     │                               │                              │
     │  === ENCRYPTED SESSION ===    │                              │
     │                               │                              │
     │  4. Send encrypted message    │                              │
     │  EncryptedEnvelope:           │                              │
     │  { v: 1,                      │                              │
     │    sid: "abc-123",            │                              │
     │    ct: "<sealed box>",        │                              │
     │    len: 42 }                  │                              │
     │                               │                              │
     ├──HTTPS─────────────────────►  │                              │
     │                               ├──localhost:PORT────────────► │
     │                               │   (reverse proxy)            │
     │  Tunnel sees ONLY:            │                              ├── decrypt(ct)
     │  { v, sid, ct, len }          │                              │   JSON.parse
     │  Cannot read ct contents      │                              │   InboundMessage
     │                               │                              │      │
     │                               │                              │   routeConsumerMsg
     │                               │                              │      │
     │                               │                              │   UnifiedMessage
     │                               │                              │      │
     │                               │                              │   SdkUrlAdapter
     │                               │                              │      │
     │                               │                              │   serializeNDJSON
     │                               │                              │      │
     │                               │                              │   Claude Code CLI
     │                               │                              │      │
     │                               │                              │   5. CLI response
     │                               │                              │ ◄────┘
     │                               │                              │   CLIMessage
     │                               │                              │   routeCLIMessage
     │                               │                              │   ConsumerMessage
     │                               │                              │   encrypt(msg)
     │                               │                              │      │
     │                               │   6. Encrypted response      │      │
     │                               │ ◄────────────────────────────┤──────┘
     │ ◄─────────────────────────────┤   EncryptedEnvelope          │
     │   7. decrypt, render          │   { v:1, sid:"abc-123",      │
     │                               │     ct:"<sealed>", len:340 } │
     │  Consumer sees:               │                              │
     │  { type: "assistant",         │                              │
     │    seq: 42,                   │                              │
     │    message_id: "msg_42",      │                              │
     │    message: {...} }           │                              │
```

---

## Pairing Link Flow (replaces QR code for MVP)

```
  DAEMON (terminal)                              MOBILE BROWSER
  ───────────────                                ──────────────

  1. Generate X25519 keypair
     pk = daemon public key
     sk = daemon secret key (sodium_malloc, mlock'd)

  2. Start cloudflared tunnel
     tunnel_url = https://random.cfargotunnel.com

  3. Print pairing link:
     ┌─────────────────────────────────────────────────┐
     │  beamcode: pairing link ready         │
     │                                                 │
     │  https://random.cfargotunnel.com/pair           │
     │    ?pk=<base64url(daemon_public_key)>           │
     │    &fp=<first 8 chars SHA256(pk)>               │
     │    &v=1                                         │
     │                                                 │
     │  Link expires in 60 seconds.                    │
     │  Fingerprint: a3f8 b2c1                         │
     └─────────────────────────────────────────────────┘
                    │
                    │  4. User copies link or types URL
                    │
                    ▼
              5. Browser extracts pk from URL params
              6. Browser generates own X25519 keypair
              7. Browser sends own public key to daemon
                 (encrypted with daemon pk via sealed box)
              8. Both sides now have each other's public keys
              9. All subsequent messages use crypto_box
                 (authenticated bidirectional E2E)

  POST-MVP UPGRADE:
  • QR code rendering in terminal (qrcode-terminal)
  • QR scanning via navigator.mediaDevices
  • Saves the "copy URL" step
```

---

## Reconnection Flow

```
Web Consumer                                   Daemon
     │                                           │
     │  Connected, receiving SequencedMessage<T> │
     │  seq: 38, 39, 40, 41...                   │
     │                                           │
     ╳  Network drops (WiFi → cellular)          │
     │                                           │
     │  (1-5 seconds)                            │  Messages 42, 43, 44
     │                                           │  queued in per-consumer
     │  Exponential backoff reconnect            │  send buffer (high-water mark)
     ├──────────────────────────────────────────►│
     │  { type: "reconnect",                     │
     │    consumer_id: "c_xyz",  ← stable ID     │
     │    session_id: "abc",                     │
     │    last_seen_seq: 41 }                    │
     │                                           │
     │  Look up consumer by ID (not socket ref)  │
     │  Replay from seq 42                       │
     │◄──────────────────────────────────────────┤
     │  { type: "reconnect_ack",                 │
     │    missed_count: 3 }                      │
     │  EncryptedEnvelope { sid, ct(seq:42) }    │
     │  EncryptedEnvelope { sid, ct(seq:43) }    │
     │  EncryptedEnvelope { sid, ct(seq:44) }    │
     │                                           │
     │  Resume normal flow                       │
     │  EncryptedEnvelope { sid, ct(seq:45) }    │
     │                                           │
     │  ─── BACKPRESSURE ───                     │
     │  If consumer falls behind:                │
     │  • Queue > high-water mark                │
     │  • Drop non-critical (stream_event)       │
     │  • Keep critical (permission_request)     │
     │  • If queue overflows → disconnect        │
```

---

## Implementation Progress

```
Week  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22
      ├──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤
      │     │           │                                │                 │
      │Ph 0 │  Phase 1  │         Phase 2                │    Phase 3      │
      │Found│  SdkUrl   │       RELAY MVP                │  Library + ACP  │
      │ation│  Extract  │      (6-8 weeks)               │  + Codex        │
      │     │           │                                │  (4-6 weeks)    │
      ├─────┤───────────┤────────────────────────────────┤─────────────────┤
      │     │           │                                │                 │
      │ ✅  │ ✅        │ Daemon (2wk):                  │ Extract lib     │
      │Uni- │routeCLIMsg│  Child-process (~50% reuse)    │ from relay code │
      │fied │decompose  │  Lock+State+HTTP API           │ (1-2wk)         │
      │Msg  │CLILaunch→ │  Signal handling               │                 │
      │     │SdkUrlLnch │                                │ ACP adapter ✅   │
      │Back │           │ Relay (1.5-2wk):               │  JSON-RPC/stdio │
      │end  │SessionStat│  cloudflared sidecar           │  (built early)  │
      │Adpt │generalize │  Reverse proxy model           │                 │
      │     │           │  Session routing (as-is)       │ Codex adapter ✅ │
      │Comp │Event map  │                                │  JSON-RPC/WS    │
      │osed │generalize │ E2E Crypto (2-2.5wk):          │  Thread/Turn/   │
      │Intfc│           │  libsodium sealed boxes        │  Item model     │
      │     │ ✅ Bridge │  Pairing link (not QR)         │                 │
      │Orig │ refactor  │  EncryptedEnvelope format      │ AgentSdk ✅      │
      │+Tok │ (PR #28)  │  Permission signing + replay   │  (built early)  │
      │     │           │  Session revocation            │                 │
      │ ✅  │ ✅ Error  │  Rate limiting                 │ Contract tests  │
      │     │ types,    │                                │ (1wk rework     │
      │     │ versioning│ Reconnection (1-1.5wk):        │  buffer)        │
      │     │ logging   │  Stable consumer IDs           │                 │
      │     │ (PR #27)  │  SequencedMessage<T>           │                 │
      │     │           │  Replay from last_seen_seq     │                 │
      │     │ ✅ React  │  Per-consumer backpressure     │                 │
      │     │ consumer  │                                │                 │
      │     │ (PRs      │ Web Consumer:                  │                 │
      │     │  #25, #26)│  Already built (React app)     │                 │
      │     │           │  E2E decrypt integration       │                 │
      │     │           │  Permission handling ✅         │                 │
      │     │           │                                │                 │
      │     │           │ ┌── Phase 2.5 (overlap) ──┐    │                 │
      │     │           │ │ ACP Research (3-5 days) │    │                 │
      │     │           │ │ Read spec, prototype    │    │                 │
      │     │           │ │ JSON-RPC, test vs Goose │    │                 │
      │     │           │ └─────────────────────────┘    │                 │
      ├─────┴───────────┴────────────────────────────────┴─────────────────┤
      │  Test Infrastructure (parallel throughout)                         │
      │  Contract tests → Integration → Relay E2E → ACP + Codex validation │
      └────────────────────────────────────────────────────────────────────┘

      PHASE 0 + 1 STATUS: ✅ COMPLETE
      • UnifiedMessage, BackendAdapter, BackendSession interfaces defined
      • SdkUrl adapter extracted with message translation + state reduction
      • SessionBridge decomposed into cohesive modules (PR #28)
      • Error types, state versioning, structured logging (PR #27)
      • React consumer with companion-style UI (PRs #25, #26)
      • All 4 adapters built (SdkUrl, ACP, Codex, AgentSdk)
      • Team coordination (members, tasks, events)

      PHASE 2 STATUS: IN PROGRESS
      • Daemon scaffolding exists (daemon.ts, health-check.ts, state-file.ts)
      • CloudflaredManager exists (dev + production modes)
      • Encryption layer scaffolded (encryption-layer.ts)
      • Tunnel relay adapter scaffolded (tunnel-relay-adapter.ts)
      • Remaining: full E2E crypto, pairing flow, reconnection, integration

      ABORT TRIGGERS:
      #1: Phase 1 > 3 weeks → abstraction is wrong
      #2: Permission coordination > 500 LOC → too complex
      #3: Adapter needs PTY for basic msg (send/receive/result) → agent not ready
      #4: UnifiedMessage changes > 2x during Phase 3 → type too specific
      #5: Crypto overhead > 5ms/msg → implementation wrong
      #6: Same-region RTT > 200ms → architecture wrong
      #7: Cross-region RTT > 500ms → investigate
```

---

## Parallel Tracks Option (2 Engineers)

```
Week  1  2  3  4  5  6  7  8  9 10 11 12 13 14
      ├──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤──┤
      │     │                                  │
      │Ph 0 │    PARALLEL EXECUTION            │
      │BOTH │                                  │
      │     │                                  │
      ├─────┤                                  │
      │     │                                  │
      │     │  TRACK 1 (Adapter Engineer)      │
      │     ├──────────────────────────────────┤
      │     │ SdkUrl Extract   │ ACP Adapter   │ Integration
      │     │ (3-4 wk)         │ (2-3 wk)      │ Support
      │     │ Decompose Bridge │ JSON-RPC      │ (1-2 wk)
      │     │ BackendAdapter   │ stdio         │
      │     │ Contract tests   │ VALIDATES     │
      │     │                  │ interfaces    │
      │     │                  │               │
      │     │  TRACK 2 (Relay Engineer)        │
      │     ├──────────────────────────────────┤
      │     │ Daemon + Tunnel    │ E2E + Recon │ Integration
      │     │ (4-5 wk)           │ (3-4 wk)    │ + Consumer
      │     │ Child-process      │ libsodium   │ (1-2 wk)
      │     │ cloudflared        │ Pairing link│
      │     │ HTTP API           │ Reconnection│
      │     │                    │ Backpressure│
      │     │                    │             │
      │     │              CONVERGENCE ▼       │
      │     │         Week 10: Relay wires     │
      │     │         to BackendAdapter        │
      │     │         (validated by 2          │
      │     │          protocols already)      │
      ├─────┴──────────────────────────────────┤
      │                                        │
      │  Week  6: v0.1.0 — SdkUrl adapter lib  │◄── FIRST OUTPUT
      │  Week 10: v0.2.0-alpha — relay works   │
      │  Week 12: v0.2.0-beta — ACP validated  │
      │  Week 14: v0.2.0 — full relay MVP      │◄── SHIPS
      └────────────────────────────────────────┘

      Advantages:                  Disadvantages:
      • Abstractions from 2        • Requires 2 engineers
        protocols (not 1)          • Integration risk at
      • First output at wk 6        convergence (wk 10)
      • Risk distributed           • Communication overhead
      • ACP validated by wk 9       (weekly sync needed)
```

---

## Security Architecture Detail

```
┌──────────────────────────────────────────────────────────────────┐
│                     SECURITY LAYERS                              │
│                                                                  │
│  LAYER 1: Transport (Phase 0) ✅                                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • WebSocket origin validation (reject untrusted origins)   │  │
│  │ • CLI auth tokens (?token=SECRET per session)              │  │
│  │ • ConsumerGatekeeper: pluggable Authenticator interface    │  │
│  │ • RBAC: PARTICIPANT vs OBSERVER role-based message filter  │  │
│  │ • Per-consumer rate limiting: 10 msg/s, 100 KB/s           │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 2: E2E Encryption (Phase 2)                               │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • libsodium sealed boxes (XSalsa20-Poly1305)               │  │
│  │ • sodium_malloc for key material (mlock'd, not swappable)  │  │
│  │ • Per-message ephemeral keys (limited forward secrecy)     │  │
│  │ • Relay MUST NOT persist encrypted blobs (stateless only)  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 3: Authentication (Phase 2)                               │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • Permission signing: HMAC-SHA256(secret,                  │  │
│  │     request_id + behavior + timestamp + nonce)             │  │
│  │ • Anti-replay: nonce set (last 1000), 30s timestamp window │  │
│  │ • One-response-per-request (pendingPermissions.delete)     │  │
│  │ • Secret established locally (daemon→CLI, never over relay)│  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 4: Device Management (Phase 2)                            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • Session revocation: revoke-device → new keypair → re-pair│  │
│  │ • Pairing link expires in 60 seconds                       │  │
│  │ • Single device per pairing cycle                          │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 5: Resilience (Phase 0) ✅                                │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • SlidingWindowBreaker: circuit breaker with snapshot API  │  │
│  │ • Structured error types (BeamCodeError hierarchy)         │  │
│  │ • Secret redaction in process output forwarding            │  │
│  │ • Watchdog timers for reconnect grace periods              │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  DEFERRED (post-MVP):                                            │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • Session file encryption at rest (XChaCha20 + OS keychain)│  │
│  │ • QR code scanning (upgrade from pairing link)             │  │
│  │ • Message size padding (privacy vs metadata leaks)         │  │
│  │ • Mutual TLS, expanded RBAC, audit logging                 │  │
│  │ • Forward secrecy beyond sealed box ephemeral keys         │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  KNOWN METADATA LEAKS (documented, acceptable for MVP):          │
│  • Session ID (required for routing, random UUID)                │
│  • Message timing (reveals activity patterns)                    │
│  • Message size (large = code output, small = user input)        │
│  • Connection duration, IP addresses, message count              │
└──────────────────────────────────────────────────────────────────┘
```

---

## Package Structure (Current)

```
beamcode/                     ◄── Single npm package (v0.1.0)
├── src/
│   ├── bin/
│   │   └── beamcode.ts               ◄── CLI entry point, wires StructuredLogger
│   │
│   ├── errors.ts                      ◄── BeamCodeError, StorageError, ProcessError
│   │
│   ├── core/                          ◄── SessionBridge + extracted modules
│   │   ├── session-bridge.ts          ◄── Orchestrator (1,458 LOC, TypedEventEmitter)
│   │   ├── session-store.ts           ◄── Session CRUD + persistence (226 LOC)
│   │   ├── session-manager.ts         ◄── Orchestrates bridge + SdkUrlLauncher
│   │   ├── consumer-broadcaster.ts    ◄── WS fan-out, backpressure, role filter (137 LOC)
│   │   ├── consumer-gatekeeper.ts     ◄── Auth, RBAC, rate limiting (122 LOC)
│   │   ├── team-event-differ.ts       ◄── Pure team state diff (101 LOC)
│   │   ├── slash-command-registry.ts  ◄── Per-session command dispatch
│   │   ├── slash-command-executor.ts  ◄── Command execution
│   │   ├── team-*.ts                  ◄── Team coordination (members, tasks, state)
│   │   ├── process-supervisor.ts      ◄── Process lifecycle management
│   │   ├── types/
│   │   │   ├── unified-message.ts     ◄── Phase 0.1 canonical message envelope
│   │   │   ├── core-session-state.ts  ◄── Minimal adapter-agnostic state
│   │   │   ├── backend-adapter.ts     ◄── BackendAdapter + BackendSession interfaces
│   │   │   └── team-types.ts          ◄── TeamMember, TeamTask, TeamState, TeamEvent
│   │   └── interfaces/
│   │       └── backend-adapter*.ts    ◄── Interface specs + compliance tests
│   │
│   ├── adapters/
│   │   ├── sdk-url/                   ◄── Claude Code CLI (NDJSON/WS, streaming, teams)
│   │   │   ├── sdk-url-adapter.ts
│   │   │   ├── sdk-url-launcher.ts
│   │   │   ├── message-translator.ts
│   │   │   ├── inbound-translator.ts
│   │   │   └── state-reducer.ts
│   │   ├── acp/                       ◄── Agent Client Protocol (JSON-RPC/stdio)
│   │   │   ├── acp-adapter.ts
│   │   │   ├── acp-session.ts
│   │   │   ├── json-rpc.ts
│   │   │   ├── outbound-translator.ts
│   │   │   └── inbound-translator.ts
│   │   ├── codex/                     ◄── Codex (JSON-RPC/WS, Thread/Turn/Item)
│   │   │   ├── codex-adapter.ts
│   │   │   ├── codex-session.ts
│   │   │   ├── codex-message-translator.ts
│   │   │   └── codex-launcher.ts
│   │   ├── agent-sdk/                 ◄── Anthropic Agent SDK (JS query fn, teams)
│   │   │   ├── agent-sdk-adapter.ts
│   │   │   ├── agent-sdk-session.ts
│   │   │   └── sdk-message-translator.ts
│   │   ├── file-storage.ts           ◄── SessionStorage impl (debounced + migrator)
│   │   ├── state-migrator.ts          ◄── Schema versioning, migration chain (v0→v1+)
│   │   ├── structured-logger.ts       ◄── JSON-line logging with component context
│   │   └── sliding-window-breaker.ts  ◄── Circuit breaker with snapshot API
│   │
│   ├── daemon/                        ◄── Process supervisor + health checks
│   │   ├── daemon.ts                  ◄── Lock file, state file, signal handling
│   │   ├── health-check.ts
│   │   └── state-file.ts
│   │
│   ├── relay/                         ◄── Encryption + tunnel management
│   │   ├── cloudflared-manager.ts     ◄── Sidecar: dev (free tunnel) / prod (token)
│   │   ├── encryption-layer.ts        ◄── libsodium key derivation, encrypt/decrypt
│   │   ├── tunnel-relay-adapter.ts
│   │   └── session-router.ts
│   │
│   ├── http/                          ◄── HTTP request routing
│   │   ├── server.ts                  ◄── HTTP router
│   │   ├── api-sessions.ts            ◄── REST /api/sessions endpoints
│   │   ├── consumer-html.ts           ◄── Serves embedded React consumer
│   │   └── health.ts
│   │
│   ├── server/                        ◄── WebSocket layer
│   │   ├── auth-token.ts
│   │   ├── consumer-channel.ts        ◄── Per-consumer queue + backpressure
│   │   ├── origin-validator.ts
│   │   └── reconnection-handler.ts
│   │
│   ├── consumer/                      ◄── Legacy consumer (being replaced by web/)
│   │   ├── index.html
│   │   ├── renderer.ts
│   │   └── permission-ui.ts
│   │
│   ├── types/                         ◄── Shared type definitions
│   │   ├── session-state.ts           ◄── SessionState (extends DevToolSessionState)
│   │   ├── consumer-messages.ts       ◄── ConsumerMessage union (30+ subtypes)
│   │   ├── cli-messages.ts            ◄── CLI protocol types
│   │   ├── inbound-messages.ts        ◄── Consumer→Bridge messages
│   │   ├── events.ts                  ◄── Bridge event types
│   │   ├── config.ts
│   │   └── auth.ts                    ◄── ConsumerRole, ConsumerIdentity, Authenticator
│   │
│   ├── interfaces/                    ◄── Runtime contracts
│   │   ├── auth.ts                    ◄── Authenticator interface
│   │   ├── storage.ts                 ◄── SessionStorage, LauncherStateStorage
│   │   ├── logger.ts
│   │   ├── process-manager.ts
│   │   └── transport.ts              ◄── WebSocketLike interface
│   │
│   ├── utils/
│   │   ├── ndjson.ts                  ◄── Parse/serialize newline-delimited JSON
│   │   ├── ansi-strip.ts
│   │   ├── redact-secrets.ts          ◄── Secret redaction for process output
│   │   └── claude-detection.ts
│   │
│   ├── testing/                       ◄── Test fixtures + mocks
│   └── e2e/                           ◄── End-to-end test suites
│
├── web/                               ◄── React 19 consumer (separate Vite build)
│   ├── src/
│   │   ├── App.tsx                    ◄── ErrorBoundary + bootstrap
│   │   ├── store.ts                   ◄── Zustand state (sessions, toasts, logs, ...)
│   │   ├── ws.ts                      ◄── WebSocket with auto-reconnect
│   │   ├── api.ts                     ◄── HTTP client for /api/sessions
│   │   ├── components/                ◄── 50+ React components
│   │   │   ├── ChatView.tsx           ◄── Message stream + streaming indicator
│   │   │   ├── Composer.tsx           ◄── Input + /slash commands
│   │   │   ├── AssistantMessage.tsx   ◄── Rich rendering (text, tool, thinking)
│   │   │   ├── ToolBlock.tsx          ◄── Tool execution visualization
│   │   │   ├── PermissionBanner.tsx   ◄── Permission request UI
│   │   │   ├── Sidebar.tsx            ◄── Sessions by date, archive, settings
│   │   │   ├── TopBar.tsx             ◄── Model, context gauge, connection
│   │   │   ├── StatusBar.tsx          ◄── Adapter, git, model, permissions
│   │   │   ├── AgentPane.tsx          ◄── Multi-agent inspection
│   │   │   ├── ToastContainer.tsx     ◄── Notifications (FIFO, max 5)
│   │   │   ├── LogDrawer.tsx          ◄── Process output viewer
│   │   │   ├── ConnectionBanner.tsx   ◄── Circuit breaker + watchdog UI
│   │   │   └── TaskPanel.tsx          ◄── Team task management
│   │   ├── hooks/
│   │   │   ├── useKeyboardShortcuts.ts
│   │   │   ├── useAgentGrid.ts
│   │   │   └── useDropdown.ts         ◄── Shared dropdown behavior
│   │   └── utils/
│   │       ├── format.ts              ◄── Number/token formatting
│   │       ├── ansi-strip.ts
│   │       ├── audio.ts              ◄── Web Audio completion sound + notifications
│   │       └── export.ts
│   └── vite.config.ts
│
├── shared/
│   └── consumer-types.ts              ◄── Flattened types for frontend (NO core/ imports)
│
└── package.json                       ◄── Exports adapters as subpaths
│
│  Future split:
│  @beamcode/core
│  @beamcode/adapter-*
│  @beamcode/daemon
│  @beamcode/relay
│  @beamcode/client
│  @beamcode/react
```

---

## Key Interfaces

```
┌──────────────────────────────────────────────────────────────────────┐
│  RUNTIME CONTRACTS                                                    │
│                                                                      │
│  BackendAdapter         → connect(options): Promise<BackendSession>  │
│  BackendSession         → send(), messages (AsyncIterable), close()  │
│  SessionStorage         → save(), load(), loadAll(), remove()        │
│  Authenticator          → authenticate(context)                      │
│  Logger                 → debug(), info(), warn(), error()           │
│  ProcessManager         → spawn(), kill(), isAlive()                 │
│  CommandRunner          → run(command, args, options)                │
│  RateLimiter            → check()                                    │
│  CircuitBreaker         → attempt(), recordSuccess/Failure()         │
│  MetricsCollector       → recordTurn(), recordToolUse()              │
│  WebSocketServerLike    → listen(), close()                          │
│  WebSocketLike          → send(), close(), on()                      │
│  GitInfoResolver        → resolveGitInfo(cwd)                        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## What Ships at ~19 Weeks (1 Engineer)

```
  ┌────────────────────────────────────────────────────┐
  │                    DELIVERED ✅                     │
  │                                                    │
  │  ✅ UnifiedMessage + BackendAdapter interfaces     │
  │  ✅ SdkUrl adapter (NDJSON/WS, streaming, teams)   │
  │  ✅ ACP adapter (JSON-RPC/stdio)                   │
  │  ✅ Codex adapter (JSON-RPC/WS)                    │
  │  ✅ AgentSdk adapter (query fn, teams)             │
  │  ✅ SessionBridge decomposition (PR #28)           │
  │  ✅ Structured error types (PR #27)                │
  │  ✅ State schema versioning + migration (PR #27)   │
  │  ✅ Structured logging (PR #27)                    │
  │  ✅ React consumer with companion-style UI         │
  │  ✅ Backpressure (per-consumer send queues)        │
  │  ✅ Per-consumer rate limiting                     │
  │  ✅ Team coordination (members, tasks, events)     │
  │  ✅ Circuit breaker with UI visibility             │
  │  ✅ Toast notifications + process log viewer       │
  │                                                    │
  ├────────────────────────────────────────────────────┤
  │                    IN PROGRESS                     │
  │                                                    │
  │  🔧 Daemon (scaffolded: lock, state, health)      │
  │  🔧 Relay (scaffolded: cloudflared, encryption)    │
  │  🔧 E2E encryption integration                    │
  │  🔧 Reconnection with message replay              │
  │                                                    │
  ├────────────────────────────────────────────────────┤
  │                    REMAINING                       │
  │                                                    │
  │  ⏳ Full E2E crypto (pairing, EncryptedEnvelope)   │
  │  ⏳ Session revocation (revoke-device)             │
  │  ⏳ Mobile browser → CF Tunnel → Daemon → CLI      │
  │  ⏳ npm package v0.2.0                             │
  │                                                    │
  ├────────────────────────────────────────────────────┤
  │                    DEFERRED                        │
  │                                                    │
  │  📋 QR code scanning (upgrade from pairing link)   │
  │  📋 Process persistence across daemon restarts     │
  │  📋 Session file encryption at rest                │
  │  📋 Push notifications (APNS/FCM)                  │
  │  📋 Streaming throttle modes                       │
  │  📋 Multi-device sync                              │
  │  📋 Custom relay server (upgrade from tunnel)      │
  │  📋 Mobile native app                              │
  │  📋 Message size padding (privacy)                 │
  │  📋 Mutual TLS / expanded RBAC / audit logging     │
  │                                                    │
  └────────────────────────────────────────────────────┘
```

---

## Risk Heat Map

```
                          LOW IMPACT ──────────────────── HIGH IMPACT
                    ┌─────────────┬─────────────┬─────────────┐
                    │             │             │             │
   HIGH             │             │ CF Tunnel   │ Phase 2     │
   PROBABILITY      │             │ free tier   │ scope       │
   (>40%)           │             │ changes     │ explosion   │
                    │             │             │             │
                    ├─────────────┼─────────────┼─────────────┤
                    │             │             │             │
   MEDIUM           │ PTY feature │ Extraction  │ Codex WS    │
   PROBABILITY      │ parity gap  │ gamble      │ mode stays  │
   (20-40%)         │ (local vs   │ (relay-     │ experimental│
                    │  remote)    │  biased     │ (fallback:  │
                    │             │  interfaces)│  stdio)     │
                    ├─────────────┼─────────────┼─────────────┤
                    │             │             │             │
   LOW              │             │ ACP window  │ E2E crypto  │
   PROBABILITY      │             │ closes      │ bug (key    │
   (<20%)           │             │ (competitor │ management  │
                    │             │  ships      │ flaw)       │
                    │             │  ACP+relay) │             │
                    └─────────────┴─────────────┴─────────────┘

   TOP 3 RISKS:
   1. Phase 2 scope explosion (HIGH prob, HIGH impact)
      Mitigation: hard timebox 7wk, cut E2E to transport-only if needed
   2. Extraction gamble (MED prob, MED-HIGH impact)
      Mitigation: ACP + Codex adapters validate universality; < 500 LOC signal
      Status: MITIGATED — all 4 adapters built, UnifiedMessage stable
   3. Codex WS mode experimental (MED prob, MED impact)
      Mitigation: stdio JSONL fallback; adapter supports both transports
```
