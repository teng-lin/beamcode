# Architecture Diagram


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
│  │                     HTTP + WS SERVER (localhost:3456)                 │          │
│  │                                                                       │          │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │          │
│  │  │  http/ — HTTP Request Router                                    │  │          │
│  │  │  ┌──────────────┐ ┌──────────────┐ ┌─────────────────────────┐  │  │          │
│  │  │  │ api-sessions │ │ consumer-    │ │ health                  │  │  │          │
│  │  │  │ REST CRUD    │ │ html (serves │ │ GET /health             │  │  │          │
│  │  │  │ /api/sessions│ │ React app)   │ │                         │  │  │          │
│  │  │  └──────────────┘ └──────────────┘ └─────────────────────────┘  │  │          │
│  │  └─────────────────────────────────────────────────────────────────┘  │          │
│  │                                                                       │          │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │          │
│  │  │  server/ — WebSocket Layer                                      │  │          │
│  │  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────────────┐   │  │          │
│  │  │  │ Origin       │ │ Auth Token   │ │ Reconnection Handler   │   │  │          │
│  │  │  │ Validation   │ │ Gate         │ │  Stable consumer IDs   │   │  │          │
│  │  │  └──────────────┘ └──────────────┘ │  Message replay        │   │  │          │
│  │  │                                    └────────────────────────┘   │  │          │
│  │  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────────────┐   │  │          │
│  │  │  │ Consumer     │ │ Consumer     │ │ Api-Key                │   │  │          │
│  │  │  │ Channel      │ │ Rate Limit   │ │ Authenticator          │   │  │          │
│  │  │  │ (per-client  │ │ token-bucket │ │                        │   │  │          │
│  │  │  │  send queue) │ │              │ │                        │   │  │          │
│  │  │  └──────────────┘ └──────────────┘ └────────────────────────┘   │  │          │
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
│  │  │  SessionBridge (orchestrator, TypedEventEmitter) ~629 LOC    │    │           │
│  │  │  Delegates to:                                               │    │           │
│  │  │  ┌───────────────────┐ ┌─────────────────┐ ┌──────────────┐  │    │           │
│  │  │  │ BackendLifecycle  │ │ UnifiedMessage  │ │ Consumer     │  │    │           │
│  │  │  │ Manager           │ │ Router          │ │ Transport    │  │    │           │
│  │  │  │ • connect/discon  │ │ • route()       │ │ Coordinator  │  │    │           │
│  │  │  │ • send            │ │ • state reduce  │ │ • WS open    │  │    │           │
│  │  │  │ • msg consume     │ │ • side effects  │ │ • WS close   │  │    │           │
│  │  │  └───────────────────┘ └─────────────────┘ └──────────────┘  │    │           │
│  │  │  ┌───────────────────┐ ┌─────────────────┐ ┌──────────────┐  │    │           │
│  │  │  │ SessionTransport  │ │ ReconnectCtrl   │ │ SessionStore │  │    │           │
│  │  │  │ Hub               │ │ • grace period  │ │ • session    │  │    │           │
│  │  │  │ • WS server setup │ │ • timer mgmt    │ │   CRUD       │  │    │           │
│  │  │  │ • inverted conn   │ │                 │ │ • persistence│  │    │           │
│  │  │  └───────────────────┘ └─────────────────┘ └──────────────┘  │    │           │
│  │  │  ┌──────────────────┐ ┌─────────────────┐ ┌──────────────┐   │    │           │ 
│  │  │  │ Consumer         │ │ Consumer        │ │ SlashCommand │   │    │           │
│  │  │  │ Broadcaster      │ │ Gatekeeper      │ │ Chain        │   │    │           │
│  │  │  │ • WS fan-out     │ │ • auth/RBAC     │ │ • handler    │   │    │           │
│  │  │  │ • backpressure   │ │ • rate limit    │ │   chain      │   │    │           │
│  │  │  │ • role filter    │ │ • observer mode │ │ • per-session│   │    │           │
│  │  │  └──────────────────┘ └─────────────────┘ └──────────────┘   │    │           │
│  │  │  ┌──────────────────┐ ┌─────────────────┐ ┌──────────────┐   │    │           │
│  │  │  │ TeamEvent        │ │ Capabilities    │ │ GitInfo      │   │    │           │
│  │  │  │ Differ           │ │ Protocol        │ │ Tracker      │   │    │           │
│  │  │  │ • pure state     │ │ • negotiation   │ │              │   │    │           │
│  │  │  │   diff logic     │ │                 │ │              │   │    │           │
│  │  │  └──────────────────┘ └─────────────────┘ └──────────────┘   │    │           │
│  │  └──────────────────────────────────────────────────────────────┘    │           │
│  │                                                                      │           │
│  │  ┌──────────────────────────────────────────────────────────────┐    │           │
│  │  │  SessionManager (orchestrates SessionBridge + launchers)     │    │           │
│  │  └──────────────────────────────────────────────────────────────┘    │           │
│  │                                                                      │           │
│  │  ╔════════════════════════════════════════════════════════════╗      │           │
│  │  ║                    UnifiedMessage                          ║      │           │
│  │  ║  id, timestamp, type, role, content[], metadata            ║      │           │
│  │  ║  Supports: streaming (Claude), request/response (ACP),     ║      │           │
│  │  ║  JSON-RPC (Codex/OpenCode), and query-based (AgentSdk)     ║      │           │
│  │  ║  + metadata escape hatch for adapter-specific data         ║      │           │
│  │  ║  + parentId for threading support                          ║      │           │
│  │  ╚════════════════════════════════════════════════════════════╝      │           │
│  │                                                                      │           │
│  │  ┌──────────────────────────────────────────────────────────────┐    │           │
│  │  │  State Hierarchy                                             │    │           │
│  │  │  CoreSessionState → DevToolSessionState → SessionState       │    │           │
│  │  │  (adapter-agnostic)  (git branch, repo)   (model, tools,     │    │           │
│  │  │                                            team, circuit     │    │           │
│  │  │                                            breaker, ...)     │    │           │
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
│        ┌──────────────────┼──────────────────┬──────────┬────────┬───────┐          │
│        │                  │                  │          │        │       │          │
│        ▼                  ▼                  ▼          ▼        ▼       ▼          │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐  ┌──────────┐  ┌──────┐ ┌──────┐    │
│  │ Claude   │  │ ACP        │  │ Codex        │  │ AgentSdk │  │Gemini│ │Open- │    │
│  │ Adapter  │  │ Adapter    │  │ Adapter      │  │ Adapter  │  │Adapt │ │code  │    │
│  │ ✅ BUILT │  │ ✅ BUILT    │  │ ✅ BUILT     │  │ ✅ BUILT │  │✅     │ │Adapt │    │
│  │ NDJSON/  │  │ JSON-RPC/  │  │ JSON-RPC/WS  │  │ JS query │  │wraps │ │✅    │    │
│  │ WS --sdk │  │ stdio      │  │ app-server   │  │ fn       │  │ACP   │ │REST+ │    │
│  │ stream,  │  │            │  │ Thread/Turn/ │  │ Anthropic│  │      │ │SSE   │    │
│  │ perms,   │  │            │  │ Item model   │  │ SDK teams│  │      │ │      │    │
│  │ teams    │  │            │  │              │  │          │  │      │ │      │    │
│  └────┬─────┘  └─────┬──────┘  └──────┬───────┘  └────┬─────┘  └──┬───┘ └──┬───┘    │
│       │              │                │               │           │        │        │
│       ▼              ▼                ▼               ▼           ▼        ▼        │
│  ╔═════════╗  ╔══════════════╗  ╔═══════════╗  ╔══════════╗ ╔═══════╗ ╔═══════╗     │
│  ║ Claude  ║  ║ Goose/Kiro/  ║  ║ Codex CLI ║  ║Anthropic ║ ║Gemini ║ ║open-  ║     │
│  ║ Code CLI║  ║ Gemini (ACP) ║  ║ (OpenAI)  ║  ║ API      ║ ║ CLI   ║ ║ code  ║     │
│  ║ (child) ║  ╚══════════════╝  ╚═══════════╝  ╚══════════╝ ╚═══════╝ ╚═══════╝     │
│  ╚═════════╝                                                                        │
│                                                                                     │
│  ┌───────────────────────────────────────────────────────────────────────┐          │
│  │  CROSS-CUTTING INFRASTRUCTURE                                         │          │
│  │                                                                       │          │
│  │  ┌─────────────────┐ ┌─────────────────┐ ┌────────────────────────┐   │          │
│  │  │ errors.ts       │ │ state-migrator  │ │ structured-logger      │   │          │
│  │  │ BeamCodeError   │ │ Schema version  │ │ JSON-line logging      │   │          │
│  │  │ StorageError    │ │ + migration     │ │ component context      │   │          │
│  │  │ ProcessError    │ │ chain (v0→v1+)  │ │ level filtering        │   │          │
│  │  └─────────────────┘ └─────────────────┘ └────────────────────────┘   │          │
│  │                                                                       │          │
│  │  ┌─────────────────┐ ┌─────────────────┐ ┌────────────────────────┐   │          │
│  │  │ FileStorage     │ │ CircuitBreaker  │ │ ProcessManager         │   │          │
│  │  │ debounced write │ │ SlidingWindow   │ │ spawn, kill, isAlive   │   │          │
│  │  │ + schema vers.  │ │ + snapshot API  │ │ signal handling        │   │          │
│  │  └─────────────────┘ └─────────────────┘ └────────────────────────┘   │          │
│  │                                                                       │          │
│  │  ┌─────────────────┐ ┌─────────────────┐ ┌────────────────────────┐   │          │
│  │  │ AdapterResolver │ │ SessionOperat-  │ │ MetricsCollector       │   │          │
│  │  │ create-adapter  │ │ ionalHandler    │ │ console-metrics        │   │          │
│  │  │ factory         │ │ privileged ops  │ │                        │   │          │
│  │  └─────────────────┘ └─────────────────┘ └────────────────────────┘   │          │
│  └───────────────────────────────────────────────────────────────────────┘          │
│                                                                                     │
│  ┌───────────────────────────────────────────────────────────────────────┐          │
│  │  DAEMON ✅ BUILT                                                      │          │
│  │  ┌───────────┐ ┌───────────┐ ┌──────────┐ ┌────────────────────┐      │          │
│  │  │ Lock File │ │ State     │ │ Health   │ │ Control API        │      │          │
│  │  │ O_CREAT|  │ │ File      │ │ Check    │ │ HTTP 127.0.0.1:0   │      │          │
│  │  │ O_EXCL    │ │ PID, port │ │ 60s loop │ │                    │      │          │
│  │  │           │ │ heartbeat │ │          │ │ • list sessions    │      │          │
│  │  │           │ │ version   │ │          │ │ • create session   │      │          │
│  │  │           │ │           │ │          │ │ • stop session     │      │          │
│  │  │           │ │           │ │          │ │ • revoke-device    │      │          │
│  │  └───────────┘ └───────────┘ └──────────┘ └────────────────────┘      │          │
│  │  ┌───────────────────────────┐ ┌────────────────────────────────┐     │          │
│  │  │ ChildProcessSupervisor    │ │ SignalHandler                  │     │          │
│  │  │ spawns/tracks beamcode    │ │ SIGTERM/SIGINT graceful stop   │     │          │
│  │  │ server child processes    │ │                                │     │          │
│  │  └───────────────────────────┘ └────────────────────────────────┘     │          │
│  └───────────────────────────────────────────────────────────────────────┘          │
│                                                                                     │
│  ┌───────────────────────────────────────────────────────────────────────┐          │
│  │  E2E ENCRYPTION LAYER (scaffolded, integration pending)               │          │
│  │                                                                       │          │
│  │  ┌────────────────┐ ┌────────────────┐ ┌──────────────────────┐       │          │
│  │  │ libsodium      │ │ Pairing Link   │ │ HMAC-SHA256          │       │          │
│  │  │ Sealed Boxes   │ │ Key Exchange   │ │ Permission Signing   │       │          │
│  │  │ XSalsa20-      │ │ (URL with      │ │ + nonce              │       │          │
│  │  │ Poly1305       │ │  public key +  │ │ + timestamp (30s)    │       │          │
│  │  └────────────────┘ │  tunnel addr)  │ │ + request_id binding │       │          │
│  │                     └────────────────┘ └──────────────────────┘       │          │
│  │                                                                       │          │
│  │  ┌────────────────────┐  ┌──────────────────────────────────┐         │          │
│  │  │ Session Revocation │  │ EncryptedEnvelope (wire format)  │         │          │
│  │  │ • revoke-device    │  │ { v:1, sid, ct, len }            │         │          │
│  │  │ • new keypair      │  └──────────────────────────────────┘         │          │
│  │  │ • force re-pair    │                                               │          │
│  │  └────────────────────┘  TUNNEL-BLIND: relay cannot decrypt.          │          │
│  └───────────────────────────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## React Consumer Architecture (web/)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     REACT CONSUMER (web/)                           │
│                     React 19 + Zustand + Tailwind v4 + Vite         │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  App.tsx (ErrorBoundary + Bootstrap)                           │ │
│  │                                                                │ │
│  │  ┌──────────────────────────────────────────────────────────┐  │ │
│  │  │  Layout                                                  │  │ │
│  │  │  ┌────────┐ ┌─────────────────────────────┐ ┌──────────┐ │  │ │
│  │  │  │Sidebar │ │  Main Area                  │ │AgentPane │ │  │ │
│  │  │  │        │ │  ┌───────────────────────┐  │ │          │ │  │ │
│  │  │  │Sessions│ │  │ TopBar                │  │ │AgentGrid │ │  │ │
│  │  │  │by date │ │  │ model, ContextGauge,  │  │ │AgentCol  │ │  │ │
│  │  │  │        │ │  │ connection status     │  │ │AgentRostr│ │  │ │
│  │  │  │Archive │ │  └───────────────────────┘  │ │          │ │  │ │
│  │  │  │mgmt    │ │  ┌────────────────────────┐ │ └──────────┘ │  │ │
│  │  │  │        │ │  │ ChatView / MessageFeed │ │              │  │ │
│  │  │  │Settings│ │  │ AssistantMessage       │ │              │  │ │
│  │  │  │footer  │ │  │ MessageBubble          │ │              │  │ │
│  │  │  │        │ │  │ UserMessageBubble      │ │              │  │ │
│  │  │  │Sound / │ │  │ ToolBlock / ToolGroup  │ │              │  │ │
│  │  │  │Notifs  │ │  │ ToolResultBlock        │ │              │  │ │
│  │  │  │Dark    │ │  │ ThinkingBlock          │ │              │  │ │
│  │  │  │mode    │ │  │ CodeBlock / DiffView   │ │              │  │ │
│  │  │  │        │ │  │ ImageBlock             │ │              │  │ │
│  │  │  │        │ │  │ PermissionBanner       │ │              │  │ │
│  │  │  │        │ │  │ StreamingIndicator     │ │              │  │ │
│  │  │  │        │ │  │ ResultBanner           │ │              │  │ │
│  │  │  └────────┘ │  └────────────────────────┘ │              │  │ │
│  │  │             │  ┌───────────────────────┐  │              │  │ │
│  │  │             │  │ Composer              │  │              │  │ │
│  │  │             │  │ SlashMenu             │  │              │  │ │
│  │  │             │  │ QueuedMessage         │  │              │  │ │
│  │  │             │  └───────────────────────┘  │              │  │ │
│  │  │             │  ┌───────────────────────┐  │              │  │ │
│  │  │             │  │ StatusBar             │  │              │  │ │
│  │  │             │  │ adapter, git, model,  │  │              │  │ │
│  │  │             │  │ permissions, worktree │  │              │  │ │
│  │  │             │  └───────────────────────┘  │              │  │ │
│  │  └──────────────────────────────────────────────────────────┘  │ │
│  │                                                                │ │
│  │  ┌─────────── Overlays ───────────────────────────────────┐    │ │
│  │  │ ToastContainer (FIFO, max 5)                           │    │ │
│  │  │ LogDrawer (process output)                             │    │ │
│  │  │ ConnectionBanner (circuit breaker)                     │    │ │
│  │  │ AuthBanner (authentication state)                      │    │ │
│  │  │ TaskPanel (team tasks)                                 │    │ │
│  │  │ QuickSwitcher (session switcher)                       │    │ │
│  │  │ ShortcutsModal (keyboard shortcuts)                    │    │ │
│  │  │ NewSessionDialog (adapter/model/cwd selection)         │    │ │
│  │  └────────────────────────────────────────────────────────┘    │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  store.ts — Zustand State                                      │ │
│  │  sessionData:  per-session messages, streaming state           │ │
│  │  sessions:     session list from API                           │ │
│  │  toasts:       notification queue                              │ │
│  │  processLogs:  per-session output ring buffer                  │ │
│  │  darkMode, sidebarOpen, taskPanelOpen, ...                     │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  ws.ts — WebSocket Connection                                  │ │
│  │  • Auto-reconnect with exponential backoff                     │ │
│  │  • Session handoff between tabs                                │ │
│  │  • Presence synchronization                                    │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  api.ts — HTTP Client                                          │ │
│  │  GET  /api/sessions         → list sessions                    │ │
│  │  GET  /api/sessions/:id     → session details                  │ │
│  │  POST /api/sessions/:id/msg → send message                     │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Core Module Decomposition

```
                        ┌──────────────────────────────┐
                        │      SessionManager          │
                        │  (orchestrates bridge +      │
                        │   launchers, ReconnectCtrl)  │
                        └──────────────┬───────────────┘
                                       │
                        ┌──────────────▼────────────────┐
                        │      SessionBridge  ~629 LOC  │
                        │  (TypedEventEmitter)          │
                        │                               │
                        │  Unified message routing:     │
                        │  CLI → normalizeInbound()     │
                        │      → route()                │
                        │  Consumer → handleInbound()   │
                        └──┬────┬───────┬────┬────┬─────┘
                           │    │       │    │    │
         ┌─────────────────┘    │       │    │    └──────────────────────┐
         ▼                      ▼       │    ▼                           ▼
┌──────────────────┐  ┌──────────────┐  │  ┌──────────────┐  ┌────────────────┐
│ BackendLifecycle │  │ Unified      │  │  │ Consumer     │  │ SessionStore   │
│ Manager          │  │ Message      │  │  │ Transport    │  │                │
│                  │  │ Router       │  │  │ Coordinator  │  │ Map<Session>   │
│ connect/discon   │  │              │  │  │              │  │ CRUD ops       │
│ send             │  │ route()      │  │  │ WS open/auth │  │ Persistence    │
│ consume loop     │  │ state reduce │  │  │ WS close     │  │ restore from   │
│                  │  │ broadcast    │  │  │ rate-limit   │  │ storage        │
└──────────────────┘  └──────────────┘  │  └──────────────┘  └────────────────┘
                                        │
                     ┌──────────────────┼───────────────────┐
                     ▼                  ▼                   ▼
            ┌─────────────┐  ┌───────────────────┐  ┌──────────────┐
            │  Consumer   │  │  SessionTransport │  │ SlashCommand │
            │  Broadcaster│  │  Hub              │  │ Chain        │
            │             │  │                   │  │              │
            │  WS fan-out │  │  WS server setup  │  │ Handler      │
            │  Backpressur│  │  inverted conn    │  │ chain for    │
            │  Role filter│  │  adapter support  │  │ command      │
            └─────────────┘  └───────────────────┘  │ dispatch     │
                                                    └──────────────┘

  Also extracted:
  • ConsumerGatekeeper   — pluggable auth, RBAC, observer mode
  • TeamEventDiffer      — pure team state diff (members, tasks, messages)
  • TeamStateReducer     — team state management
  • TeamToolCorrelation  — correlates tool results to team members
  • CapabilitiesProtocol — adapter capabilities negotiation
  • GitInfoTracker       — git branch/repo tracking
  • IdleSessionReaper    — cleans up idle sessions
  • InboundNormalizer    — validates + normalizes inbound messages
  • MessageQueueHandler  — async message queue processing
  • ConsumerMessageMapper — maps UnifiedMessage → ConsumerMessage
  • SessionStateReducer  — reduces CLI events into SessionState

  Before refactoring: SessionBridge ~2,031 lines (god class)
  After refactoring:  SessionBridge ~629 lines + 15+ extracted modules
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
     │  ConsumerTransportCoordinator.handleConsumerOpen()  │
     │  ConsumerGatekeeper.authenticate()                  │
     │         │                                           │
     │         ▼                                           │
     │  SessionBridge.handleConsumerMessage()              │
     │         │                                           │
     │         ▼                                           │
     │  BackendLifecycleManager.send(UnifiedMessage)       │
     │         │                                           │
     │         ▼                                           │
     │  ClaudeAdapter → serializeNDJSON → Claude Code CLI  │
     │                                           │         │
     │                                     CLI response    │
     │                                           │         │
     │  CLIMessage → InboundNormalizer → UnifiedMessage    │
     │         │                                           │
     │         ▼                                           │
     │  UnifiedMessageRouter.route()                       │
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
     │                               │                              │   ClaudeAdapter
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
     │  beamcode: pairing link ready                   │
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
  DELIVERED ✅
  ─────────────────────────────────────────────────────────────────
  ✅ UnifiedMessage + BackendAdapter/Session interfaces
  ✅ Claude adapter (NDJSON/WS, streaming, teams)
  ✅ ACP adapter (JSON-RPC/stdio)
  ✅ Codex adapter (JSON-RPC/WS, Thread/Turn/Item)
  ✅ AgentSdk adapter (query fn, teams)
  ✅ Gemini adapter (wraps ACP, spawns gemini --experimental-acp)
  ✅ OpenCode adapter (REST+SSE, demuxed sessions)
  ✅ SessionBridge decomposition (15+ extracted modules, ~629 LOC)
  ✅ SlashCommand handler chain (replaces binary routing)
  ✅ Structured error types
  ✅ State schema versioning + migration
  ✅ Structured logging
  ✅ React consumer with rich content rendering
  ✅ NewSessionDialog (adapter/model/cwd selection)
  ✅ QuickSwitcher, ShortcutsModal, SlashMenu
  ✅ ThinkingBlock, DiffView, CodeBlock, ImageBlock
  ✅ ToolGroupBlock, StreamingIndicator, ResultBanner
  ✅ Backpressure (per-consumer send queues)
  ✅ Per-consumer rate limiting (token-bucket)
  ✅ Team coordination (members, tasks, events)
  ✅ Circuit breaker with UI visibility
  ✅ Toast notifications + process log viewer
  ✅ AuthBanner (authentication state UI)
  ✅ Daemon (lock file, state file, health check, signal handling)
  ✅ Daemon Control API (HTTP 127.0.0.1, list/create/stop sessions)
  ✅ ChildProcessSupervisor (spawns beamcode server processes)
  ✅ Crypto layer (libsodium sealed boxes, HMAC signing, key manager)
  ✅ EncryptedEnvelope wire format
  ✅ Pairing link key exchange
  ✅ AdapterResolver + factory (create-adapter)
  ✅ SessionOperationalHandler (privileged ops)
  ✅ MetricsCollector interface + console impl

  IN PROGRESS 🔧
  ─────────────────────────────────────────────────────────────────
  🔧 E2E encryption integration (end-to-end flow, not just crypto units)
  🔧 Reconnection with message replay (SequencedMessage infra exists)
  🔧 Tunnel relay adapter (scaffolded, needs integration)

  REMAINING ⏳
  ─────────────────────────────────────────────────────────────────
  ⏳ Full pairing flow (browser ↔ daemon key exchange)
  ⏳ Session revocation (revoke-device → new keypair → re-pair)
  ⏳ Mobile browser → CF Tunnel → Daemon → CLI full path
  ⏳ npm package v0.2.0

  DEFERRED 📋
  ─────────────────────────────────────────────────────────────────
  📋 QR code scanning (upgrade from pairing link)
  📋 Process persistence across daemon restarts
  📋 Session file encryption at rest
  📋 Push notifications (APNS/FCM)
  📋 Streaming throttle modes
  📋 Multi-device sync
  📋 Custom relay server (upgrade from tunnel)
  📋 Mobile native app
  📋 Message size padding (privacy)
  📋 Mutual TLS / expanded RBAC / audit logging
```

---

## Security Architecture Detail

```
┌──────────────────────────────────────────────────────────────────┐
│                     SECURITY LAYERS                              │
│                                                                  │
│  LAYER 1: Transport ✅                                           │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • WebSocket origin validation (reject untrusted origins)   │  │
│  │ • CLI auth tokens (?token=SECRET per session)              │  │
│  │ • ConsumerGatekeeper: pluggable Authenticator interface    │  │
│  │ • ApiKeyAuthenticator: header-based auth                   │  │
│  │ • RBAC: PARTICIPANT vs OBSERVER role-based message filter  │  │
│  │ • Per-consumer rate limiting: token-bucket                 │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 2: E2E Encryption (crypto layer built, integration TBD)   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • libsodium sealed boxes (XSalsa20-Poly1305)               │  │
│  │ • sodium_malloc for key material (mlock'd, not swappable)  │  │
│  │ • Per-message ephemeral keys (limited forward secrecy)     │  │
│  │ • Relay MUST NOT persist encrypted blobs (stateless only)  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 3: Authentication ✅                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • Permission signing: HMAC-SHA256(secret,                  │  │
│  │     request_id + behavior + timestamp + nonce)             │  │
│  │ • Anti-replay: nonce set (last 1000), 30s timestamp window │  │
│  │ • One-response-per-request (pendingPermissions.delete)     │  │
│  │ • Secret established locally (daemon→CLI, never over relay)│  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 4: Device Management (pairing crypto built, flow TBD)     │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • Session revocation: revoke-device → new keypair → re-pair│  │
│  │ • Pairing link expires in 60 seconds                       │  │
│  │ • Single device per pairing cycle                          │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 5: Resilience ✅                                          │
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
│   │   └── beamcode.ts               ◄── CLI entry point
│   │
│   ├── errors.ts                      ◄── BeamCodeError, StorageError, ProcessError
│   │
│   ├── config/
│   │   └── config-schema.ts           ◄── Configuration schema + validation
│   │
│   ├── core/                          ◄── SessionBridge + extracted modules
│   │   ├── session-bridge.ts          ◄── Orchestrator (~629 LOC, TypedEventEmitter)
│   │   ├── session-store.ts           ◄── Session CRUD + persistence
│   │   ├── session-manager.ts         ◄── Orchestrates bridge + launchers
│   │   ├── backend-lifecycle-manager.ts ◄── BackendAdapter connect/disconnect/consume
│   │   ├── unified-message-router.ts  ◄── Routes UnifiedMessages, reduces state
│   │   ├── consumer-transport-coordinator.ts ◄── WS open/auth/close handling
│   │   ├── session-transport-hub.ts   ◄── WS server setup, inverted connections
│   │   ├── reconnect-controller.ts    ◄── Reconnect grace period + timer
│   │   ├── consumer-broadcaster.ts    ◄── WS fan-out, backpressure, role filter
│   │   ├── consumer-gatekeeper.ts     ◄── Auth, RBAC, rate limiting
│   │   ├── consumer-message-mapper.ts ◄── UnifiedMessage → ConsumerMessage
│   │   ├── inbound-normalizer.ts      ◄── Validates + normalizes inbound messages
│   │   ├── session-state-reducer.ts   ◄── CLI event → SessionState reduction
│   │   ├── team-event-differ.ts       ◄── Pure team state diff
│   │   ├── team-state-reducer.ts      ◄── Team state management
│   │   ├── team-tool-correlation.ts   ◄── Correlates tool results to team members
│   │   ├── team-tool-recognizer.ts    ◄── Recognizes tool use patterns
│   │   ├── capabilities-protocol.ts   ◄── Adapter capabilities negotiation
│   │   ├── git-info-tracker.ts        ◄── Git branch/repo tracking
│   │   ├── idle-session-reaper.ts     ◄── Idle session cleanup
│   │   ├── message-queue-handler.ts   ◄── Async message queue processing
│   │   ├── async-message-queue.ts     ◄── Async queue primitive
│   │   ├── slash-command-chain.ts     ◄── Handler chain (replaces binary routing)
│   │   ├── slash-command-registry.ts  ◄── Per-session command registration
│   │   ├── slash-command-executor.ts  ◄── Command execution
│   │   ├── process-supervisor.ts      ◄── Process lifecycle management
│   │   ├── cli-launcher.ts            ◄── CLI process launching
│   │   ├── typed-emitter.ts           ◄── TypedEventEmitter base
│   │   ├── types/
│   │   │   ├── unified-message.ts     ◄── Canonical message envelope
│   │   │   ├── core-session-state.ts  ◄── Minimal adapter-agnostic state
│   │   │   ├── team-types.ts          ◄── TeamMember, TeamTask, TeamState
│   │   │   └── sequenced-message.ts   ◄── SequencedMessage<T> for replay
│   │   └── interfaces/
│   │       ├── backend-adapter.ts     ◄── BackendAdapter + BackendSession interfaces
│   │       ├── extensions.ts          ◄── Composed extension interfaces
│   │       ├── inverted-connection-adapter.ts ◄── For adapters that push connections
│   │       ├── session-bridge-coordination.ts ◄── Internal bridge contracts
│   │       ├── session-launcher.ts    ◄── Launcher interface
│   │       └── session-manager-coordination.ts ◄── Manager contracts
│   │
│   ├── adapters/
│   │   ├── claude/                    ◄── Claude Code CLI (NDJSON/WS, streaming, teams)
│   │   │   ├── claude-adapter.ts
│   │   │   ├── claude-launcher.ts
│   │   │   ├── claude-session.ts
│   │   │   ├── socket-registry.ts
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
│   │   │   ├── codex-launcher.ts
│   │   │   └── codex-slash-executor.ts
│   │   ├── agent-sdk/                 ◄── Anthropic Agent SDK (JS query fn, teams)
│   │   │   ├── agent-sdk-adapter.ts
│   │   │   ├── agent-sdk-session.ts
│   │   │   ├── permission-bridge.ts
│   │   │   └── sdk-message-translator.ts
│   │   ├── gemini/                    ◄── Gemini CLI (wraps ACP adapter)
│   │   │   └── gemini-adapter.ts
│   │   ├── opencode/                  ◄── OpenCode (REST+SSE, demuxed sessions)
│   │   │   ├── opencode-adapter.ts
│   │   │   ├── opencode-session.ts
│   │   │   ├── opencode-launcher.ts
│   │   │   ├── opencode-http-client.ts
│   │   │   ├── opencode-message-translator.ts
│   │   │   ├── opencode-types.ts
│   │   │   └── sse-parser.ts
│   │   ├── adapter-resolver.ts        ◄── Resolves adapter by name
│   │   ├── create-adapter.ts          ◄── Factory for all adapters
│   │   ├── file-storage.ts            ◄── SessionStorage impl (debounced + migrator)
│   │   ├── state-migrator.ts          ◄── Schema versioning, migration chain
│   │   ├── structured-logger.ts       ◄── JSON-line logging with component context
│   │   ├── sliding-window-breaker.ts  ◄── Circuit breaker with snapshot API
│   │   ├── token-bucket-limiter.ts    ◄── Token-bucket rate limiter
│   │   ├── session-operational-handler.ts ◄── Privileged session ops (list/close/archive)
│   │   ├── console-metrics-collector.ts  ◄── Metrics → console output
│   │   ├── console-logger.ts
│   │   ├── noop-logger.ts
│   │   ├── memory-storage.ts
│   │   ├── node-process-manager.ts
│   │   ├── node-ws-server.ts
│   │   └── default-git-resolver.ts
│   │
│   ├── daemon/                        ◄── Process supervisor + daemon lifecycle
│   │   ├── daemon.ts                  ◄── Entry point: wires all daemon components
│   │   ├── child-process-supervisor.ts ◄── Spawns + tracks server child processes
│   │   ├── control-api.ts             ◄── HTTP control API (127.0.0.1, token-auth)
│   │   ├── lock-file.ts               ◄── O_CREAT|O_EXCL lock
│   │   ├── state-file.ts              ◄── PID, port, heartbeat, version
│   │   ├── health-check.ts            ◄── 60s health loop
│   │   └── signal-handler.ts          ◄── SIGTERM/SIGINT graceful stop
│   │
│   ├── relay/                         ◄── Encryption + tunnel management
│   │   ├── cloudflared-manager.ts     ◄── Sidecar: dev (free tunnel) / prod (token)
│   │   ├── encryption-layer.ts        ◄── libsodium key derivation, encrypt/decrypt
│   │   ├── tunnel-relay-adapter.ts    ◄── Relay BackendAdapter (scaffolded)
│   │   └── session-router.ts          ◄── Routes sessions through relay
│   │
│   ├── http/                          ◄── HTTP request routing
│   │   ├── server.ts                  ◄── HTTP router
│   │   ├── api-sessions.ts            ◄── REST /api/sessions endpoints
│   │   ├── consumer-html.ts           ◄── Serves embedded React consumer
│   │   └── health.ts
│   │
│   ├── server/                        ◄── WebSocket layer
│   │   ├── auth-token.ts
│   │   ├── api-key-authenticator.ts   ◄── Header-based API key auth
│   │   ├── consumer-channel.ts        ◄── Per-consumer queue + backpressure
│   │   ├── origin-validator.ts
│   │   └── reconnection-handler.ts
│   │
│   ├── types/                         ◄── Shared type definitions
│   │   ├── session-state.ts           ◄── SessionState (extends DevToolSessionState)
│   │   ├── consumer-messages.ts       ◄── ConsumerMessage union (30+ subtypes)
│   │   ├── cli-messages.ts            ◄── CLI protocol types
│   │   ├── inbound-messages.ts        ◄── Consumer→Bridge messages
│   │   ├── inbound-message-schema.ts  ◄── Zod schema for inbound validation
│   │   ├── operational-commands.ts    ◄── Privileged operational command types
│   │   ├── events.ts                  ◄── Bridge event types
│   │   ├── config.ts
│   │   └── auth.ts                    ◄── ConsumerRole, ConsumerIdentity, Authenticator
│   │
│   ├── interfaces/                    ◄── Runtime contracts
│   │   ├── auth.ts                    ◄── Authenticator interface
│   │   ├── storage.ts                 ◄── SessionStorage, LauncherStateStorage
│   │   ├── circuit-breaker.ts         ◄── CircuitBreaker interface
│   │   ├── metrics.ts                 ◄── MetricsCollector interface
│   │   ├── operational-handler.ts     ◄── OperationalHandler interface
│   │   ├── logger.ts
│   │   ├── process-manager.ts
│   │   ├── rate-limiter.ts
│   │   ├── git-resolver.ts
│   │   ├── ws-server.ts
│   │   └── transport.ts               ◄── WebSocketLike interface
│   │
│   ├── utils/
│   │   ├── crypto/                    ◄── libsodium wrappers
│   │   │   ├── sealed-box.ts          ◄── XSalsa20-Poly1305 sealed boxes
│   │   │   ├── crypto-box.ts          ◄── Authenticated bidirectional E2E
│   │   │   ├── hmac-signing.ts        ◄── Permission signing + anti-replay
│   │   │   ├── key-manager.ts         ◄── sodium_malloc key storage
│   │   │   ├── pairing.ts             ◄── Pairing link key exchange
│   │   │   ├── encrypted-envelope.ts  ◄── Wire format { v, sid, ct, len }
│   │   │   └── sodium-loader.ts       ◄── libsodium-wrappers init
│   │   ├── ndjson.ts                  ◄── Parse/serialize newline-delimited JSON
│   │   ├── ansi-strip.ts
│   │   ├── redact-secrets.ts          ◄── Secret redaction for process output
│   │   ├── claude-detection.ts
│   │   └── resolve-package-version.ts
│   │
│   ├── testing/                       ◄── Test fixtures + mocks
│   └── e2e/                           ◄── End-to-end test suites
│
├── web/                               ◄── React 19 consumer (separate Vite build)
│   └── src/
│       ├── App.tsx                    ◄── ErrorBoundary + bootstrap
│       ├── store.ts                   ◄── Zustand state
│       ├── ws.ts                      ◄── WebSocket with auto-reconnect
│       ├── api.ts                     ◄── HTTP client for /api/sessions
│       └── components/                ◄── 60+ React components
│           ├── ChatView.tsx / MessageFeed.tsx
│           ├── Composer.tsx / SlashMenu.tsx / QueuedMessage.tsx
│           ├── AssistantMessage.tsx / MessageBubble.tsx / UserMessageBubble.tsx
│           ├── ToolBlock.tsx / ToolGroupBlock.tsx / ToolResultBlock.tsx
│           ├── ThinkingBlock.tsx / StreamingIndicator.tsx
│           ├── CodeBlock.tsx / DiffView.tsx / ImageBlock.tsx / MarkdownContent.tsx
│           ├── PermissionBanner.tsx / ResultBanner.tsx
│           ├── Sidebar.tsx / TopBar.tsx / StatusBar.tsx / ContextGauge.tsx
│           ├── AgentPane.tsx / AgentGridView.tsx / AgentColumn.tsx / AgentRosterBlock.tsx
│           ├── ToastContainer.tsx / LogDrawer.tsx / ConnectionBanner.tsx
│           ├── AuthBanner.tsx / TaskPanel.tsx
│           ├── QuickSwitcher.tsx / ShortcutsModal.tsx
│           ├── NewSessionDialog.tsx / EmptyState.tsx
│           └── ResizeDivider.tsx
│
├── shared/
│   └── consumer-types.ts              ◄── Flattened types for frontend (NO core/ imports)
│
└── package.json                       ◄── Exports adapters as subpaths
```

---

## Key Interfaces

```
┌──────────────────────────────────────────────────────────────────────┐
│  RUNTIME CONTRACTS                                                   │
│                                                                      │
│  BackendAdapter         → connect(options): Promise<BackendSession>  │
│  BackendSession         → send(), messages (AsyncIterable), close()  │
│  SessionStorage         → save(), load(), loadAll(), remove()        │
│  Authenticator          → authenticate(context)                      │
│  OperationalHandler     → handle(command): Promise<OperationalResp>  │
│  Logger                 → debug(), info(), warn(), error()           │
│  ProcessManager         → spawn(), kill(), isAlive()                 │
│  RateLimiter            → check()                                    │
│  CircuitBreaker         → attempt(), recordSuccess/Failure()         │
│  MetricsCollector       → recordTurn(), recordToolUse()              │
│  WebSocketServerLike    → listen(), close()                          │
│  WebSocketLike          → send(), close(), on()                      │
│  GitInfoResolver        → resolveGitInfo(cwd)                        │
└──────────────────────────────────────────────────────────────────────┘
```
