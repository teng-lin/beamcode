# BeamCode Architecture

> Date: 2026-02-21
> Scope: Full system architecture — core, adapters, consumer, relay, daemon

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Core Design Principles](#core-design-principles)
- [Module Overview](#module-overview)
- [Core Modules](#core-modules)
  - [SessionCoordinator](#sessioncoordinator)
  - [SessionRuntime](#sessionruntime)
  - [DomainEventBus](#domaineventbus)
- [Transport Layer](#transport-layer)
  - [ConsumerGateway](#consumergateway)
  - [BackendConnector](#backendconnector)
  - [OutboundPublisher](#outboundpublisher)
- [Services](#services)
  - [SlashCommandService](#slashcommandservice)
  - [ConsumerProjector](#consumerprojector)
- [Policy Services](#policy-services)
  - [ReconnectPolicy](#reconnectpolicy)
  - [IdlePolicy](#idlepolicy)
  - [CapabilitiesPolicy](#capabilitiespolicy)
- [Persistence](#persistence)
  - [SessionRepository](#sessionrepository)
- [Pure Functions](#pure-functions)
- [Command and Event Flow](#command-and-event-flow)
  - [Commands vs Domain Events](#commands-vs-domain-events)
  - [DomainEventBus — Flat Pub/Sub](#domaineventbus--flat-pubsub)
  - [Inbound Data Flow](#inbound-data-flow)
  - [Outbound Data Flow](#outbound-data-flow)
  - [Translation Boundaries](#translation-boundaries)
- [Session Lifecycle State Machine](#session-lifecycle-state-machine)
- [Backend Adapters](#backend-adapters)
- [React Consumer](#react-consumer)
- [Daemon](#daemon)
- [Security Architecture](#security-architecture)
- [Cross-Cutting Infrastructure](#cross-cutting-infrastructure)
- [Module Dependency Graph](#module-dependency-graph)
- [File Layout](#file-layout)
- [Key Interfaces](#key-interfaces)

---

## Overview

BeamCode is a **message broker** — it routes messages between remote consumers (browser/phone via WebSocket) and local AI coding backends (Claude CLI, Codex, ACP, Gemini, OpenCode) with session-scoped state.

The core is built around a **per-session runtime actor** (`SessionRuntime`) that is the sole owner of mutable state, with four bounded contexts and explicit command/event separation.

> **Core invariant: Only `SessionRuntime` can mutate session state.
> Transport modules emit commands. Pure functions transform data.
> Policy services observe and advise — they never mutate.**

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              BEAMCODE SYSTEM ARCHITECTURE                           │
│                                                                                     │
│  ╔══════════════════════╗  ╔═══════════╗                                            │
│  ║ React Consumer       ║  ║  Desktop  ║  Consumers                                 │
│  ║ (web/)               ║  ║  Browser  ║  (any WebSocket client)                    │
│  ║ React 19 + Zustand   ║  ╚═════╤═════╝                                            │
│  ║ + Tailwind v4 + Vite ║        │                                                  │
│  ╚═══════╤══════════════╝        │                                                  │
│          │                       │                                                  │
│          │  HTTPS                │  ws://localhost                                  │
│          │                       │  (direct, no tunnel)                             │
│  ┌───────▼─────────┐             │                                                  │
│  │  Cloudflare     │             │                                                  │
│  │  Tunnel Edge    │             │  LOCAL PATH                                      │
│  └───────┬─────────┘             │                                                  │
│  ┌───────▼─────────┐             │                                                  │
│  │  cloudflared    │             │  ◄── sidecar process (Go binary)                 │
│  │  reverse proxy  │             │      proxies HTTPS → localhost:PORT              │
│  └───────┬─────────┘             │                                                  │
│          │ localhost:PORT        │                                                  │
│          │                       │                                                  │
│  ┌───────▼───────────────────────▼───────────────────────────────────────┐          │
│  │                     HTTP + WS SERVER (localhost:9414)                 │          │
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
│  │                    core/ — Four Bounded Contexts                     │           │
│  │                                                                      │           │
│  │  SessionControl │ BackendPlane │ ConsumerPlane │ MessagePlane        │           │
│  │  (see Core Modules section below for full detail)                    │           │
│  └──────────────────────────────────┬───────────────────────────────────┘           │
│                                     │                                               │
│        ┌────────────┐───────────────┼──────────────────┬────────┐                   │
│        │            │               │                  │        │                   │
│        ▼            ▼               ▼                  ▼        ▼                   │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐  ┌──────┐ ┌──────┐                  │
│  │ Claude   │  │ ACP        │  │ Codex        │  │Gemini│ │Open- │                  │
│  │ Adapter  │  │ Adapter    │  │ Adapter      │  │Adapt │ │code  │                  │
│  │ NDJSON/  │  │ JSON-RPC/  │  │ JSON-RPC/WS  │  │wraps │ │Adapt │                  │
│  │ WS --sdk │  │ stdio      │  │ app-server   │  │ACP   │ │REST+ │                  │
│  │ stream,  │  │            │  │ Thread/Turn/ │  │      │ │SSE   │                  │
│  │ perms,   │  │            │  │ Item model   │  │      │ │      │                  │
│  │ teams    │  │            │  │              │  │      │ │      │                  │
│  └────┬─────┘  └─────┬──────┘  └──────┬───────┘  └──┬───┘ └──┬───┘                  │
│       ▼              ▼                ▼             ▼        ▼                      │
│  ╔═════════╗  ╔══════════════╗  ╔═══════════╗  ╔═══════╗ ╔═══════╗                  │
│  ║ Claude  ║  ║ Goose/Kiro/  ║  ║ Codex CLI ║  ║Gemini ║ ║open-  ║                  │
│  ║ Code CLI║  ║ Gemini (ACP) ║  ║ (OpenAI)  ║  ║ CLI   ║ ║ code  ║                  │
│  ╚═════════╝  ╚══════════════╝  ╚═══════════╝  ╚═══════╝ ╚═══════╝                  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Design Principles

| # | Rule | Rationale |
|---|------|-----------|
| 1 | Only `SessionRuntime` can change session state | Eliminates shared-mutable-bag problem |
| 2 | Transport modules emit commands, never trigger business side effects directly | Clean separation between I/O and logic |
| 3 | `MessageRouter` is pure mapping + reduction; broadcasting is a projector step | No transport knowledge in message handling |
| 4 | Slash handling has one entrypoint (`executeSlashCommand`) and one completion contract | No split between registration and interception |
| 5 | Policy services observe state and emit commands to the runtime — they never mutate | Reconnect, idle, capabilities become advisors |
| 6 | Explicit lifecycle states for each session | Testable state machine, no implicit status inference |
| 7 | Session-scoped domain events flow from runtime; coordinator emits only global lifecycle events | Typed, meaningful events replace forwarding chains |
| 8 | Direct method calls, not actor mailbox | Node.js is single-threaded — the principle matters, not the mechanism |
| 9 | Per-session command handling is serialized | Avoids async interleaving bugs while keeping direct-call ergonomics |

### Four Bounded Contexts

| Context | Responsibility | Modules |
|---------|---------------|---------|
| **SessionControl** | Global lifecycle, per-session state ownership | `SessionCoordinator`, `SessionRuntime` (per-session), `SessionRepository`, `ReconnectPolicy`, `IdlePolicy`, `CapabilitiesPolicy` |
| **BackendPlane** | Adapter abstraction, connect/send/stream | `BackendConnector`, `AdapterResolver`, `BackendAdapter`(s) |
| **ConsumerPlane** | WebSocket transport, auth, rate limits, outbound push | `ConsumerGateway`, `OutboundPublisher` |
| **MessagePlane** | Pure translation, reduction, slash command resolution | `MessageRouter`, `StateReducer`, `ConsumerProjector`, `SlashCommandService` |

---

## Module Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          COMPOSITION ROOT                                   │
│                         (bin/beamcode.ts)                                   │
│                                                                             │
│  Creates all modules, injects dependencies, starts coordinator              │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │ constructs
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SessionCoordinator (~400L)                            │
│                                                                             │
│  Top-level facade: wires bridge + launcher + policies + services            │
│  Delegates event wiring to CoordinatorEventRelay                            │
│  Delegates relaunch dedup to BackendRecoveryService                         │
│  Delegates log redaction to ProcessLogService                               │
│  Delegates startup restore to StartupRestoreService                         │
└───┬──────────────────┬──────────────────────────────────────────────────────┘
    │                  │
    ▼                  ▼
┌────────┐  ┌──────────────────────────────────────────────────────────┐
│Domain  │  │               SessionBridge (~720L)                       │
│EventBus│  │                                                           │
└────────┘  │  Wires four bounded contexts, delegates runtime map       │
            │  ownership to RuntimeManager (src/core/bridge/)           │
            └───┬──────────┬──────────┬──────────┬─────────────────────┘
                │          │          │          │
                ▼          ▼          ▼          ▼
          ┌────────┐┌─────────┐┌─────────┐┌──────────────┐
          │Session ││Consumer ││ Backend ││   Runtime    │
          │Reposit.││ Gateway ││Connector││   Manager   │
          └────────┘└─────────┘└─────────┘└──────┬───────┘
                         │          │             │
                         ▼          ▼             ▼
                    ┌──────────────────────────┐
                    │    SessionRuntime        │
                    │    (one per session)     │
                    │    SOLE STATE OWNER      │
                    └──────────────────────────┘
```

---

## Core Modules

### SessionCoordinator

**File:** `src/core/session-coordinator.ts` (~400 lines)
**Context:** SessionControl
**Writes state:** No (delegates to runtime via bridge)

The SessionCoordinator is the **global lifecycle manager** and top-level facade. It wires `SessionBridge` with the launcher, transport hub, policies, and extracted services. It never mutates session state directly — that's each runtime's job via the bridge.

**Responsibilities:**
- **Create sessions:** Routes to the correct adapter (inverted vs direct connection), initiates the backend, seeds session state
- **Delete sessions:** Orchestrates teardown — kills CLI process, clears dedup state, closes WS connections, removes from registry
- **Restore from storage:** Delegates to `StartupRestoreService` (launcher first, then bridge — I6 ordering)
- **React to domain events:** Delegates to `CoordinatorEventRelay` which subscribes to bridge + launcher events for cross-session concerns:
  - `backend:relaunch_needed` → delegates to `BackendRecoveryService` (timer-guarded dedup)
  - `session:first_turn` → auto-name the session from the first user message
  - `process:exited` → broadcast circuit breaker state
  - `process:stdout/stderr` → redact secrets via `ProcessLogService`, broadcast to consumers

**Extracted services** (in `src/core/coordinator/`):

| Service | Responsibility |
|---------|---------------|
| `CoordinatorEventRelay` | Subscribes to bridge + launcher events, dispatches to handlers |
| `ProcessLogService` | Buffers and redacts process stdout/stderr |
| `BackendRecoveryService` | Timer-guarded relaunch dedup, graceful kill before relaunch |
| `StartupRestoreService` | Ordered restore: launcher → registry → bridge |

**Does NOT do:**
- Mutate any session-level state (history, backend connection, consumer sockets)
- Forward events between layers directly (delegates to relay)
- Route messages

```typescript
class SessionCoordinator {
  readonly bridge: SessionBridge
  readonly launcher: SessionLauncher
  readonly registry: SessionRegistry
  readonly domainEvents: DomainEventBus

  async start(): Promise<void>                               // relay + restore + policies + transport
  async stop(): Promise<void>                                // stop relay, policies, transport, adapters
  async createSession(options): Promise<SessionInfo>
  async deleteSession(id: string): Promise<boolean>

  // Delegated services (private)
  private relay: CoordinatorEventRelay
  private startupRestoreService: StartupRestoreService
  private recoveryService: BackendRecoveryService
  private processLogService: ProcessLogService
}
```

---

### SessionRuntime

**File:** `src/core/session-runtime.ts` (~400 lines)
**Context:** SessionControl
**Writes state:** **Yes — sole writer**

The SessionRuntime is a **per-session state owner**. One instance exists per active session. It is a thin command handler — it receives commands from transport modules and policy services, delegates to pure functions for actual logic, and applies the resulting state changes.

**Responsibilities:**
- **Own all mutable session state:** Lifecycle, backend connection, consumer sockets, conversation history, pending permissions, slash command registry, and the read-only projected `SessionState`
- **Handle inbound commands:** Receive `InboundCommand` from `ConsumerGateway`, dispatch by type (user_message, permission_response, slash_command, interrupt, queue operations)
- **Handle backend messages:** Receive `UnifiedMessage` from `BackendConnector`'s consumption loop, run through the pure reducer + projector pipeline, update history, broadcast to consumers, persist
- **Handle policy commands:** Receive advisory `PolicyCommand` from policy services (reconnect_timeout, idle_reap, capabilities_timeout) and act accordingly
- **Manage consumers:** Add/remove WebSocket connections, emit consumer:connected/disconnected domain events
- **Manage backend state:** Store/clear the `BackendSession` reference, emit backend domain events
- **Emit domain events:** All session-scoped events (lifecycle changes, backend connection, permissions, slash commands, team diffs) originate from the runtime via `DomainEventBus`
- **Lifecycle state machine:** Maintain explicit `LifecycleState` transitions (starting → awaiting_backend → active → idle → degraded → closing → closed)

**Does NOT do:**
- Contain business logic — delegates to pure functions (`reducer`, `projector`, `normalizer`)
- Know about WebSocket protocols — delegates to `OutboundPublisher`
- Know about adapter specifics — delegates to `BackendConnector`

```
┌──────────────────────────────────────────────────────────────────────┐
│                      SessionRuntime                                  │
│                      (per-session, ~400L)                            │
│                                                                      │
│  ┌─────────────────────── PRIVATE STATE ──────────────────────────┐  │
│  │                                                                │  │
│  │  lifecycle: LifecycleState     (starting|awaiting|active|...)  │  │
│  │  backend: BackendState         (session, abort, passthrough)   │  │
│  │  consumers: ConnectionState    (sockets, identities, rate lim) │  │
│  │  conversation: ConversationState (history, queue, pending)     │  │
│  │  permissions: PermissionState  (pending permissions map)       │  │
│  │  commands: CommandState        (slash registry, caps state)    │  │
│  │  projected: SessionState       (read-only projection)          │  │
│  │                                                                │  │
│  │  ═══════ NO OTHER MODULE CAN WRITE THESE ═══════               │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌─── Entry Points ──────────────────────────────────────────────┐   │
│  │                                                               │   │
│  │  handleInboundCommand(cmd)  ◀── from ConsumerGateway          │   │
│  │  handleBackendMessage(msg)  ◀── from BackendConnector         │   │
│  │  handlePolicyCommand(cmd)   ◀── from Policy services          │   │
│  │  enqueue(commandFn)          ◀── per-session serial executor  │   │
│  │                                                               │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─── Delegates To (never owns logic) ───────────────────────────┐   │
│  │                                                               │   │
│  │  reducer.reduce(state, msg)       → new state      [pure]     │   │
│  │  projector.project*(msg)          → ConsumerMsg    [pure]     │   │
│  │  normalizer.normalize(cmd)        → UnifiedMsg     [pure]     │   │
│  │  slashService.execute(runtime, cmd)                [service]  │   │
│  │  publisher.broadcast(runtime, msg)                 [I/O]      │   │
│  │  repo.persist(snapshot)                            [I/O]      │   │
│  │                                                               │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─── Emits (notifications, never commands) ─────────────────────┐   │
│  │                                                               │   │
│  │  bus.emit(DomainEvent)                                        │   │
│  │  • session:lifecycle_changed                                  │   │
│  │  • backend:session_id                                         │   │
│  │  • session:first_turn                                         │   │
│  │  • capabilities:ready                                         │   │
│  │  • permission:requested / permission:resolved                 │   │
│  │  • slash:executed / slash:failed                              │   │
│  │  • team:* events                                              │   │
│  │                                                               │   │
│  └───────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

**Why this avoids the god object trap:** The switch-case bodies are 3–8 lines each — they call pure functions (`reducer.reduce`, `projector.mapAssistant`, `normalizer.normalize`) and apply the results. The complexity lives in the pure functions, which are independently testable.

**Serialization:** To avoid async interleaving across `await` boundaries, each runtime processes commands through a lightweight per-session serial executor (promise chain).

---

### DomainEventBus

**File:** `src/core/domain-events.ts` (~80 lines)
**Context:** Infrastructure
**Writes state:** No

A flat, typed pub/sub bus. All domain events are emitted exactly once at the source and consumed directly by subscribers — no forwarding chains.

**Responsibilities:**
- **Typed event dispatch:** Single `emit(event)` method accepts the `DomainEvent` union type
- **Typed subscription:** `on(type, handler)` with TypeScript narrowing via `Extract<DomainEvent, { type: T }>`
- **Lifecycle management:** Returns `Disposable` from `on()` for easy cleanup

**Event categories:**
- **Session lifecycle:** created, closed, first_turn, lifecycle_changed
- **Backend:** connected, disconnected, session_id, relaunch_needed
- **Consumer:** connected, disconnected, authenticated
- **Process:** spawned, exited
- **Messages:** inbound (for tracing), outbound (for tracing)
- **Permissions:** requested, resolved
- **Slash commands:** executed, failed
- **Capabilities:** ready, timeout
- **Team:** created, deleted, member:joined/idle/shutdown, task:created/claimed/completed
- **Errors:** error with source + optional sessionId

**Key constraint:** Transport modules (`ConsumerGateway`, `BackendConnector`) do **not** publish `DomainEvent`s directly. They emit commands/signals to `SessionRuntime`, which is the canonical event source for session-scoped events.

---

## Transport Layer

### ConsumerGateway

**File:** `src/core/transport/consumer-gateway.ts` (~200 lines)
**Context:** ConsumerPlane
**Writes state:** No (emits commands to runtime)

The ConsumerGateway handles all WebSocket I/O for consumer connections. **No business logic.** On receiving a valid message, it wraps it as an `InboundCommand` and sends it to the runtime.

**Responsibilities:**
- **Accept connections:** Look up the target `SessionRuntime` by session ID. If not found, reject with 4004. Delegate authentication to `ConsumerGatekeeper`. On success, call `runtime.addConsumer(ws, identity)` (runtime owns the mutation and emits the domain event)
- **Replay state:** After accepting a consumer, tell `OutboundPublisher` to send the full replay (identity, session_init, history, pending permissions, queued message)
- **Validate inbound messages:** Size check (256KB), JSON parse, Zod schema validation, RBAC authorization, rate limiting — all delegated to `ConsumerGatekeeper`
- **Route valid messages:** Wrap the validated message as an `InboundCommand` and call `runtime.handleInboundCommand(cmd)`
- **Handle disconnection:** Call `runtime.removeConsumer(ws)` (runtime owns the mutation)
- **Start/stop:** Wire/unwire the WebSocket server callbacks

**Does NOT do:**
- Parse message semantics (that's the runtime's job)
- Mutate session state
- Broadcast to consumers (that's `OutboundPublisher`)

---

### BackendConnector

**File:** `src/core/transport/backend-connector.ts` (~300 lines)
**Context:** BackendPlane
**Writes state:** No (calls runtime methods that mutate)

The BackendConnector manages adapter lifecycle, the backend message consumption loop, and passthrough interception. It merges responsibilities previously split across multiple modules.

**Responsibilities:**
- **Connect:** Resolve the adapter via `AdapterResolver`, call `adapter.connect()`, hand the resulting `BackendSession` to the runtime via `runtime.setBackendSession()`, and start the consumption loop
- **Disconnect:** Call `runtime.clearBackendSession()` with disconnect reason
- **Consumption loop:** `for await (msg of backendSession.messages)` — for each message, touch activity timestamp, check passthrough interception, then call `runtime.handleBackendMessage(msg)`
- **Passthrough registration + interception (co-located):** When `SlashCommandService` issues a passthrough, `BackendConnector` registers it on the runtime and sends the command as a user message to the backend. During the consumption loop, it intercepts matching responses, buffers text, and emits the `slash_command_result` when complete — skipping the normal runtime routing for those messages
- **Stop adapters:** Call `AdapterResolver.stopAll?.()` for graceful shutdown (prevents orphan adapter-managed processes)
- **Stream end handling:** When the async iterable ends, call `runtime.handleBackendStreamEnd()` to trigger disconnection domain events

**Does NOT do:**
- Own adapter implementation details (that's each `BackendAdapter`)
- Decide what to do with messages (that's the runtime)
- Know about consumer WebSockets

---

### OutboundPublisher

**File:** `src/core/transport/outbound-publisher.ts` (~150 lines)
**Context:** ConsumerPlane
**Writes state:** No (reads state from runtime)

The OutboundPublisher is responsible for pushing `ConsumerMessage` data to WebSocket clients.

**Responsibilities:**
- **Broadcast to all consumers:** Iterate over the runtime's consumer socket map, JSON-serialize the message, and send to each socket with backpressure protection (skip if `bufferedAmount > 1MB`)
- **Broadcast to participants only:** Same as above but skip sockets with `OBSERVER` role (used for permission requests and other participant-only data)
- **Send replay on reconnect:** Send the full state replay to a single newly-connected socket — identity message, session_init, conversation history, pending permissions, queued message
- **Presence updates:** Broadcast presence_update when consumers connect/disconnect
- **Session name updates:** Broadcast session_name_update when auto-naming completes

---

## Services

### SlashCommandService

**File:** `src/core/services/slash-command-service.ts` (~200 lines)
**Context:** MessagePlane
**Writes state:** No (calls runtime/connector methods)

The SlashCommandService provides a single `execute()` entrypoint for all slash command handling with a chain-of-responsibility strategy pattern.

**Responsibilities:**
- **Single entrypoint:** `execute(runtime, cmd)` — resolves the strategy and executes
- **Strategy 1 — Local:** Built-in commands like `/help`. Generates the result locally, broadcasts via `OutboundPublisher`, records success on the runtime
- **Strategy 2 — Adapter-native:** If the adapter has its own `AdapterSlashExecutor` that handles the command, delegate to it. Broadcast the result and record success
- **Strategy 3 — Passthrough:** If the adapter supports passthrough, delegate to `BackendConnector.registerPassthrough()` which sends the command as a user message and intercepts the response
- **Strategy 4 — Unsupported:** Broadcast an error message and record failure

**Key design:** Registration and interception are co-located in `BackendConnector`, not split across modules. `SlashCommandService` only decides the strategy and delegates.

---

### ConsumerProjector

**File:** `src/core/services/consumer-projector.ts` (~150 lines)
**Context:** MessagePlane
**Writes state:** No (pure)

The ConsumerProjector wraps the existing `ConsumerMessageMapper` (T4 boundary) with dedup and history-worthiness logic.

**Responsibilities:**
- **Project assistant messages:** Map via `ConsumerMessageMapper.mapAssistantMessage()`, then check for duplicates against the conversation history. Return `null` if duplicate (runtime skips broadcasting)
- **Project result messages:** Map via `ConsumerMessageMapper.mapResultMessage()`
- **Project stream events:** Map via `ConsumerMessageMapper.mapStreamEvent()`
- **Project status changes:** Map via `ConsumerMessageMapper.mapStatusChange()`, preserving metadata passthrough for step/retry/plan fields
- **One method per message type,** all pure — no side effects, no transport knowledge

The runtime calls these and applies the results:
```
const consumerMsg = projector.projectAssistant(msg, history)
if (!consumerMsg) return              // dedup — pure function decided to skip
history.push(consumerMsg)             // mutation — only runtime does this
publisher.broadcast(runtime, msg)     // side effect — only runtime triggers this
repo.persist(runtime.snapshot())      // persistence — only runtime triggers this
```

---

## Policy Services

Policy services follow the **observe and advise** pattern: they subscribe to domain events or periodically scan state, and when conditions are met, they emit `PolicyCommand`s to the runtime. **They never mutate state directly.**

### ReconnectPolicy

**File:** `src/core/policy/reconnect-policy.ts` (~60 lines)
**Context:** SessionControl

**Responsibility:** Watch for sessions stuck in `awaiting_backend` state. If a session remains in that state beyond the configured timeout, emit a `reconnect_timeout` PolicyCommand to the runtime.

**Behavior:**
- Subscribes to `session:lifecycle_changed` events on the `DomainEventBus`
- When a session transitions to `awaiting_backend`, starts a watchdog timer
- When the session leaves `awaiting_backend`, clears the timer
- On timeout, looks up the runtime and calls `runtime.handlePolicyCommand({ type: "reconnect_timeout" })`

### IdlePolicy

**File:** `src/core/policy/idle-policy.ts` (~80 lines)
**Context:** SessionControl

**Responsibility:** Periodically sweep all runtimes and identify sessions that are idle (no consumers, no backend, last activity exceeded timeout). Emit `idle_reap` PolicyCommand.

**Behavior:**
- Runs a periodic scan (every 60 seconds)
- For each runtime: check `consumerCount === 0`, `isBackendConnected === false`, and `Date.now() - lastActivity > idleTimeoutMs`
- If all conditions met, call `runtime.handlePolicyCommand({ type: "idle_reap" })`

### CapabilitiesPolicy

**File:** `src/core/policy/capabilities-policy.ts` (~80 lines)
**Context:** SessionControl

**Responsibility:** Ensure the capabilities handshake completes within a timeout after backend connection. If it doesn't, emit `capabilities_timeout` PolicyCommand.

**Behavior:**
- Subscribes to `backend:connected` — starts a timer for the session
- Subscribes to `capabilities:ready` — clears the timer
- On timeout, calls `runtime.handlePolicyCommand({ type: "capabilities_timeout" })`
- The runtime decides whether to emit a `capabilities:timeout` domain event and/or apply default capabilities

---

## Persistence

### SessionRepository

**File:** `src/core/persistence/session-repository.ts` (~200 lines)
**Context:** SessionControl
**Writes state:** No (reads snapshots)

The SessionRepository persists and restores **snapshots** — immutable point-in-time copies of session state. It never holds references to live mutable state.

**Responsibilities:**
- **Persist snapshots:** Accept a `SessionSnapshot` (copied from the runtime) and write it to storage. Backed by `FileStorage` with debounced writes and schema versioning
- **Remove sessions:** Delete persisted state for a given session ID
- **Restore all:** On startup, read all persisted snapshots and return them as `RestoredSession[]` for the coordinator to rebuild runtimes

**Snapshot structure:**
```typescript
interface SessionSnapshot {
  id: string
  state: SessionState
  history: readonly ConsumerMessage[]
  pendingMessages: readonly UnifiedMessage[]
  pendingPermissions: readonly [string, PermissionRequest][]
  adapterName?: string
  backendSessionId?: string
}
```

---

## Pure Functions

These modules are stateless, have no side effects, and contain no transport knowledge. They are independently testable and form the leaves of the dependency graph.

| Module | Boundary | Responsibility |
|--------|----------|----------------|
| **InboundNormalizer** | T1 | Transforms `InboundCommand` → `UnifiedMessage`. Validates and normalizes consumer input into the canonical internal format |
| **SessionStateReducer** | — | Pure state reduction: `(SessionState, UnifiedMessage) → SessionState`. Handles all state transitions from backend messages (model changes, tool state, team state, circuit breaker, etc.) |
| **ConsumerMessageMapper** | T4 | Transforms `UnifiedMessage` → `ConsumerMessage`. Maps the internal format to the consumer-facing protocol (30+ subtypes). Handles metadata passthrough and null/undefined filtering |
| **ConsumerGatekeeper** | — | Auth + RBAC + rate limiting. Validates consumer connections and messages. Pluggable `Authenticator` interface for different auth strategies |
| **GitInfoTracker** | — | Resolves git branch/repo info for a working directory. Called by runtime on `session_init` and `result` events to keep git state current |
| **TeamToolCorrelationBuffer** | — | Per-session buffer that correlates tool results to team members. Owned by the runtime instance |
| **MessageTracer** | — | Debug tracing at T1/T2/T3/T4 boundaries. Cross-cutting concern injected into the runtime |

---

## Command and Event Flow

### Commands vs Domain Events

The system explicitly separates "please do X" (commands) from "X happened" (domain events):

```
  ┌──────────────────┐
  │ Commands flow IN │     Commands = requests to change state
  └────────┬─────────┘
           │
           │  InboundCommand (from ConsumerGateway)
           │  ┌─ user_message
           │  ├─ permission_response
           │  ├─ slash_command
           │  ├─ interrupt / set_model / set_permission_mode
           │  └─ queue_message / cancel / update
           │
           │  BackendEvent (from BackendConnector)
           │  ┌─ backend:message (UnifiedMessage stream)
           │  ├─ backend:connected
           │  └─ backend:disconnected
           │
           │  PolicyCommand (from Policy services)
           │  ┌─ reconnect_timeout
           │  ├─ idle_reap
           │  └─ capabilities_timeout
           │
           ▼
    ┌──────────────┐
    │SessionRuntime│
    │ (sole writer)│
    └──────┬───────┘
           │
           │  DomainEvent (notifications of what happened)
           │  ┌─ session:created / session:closed (from SessionCoordinator)
           │  ├─ session:lifecycle_changed (from, to)
           │  ├─ session:first_turn
           │  ├─ backend:connected / disconnected / session_id
           │  ├─ consumer:connected / disconnected / authenticated
           │  ├─ message:inbound / message:outbound
           │  ├─ permission:requested / resolved
           │  ├─ slash:executed / failed
           │  ├─ capabilities:ready / timeout
           │  ├─ team:* events
           │  └─ error
           │
           ▼
  ┌───────────────────┐
  │ Events flow OUT   │     Events = facts about what changed
  └───────────────────┘
           │
    ┌──────┼──────────────────────────┐
    ▼      ▼                          ▼
 ┌──────┐ ┌─────────────────┐  ┌────────────┐
 │Coord.│ │ProcessSupervisor│  │  Policies  │
 │(auto-│ │(cleanup on      │  │(start/stop │
 │name, │ │ disconnect)     │  │ watchdogs) │
 │relaun│ └─────────────────┘  └────────────┘
 │ch)   │
 └──────┘
```

---

### DomainEventBus — Flat Pub/Sub

```
 Publishers                     DomainEventBus                    Subscribers
 ══════════                    ══════════════                     ═════════════

 SessionRuntime ──────┐    ┌─────────────────────┐    ┌── SessionCoordinator
   session:lifecycle  │    │                     │    │     (relaunch, auto-name)
   session:first_turn │    │   Flat typed bus    │    │
   backend:*          │    │                     │    ├── ReconnectPolicy
   consumer:*         │    │  • emit(event)      │    │
   permission:*       ├───▶│  • on(type, fn)     │◀───┤── IdlePolicy
   slash:*            │    │                     │    │
   team:*             │    │  ONE HOP — no       │    ├── CapabilitiesPolicy
   message:*          │    │  forwarding chain   │    │
                      │    │                     │    ├── HTTP API / Metrics
 SessionCoordinator ──┤    │  Adding new event:  │    │
   session:created    │    │  1. Add to union    │    ├── MessageTracer
   session:closed     ├───▶│  2. emit() at site  │◀───┤
                      │    │  3. on() at site    │    └── ProcessSupervisor
 ProcessSupervisor ───┤    │                     │         (process telemetry)
   process:*          ├───▶│  (transport modules │
                      │    │   DO NOT publish    │
                      └───▶│   DomainEvents)     │
                           └─────────────────────┘

  NOTE:
  - ConsumerGateway and BackendConnector emit commands/signals to SessionRuntime.
  - They do not emit DomainEvents directly.
```

---

### Inbound Data Flow

Consumer → Backend:

```
  Browser/Phone
       │
       │ WebSocket connect
       ▼
┌──────────────────────────────────────────────────────────────────┐
│                      ConsumerGateway                             │
│                    (transport only — no business logic)          │
│                                                                  │
│  handleConnection(ws, ctx)                                       │
│    │                                                             │
│    ├── coordinator.getRuntime(sessionId)                         │
│    │     └─ not found? → ws.close(4004)                          │
│    │                                                             │
│    ├── gatekeeper.authenticate(ws, ctx)                          │
│    │     └─ failed? → ws.close(4001)                             │
│    │                                                             │
│    ├── runtime.addConsumer(ws, identity)  ← runtime mutates      │
│    │                                                             │
│    ├── publisher.sendReplayTo(ws, runtime)                       │
│    │     └─ identity, session_init, history, perms, queued       │
│    │                                                             │
│    └── (runtime emits consumer:connected DomainEvent)            │
│                                                                  │
│  handleMessage(ws, sessionId, data)                              │
│    │                                                             │
│    ├── size check (256KB)                                        │
│    ├── JSON.parse                                                │
│    ├── Zod validate                                              │
│    ├── gatekeeper.authorize (RBAC)                               │
│    ├── gatekeeper.rateLimit                                      │
│    │                                                             │
│    └── runtime.handleInboundCommand(cmd)  ← COMMAND, not event   │
└──────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                  SessionRuntime.handleInboundCommand             │
│                                                                  │
│  switch (cmd.type):                                              │
│    │                                                             │
│    ├─ user_message ────────────▶ ┌───────────────────────────┐   │
│    │                             │ 1. echoMsg = toEcho(cmd)  │   │
│    │                             │ 2. history.push(echoMsg)  │   │
│    │                             │ 3. publisher.broadcast()  │   │
│    │                             │ 4. unified = normalize(T1)│   │
│    │                             │ 5. backend.send(unified)  │──▶│──▶ Backend
│    │                             │    or pendingMsgs.push()  │   │
│    │                             │ 6. repo.persist(snapshot) │   │
│    │                             └───────────────────────────┘   │
│    │                                                             │
│    ├─ permission_response ─────▶ validate → backend.send() ─────▶│──▶ Backend
│    │                                                             │
│    ├─ slash_command ───────────▶ slashService.execute(this, cmd) │
│    │                              │                              │
│    │                              ├─ Local ─────▶ emit result    │
│    │                              ├─ Native ────▶ adapter exec   │
│    │                              ├─ Passthrough▶ connector      │
│    │                              │               .registerPass  │
│    │                              │               through() ─────│──▶ Backend
│    │                              └─ Reject ────▶ emit error     │
│    │                                                             │
│    ├─ interrupt ──────────────▶ normalize(T1) → send ────────────│──▶ Backend
│    ├─ set_model ──────────────▶ normalize(T1) → send ────────────│──▶ Backend
│    │                                                             │
│    ├─ queue_message ──────────▶ set queuedMessage                │
│    ├─ cancel_queued_message ──▶ clear queuedMessage              │
│    └─ update_queued_message ──▶ update queuedMessage             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

### Outbound Data Flow

Backend → Consumers:

```
  Backend (Claude CLI / Codex / ACP)
       │
       │ async iterable: UnifiedMessage
       ▼
┌──────────────────────────────────────────────────────────────────┐
│                      BackendConnector                            │
│                                                                  │
│  startConsumptionLoop(runtime, backendSession)                   │
│    │                                                             │
│    │  for await (msg of backendSession.messages):                │
│    │    │                                                        │
│    │    ├── runtime.touchActivity()                              │
│    │    │                                                        │
│    │    ├── interceptPassthrough(runtime, msg)?                  │
│    │    │     │                                                  │
│    │    │     ├─ YES ──▶ buffer text, emit slash_command_result  │
│    │    │     │          when complete, skip runtime             │
│    │    │     │                                                  │
│    │    │     └─ NO ───▶ continue to runtime                     │
│    │    │                                                        │
│    │    ▼                                                        │
│    │  runtime.handleBackendMessage(msg) ──────────────┐          │
│    │                                                  │          │
│    │  [stream ends]                                   │          │
│    │    └── runtime.handleBackendStreamEnd()          │          │
└───────────────────────────────────────────────────────┼──────────┘
                                                        │
                                                        ▼
┌──────────────────────────────────────────────────────────────────┐
│                SessionRuntime.handleBackendMessage               │
│                                                                  │
│  ┌──────────────────────────────────────┐                        │
│  │ 1. REDUCE STATE (pure)               │                        │
│  │    projected = reducer.reduce(       │                        │
│  │      projected, msg, corrBuffer)     │                        │
│  └──────────────────────────────────────┘                        │
│                                                                  │
│  ┌──────────────────────────────────────┐                        │
│  │ 2. UPDATE LIFECYCLE                  │                        │
│  │    e.g., session_init → "active"     │                        │
│  │         result → "idle"              │                        │
│  └──────────────────────────────────────┘                        │
│                                                                  │
│  ┌──────────────────────────────────────┐                        │
│  │ 3. DISPATCH (each handler is 3-8L)   │                        │
│  └──────────────────────────────────────┘                        │
│                                                                  │
│  ├─ session_init ──────────▶ store backendSessionId              │
│  │                           populate slash registry             │
│  │                           caps handshake → bus.emit           │
│  │                           project + broadcast                 │
│  │                                                               │
│  ├─ assistant ────────────▶ ┌────────────────────────────┐       │
│  │                          │ consumerMsg =              │       │
│  │                          │   projector.project*(msg)  │ pure  │
│  │                          │ if duplicate: return       │       │
│  │                          │ history.push(consumerMsg)  │ mut   │
│  │                          │ publisher.broadcast()    ──┤───────┤──▶ Consumers
│  │                          │ repo.persist(snapshot)     │ I/O   │
│  │                          └────────────────────────────┘       │
│  │                                                               │
│  ├─ result ───────────────▶ project + history + broadcast        │
│  │                          lastStatus = "idle"                  │
│  │                          drainQueue() if queued               │
│  │                          bus.emit(first_turn) if first        │
│  │                                                               │
│  ├─ stream_event ─────────▶ project + broadcast                  │
│  ├─ status_change ────────▶ update lastStatus + broadcast        │
│  │                          (with metadata passthrough)          │
│  ├─ permission_request ───▶ store pending + broadcast            │
│  │                          (participants only)                  │
│  ├─ tool_progress ────────▶ project + broadcast                  │
│  ├─ tool_use_summary ─────▶ project + dedup + broadcast          │
│  ├─ auth_status ──────────▶ project + broadcast                  │
│  ├─ configuration_change ─▶ project + broadcast + patch          │
│  ├─ session_lifecycle ────▶ project + broadcast                  │
│  ├─ control_response ─────▶ runtime capability handler           │
│  │                           emits capabilities:ready if applied │
│  └─ default ──────────────▶ trace + silently consume             │
│                                                                  │
│  ┌──────────────────────────────────────┐                        │
│  │ 4. EMIT TEAM DIFFS                   │                        │
│  │    diff prev vs new team state       │                        │
│  │    bus.emit("team:member:joined")    │                        │
│  └──────────────────────────────────────┘                        │
└──────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────────────────┐
│                     OutboundPublisher                            │
│                                                                  │
│  broadcast(runtime, msg)                                         │
│    for each ws in runtime.consumers:                             │
│      if ws.bufferedAmount > 1MB: skip (backpressure)             │
│      ws.send(JSON.stringify(msg))                                │
│                                                                  │
│  broadcastToParticipants(runtime, msg)                           │
│    same but skip observer role                                   │
│                                                                  │
│  sendReplayTo(ws, runtime)  — full state replay on reconnect     │
│  broadcastPresence(...)     — presence_update                    │
│  broadcastNameUpdate(...)   — session_name_update                │
└──────────────────────────────────────────────────────────────────┘
                    │
                    ▼
              All consumer
              WebSockets
```

---

### Translation Boundaries

The system has four named translation boundaries (T1–T4) that are pure mapping functions:

```
Inbound path:
  ConsumerGateway
    └─ SessionRuntime.handleInboundCommand()
         └─ InboundNormalizer.normalize(...)                  [T1]
             InboundCommand -> UnifiedMessage

Backend path:
  SessionRuntime.sendToBackend(unified)
    └─ Adapter session outbound translator                    [T2]
       UnifiedMessage -> backend-native payload

  Adapter session inbound translator                          [T3]
    backend-native payload -> UnifiedMessage
    └─ BackendConnector -> SessionRuntime.handleBackendMessage(...)

Outbound path:
  SessionRuntime.handleBackendMessage(unified)
    └─ ConsumerProjector / ConsumerMessageMapper              [T4]
       UnifiedMessage -> ConsumerMessage
```

---

## Session Lifecycle State Machine

Each session has an explicit `LifecycleState` — no implicit status inference:

```typescript
type LifecycleState =
  | "starting"          // Session created, process spawning (inverted) or connecting (direct)
  | "awaiting_backend"  // Process spawned, waiting for CLI to connect back
  | "active"            // Backend connected, processing messages
  | "idle"              // Backend connected, waiting for user input (result received)
  | "degraded"          // Backend disconnected unexpectedly, awaiting relaunch
  | "closing"           // Shutdown initiated, draining
  | "closed"            // Terminal state, ready for removal
```

```
                    createSession()
                         │
                         ▼
                   ┌───────────┐
                   │  starting │
                   └─────┬─────┘
                         │
              ┌──────────┴──────────┐
              │                     │
        (inverted)              (direct)
              │                     │
              ▼                     │
     ProcessSupervisor              │
        .spawn()                    │
              │                     │
              ▼                     │
     ┌──────────────────┐           │
     │ awaiting_backend │           │
     │ (waiting for CLI │           │
     │  to call back on │           │
     │  /ws/cli/:id)    │           │
     └──────┬───────────┘           │
            │                       │
            │ CLI connects          │ adapter.connect()
            │                       │
            └──────────┬────────────┘
                       │
                       ▼
                 ┌───────────┐
           ┌────▶│  active   │◀─── user_message received
           │     └────┬──────┘
           │          │
           │     result received
           │          │
           │          ▼
           │     ┌───────────┐
           │     │   idle    │──── user_message ───▶ active
           │     └────┬──────┘
           │          │
           │     backend disconnects
           │     unexpectedly
           │          │
           │          ▼
           │    ┌───────────┐
           │    │ degraded  │── relaunch succeeds ──┐
           │    └─────┬─────┘                       │
           │          │                             │
           │     relaunch fails / idle_reap         │
           │          │                             │
           │          ▼                             │
           │    ┌───────────┐                       │
           │    │  closing  │                       │
           │    └─────┬─────┘                       │
           │          │                             │
           │          ▼                             │
           │    ┌───────────┐                       │
           └────│  closed   │◀──────────────────────┘
                └───────────┘    (if session removed)


  Policies react to lifecycle transitions:
  ┌──────────────────────────────────────────────────────────────┐
  │ ReconnectPolicy:  awaiting_backend → start watchdog timer    │
  │ IdlePolicy:       idle + no consumers → start reap timer     │
  │ CapabilitiesPolicy: active → start capabilities timeout      │
  └──────────────────────────────────────────────────────────────┘

  Consumer connections are orthogonal — attach/detach at any lifecycle state:
  ┌──────────┐     addConsumer()      ┌───────────┐
  │ Consumer │ ────────────────────▶  │  Attached │
  │  (idle)  │                        │  (in map) │
  └──────────┘     removeConsumer()   └───────────┘
        ▲     ◀──────────────────────       │
        └───────────────────────────────────┘
```

The state machine enables:
- **Guard clauses:** `handleInboundCommand` rejects commands in `closing`/`closed`
- **Policy triggers:** `ReconnectPolicy` watches for `awaiting_backend`, `IdlePolicy` watches for `idle`
- **Testability:** State transitions are explicit and can be unit-tested

---

## Backend Adapters

All adapters implement the `BackendAdapter` + `BackendSession` interfaces — a clean async iterable contract.

```
┌──────────────────────────────────────────────────────────────────────┐
│  BackendAdapter interface                                            │
│  name: string                                                        │
│  capabilities: BackendCapabilities                                   │
│  connect(options): Promise<BackendSession>                           │
│  stop?(): Promise<void>                   — graceful adapter teardown│
├──────────────────────────────────────────────────────────────────────┤
│  BackendSession interface                                            │
│  sessionId: string                                                   │
│  send(msg: UnifiedMessage): void                                     │
│  messages: AsyncIterable<UnifiedMessage>                             │
│  close(): Promise<void>                                              │
├──────────────────────────────────────────────────────────────────────┤
│  COMPOSED EXTENSIONS (additive, not baked in)                        │
│  Interruptible:     interrupt(): void                                │
│  Configurable:      setModel(), setPermissionMode()                  │
│  PermissionHandler: request/response bridging                        │
│  Reconnectable:     onDisconnect(), replay()                         │
│  Encryptable:       encrypt(), decrypt()                             │
└──────────────────────────────────────────────────────────────────────┘
```

| Adapter | Protocol | Backend | Notes |
|---------|----------|---------|-------|
| **Claude** | NDJSON/WS `--sdk` | Claude Code CLI (child process) | Streaming, permissions, teams |
| **ACP** | JSON-RPC/stdio | Goose, Kiro, Gemini (ACP mode) | Agent Client Protocol |
| **Codex** | JSON-RPC/WS | Codex CLI (OpenAI) | Thread/Turn/Item model, app-server |
| **Gemini** | Wraps ACP | Gemini CLI | Spawns `gemini --experimental-acp` |
| **OpenCode** | REST+SSE | opencode | Demuxed sessions |

**UnifiedMessage** is the canonical internal envelope:
```
╔════════════════════════════════════════════════════════════╗
║                    UnifiedMessage                          ║
║  id, timestamp, type, role, content[], metadata            ║
║  Supports: streaming (Claude), request/response (ACP),     ║
║  JSON-RPC (Codex/OpenCode)                                 ║
║  + metadata escape hatch for adapter-specific data         ║
║  + parentId for threading support                          ║
╚════════════════════════════════════════════════════════════╝
```

**State hierarchy:**
```
CoreSessionState → DevToolSessionState → SessionState
(adapter-agnostic)  (git branch, repo)   (model, tools,
                                          team, circuit
                                          breaker, ...)
```

---

## React Consumer

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

## Daemon

```
┌───────────────────────────────────────────────────────────────────────┐
│  DAEMON                                                               │
│  ┌───────────┐ ┌───────────┐ ┌──────────┐ ┌────────────────────┐      │
│  │ Lock File │ │ State     │ │ Health   │ │ Control API        │      │
│  │ O_CREAT|  │ │ File      │ │ Check    │ │ HTTP 127.0.0.1:0   │      │
│  │ O_EXCL    │ │ PID, port │ │ 60s loop │ │                    │      │
│  │           │ │ heartbeat │ │          │ │ • list sessions    │      │
│  │           │ │ version   │ │          │ │ • create session   │      │
│  │           │ │           │ │          │ │ • stop session     │      │
│  │           │ │           │ │          │ │ • revoke-device    │      │
│  └───────────┘ └───────────┘ └──────────┘ └────────────────────┘      │
│  ┌───────────────────────────┐ ┌────────────────────────────────┐     │
│  │ ChildProcessSupervisor    │ │ SignalHandler                  │     │
│  │ spawns/tracks beamcode    │ │ SIGTERM/SIGINT graceful stop   │     │
│  │ server child processes    │ │                                │     │
│  └───────────────────────────┘ └────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Security Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     SECURITY LAYERS                              │
│                                                                  │
│  LAYER 1: Transport                                              │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • WebSocket origin validation (reject untrusted origins)   │  │
│  │ • CLI auth tokens (?token=SECRET per session)              │  │
│  │ • ConsumerGatekeeper: pluggable Authenticator interface    │  │
│  │ • ApiKeyAuthenticator: header-based auth                   │  │
│  │ • RBAC: PARTICIPANT vs OBSERVER role-based message filter  │  │
│  │ • Per-consumer rate limiting: token-bucket                 │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 2: E2E Encryption                                         │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • libsodium sealed boxes (XSalsa20-Poly1305)               │  │
│  │ • sodium_malloc for key material (mlock'd, not swappable)  │  │
│  │ • Per-message ephemeral keys (limited forward secrecy)     │  │
│  │ • Relay MUST NOT persist encrypted blobs (stateless only)  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 3: Authentication                                         │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • Permission signing: HMAC-SHA256(secret,                  │  │
│  │     request_id + behavior + timestamp + nonce)             │  │
│  │ • Anti-replay: nonce set (last 1000), 30s timestamp window │  │
│  │ • One-response-per-request (pendingPermissions.delete)     │  │
│  │ • Secret established locally (daemon→CLI, never over relay)│  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 4: Device Management                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • Session revocation: revoke-device → new keypair → re-pair│  │
│  │ • Pairing link expires in 60 seconds                       │  │
│  │ • Single device per pairing cycle                          │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LAYER 5: Resilience                                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ • SlidingWindowBreaker: circuit breaker with snapshot API  │  │
│  │ • Structured error types (BeamCodeError hierarchy)         │  │
│  │ • Secret redaction in process output forwarding            │  │
│  │ • Watchdog timers for reconnect grace periods              │  │
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

## Cross-Cutting Infrastructure

| Module | Responsibility |
|--------|----------------|
| **BeamCodeError** | Structured error hierarchy (StorageError, ProcessError, etc.) |
| **FileStorage** | Debounced file writes with schema versioning |
| **StateMigrator** | Schema version migration chain (v0 → v1+) |
| **StructuredLogger** | JSON-line logging with component context and level filtering |
| **SlidingWindowBreaker** | Circuit breaker with snapshot API for UI visibility |
| **ProcessManager** | Spawn, kill, isAlive — signal handling |
| **AdapterResolver** | Resolves adapter by name, factory for all adapters |
| **TokenBucketLimiter** | Per-consumer rate limiting |
| **ConsoleMetricsCollector** | Metrics collection → console output |
| **SessionOperationalHandler** | Privileged operations (list/close/archive sessions) |

---

## Module Dependency Graph

```
                    SessionCoordinator (~400L)
                   ╱    │        │         ╲
                  ╱     │        │          ╲
                 ╱      │        │           ╲
                ▼       ▼        ▼            ▼
  ┌──────────────┐ ┌─────┐ ┌──────────────┐ ┌───────────────┐
  │ coordinator/ │ │Domai│ │ SessionBridge│ │   Process     │
  │ •EventRelay │ │n    │ │  (~720L)     │ │   Supervisor  │
  │ •Recovery   │ │Event│ │              │ │   (existing   │
  │ •LogService │ │Bus  │ └──────┬───────┘ │    launcher)  │
  │ •Restore    │ │(~80)│        │         └───────────────┘
  └──────────────┘ └──┬──┘       │
                      │     ┌────┴──────────────────────────┐
                      │     │      │         │              │
                      │     ▼      ▼         ▼              ▼
                      │ ┌────────┐┌───────┐┌─────────┐┌──────────┐
                      │ │Runtime ││Consum.││ Backend ││ Consumer │
                      │ │Manager ││Gatewey││Connector││Broadcast.│
                      │ │(bridge/│└───┬───┘└────┬────┘└──────────┘
                      │ └───┬────┘    │         │
                      │     │    Gatekeeper     │
                      │     │    (~140L)   AdapterResolver
       ┌──────────────┤     │
       │              │     ▼
       ▼              ▼ ┌──────────────┐       ┌────────────┐
  ┌────────────┐        │SessionRuntime│       │  Policies  │
  │ Policies   │        │  (~400L)     │       │ •Reconnect │
  │ •Reconnect │        │              │       │ •Idle      │
  │ •Idle      │        │  SOLE OWNER  │       │ •Caps      │
  │ •Caps      │        │  of state    │       │ (~220L)    │
  └────────────┘        └──────┬───────┘       └────────────┘
                               │
                          delegates to
                               │
                    ┌────┬─────┴──────────┐
                    ▼    ▼                ▼
              ┌──────┐┌──────┐     ┌──────────┐
              │Slash ││Outb. │     │Pure Fns  │
              │Cmd   ││Publ. │     │•Normaliz.│
              │Svc   ││(~150)│     │•Reducer  │
              │(~200)││      │     │•Projector│
              └──────┘└──────┘     └──────────┘

  No cycles. Pure functions at leaves.
  Runtime delegates to pure fns + services.
  Transport modules emit commands to runtime.
  Policies observe and advise.
  coordinator/ services handle cross-session concerns.
  bridge/ owns the runtime map.
```

---

## File Layout

```
src/core/
├── session-coordinator.ts        — top-level facade + lifecycle (~400L)
├── session-bridge.ts             — wires four bounded contexts (~720L)
├── session-runtime.ts            — per-session state owner (~400L)
├── domain-events.ts              — DomainEvent union + DomainEventBus (~80L)
├── commands.ts                   — InboundCommand, BackendEvent, PolicyCommand types
├── lifecycle-state.ts            — LifecycleState enum + transition validator
│
├── bridge/
│   └── runtime-manager.ts        — owns runtime map, lifecycle signal routing
│
├── coordinator/
│   ├── coordinator-event-relay.ts    — bridge+launcher event wiring
│   ├── process-log-service.ts        — stdout/stderr buffering + secret redaction
│   ├── backend-recovery-service.ts   — timer-guarded relaunch dedup
│   └── startup-restore-service.ts    — ordered restore (launcher→registry→bridge)
│
├── transport/
│   ├── consumer-gateway.ts       — WS accept/reject/message, emits commands (~200L)
│   ├── backend-connector.ts      — adapter lifecycle + consumption + passthrough (~300L)
│   └── outbound-publisher.ts     — broadcast + replay + presence (~150L)
│
├── services/
│   ├── slash-command-service.ts  — one execute() entrypoint (~200L)
│   └── consumer-projector.ts     — wraps T4 mapper + dedup logic (~150L)
│
├── policy/
│   ├── reconnect-policy.ts       — observe + advise (~60L)
│   ├── idle-policy.ts            — observe + advise (~80L)
│   └── capabilities-policy.ts    — observe + advise (~80L)
│
├── persistence/
│   └── session-repository.ts     — snapshot persistence (~200L)
│
├── consumer-gatekeeper.ts        — auth + RBAC + rate limiting (~139L)
├── session-state-reducer.ts      — pure reducer (~256L)
├── consumer-message-mapper.ts    — pure T4 mapper (~345L)
├── inbound-normalizer.ts         — pure T1 mapper (~125L)
├── git-info-tracker.ts           — git resolution (~83L)
├── message-tracer.ts             — debug tracing (~632L)
├── team-tool-correlation.ts      — team tool pairing
│
└── interfaces/
    ├── backend-adapter.ts        — BackendAdapter + BackendSession interfaces
    ├── adapter-resolver.ts       — adapter lookup
    ├── domain-events.ts          — DomainEvent type, DomainEventBus interface
    └── commands.ts               — InboundCommand, PolicyCommand types

src/adapters/
├── claude/                       — Claude Code CLI (NDJSON/WS, streaming, teams)
├── acp/                          — Agent Client Protocol (JSON-RPC/stdio)
├── codex/                        — Codex (JSON-RPC/WS, Thread/Turn/Item)
├── gemini/                       — Gemini CLI (wraps ACP adapter)
├── opencode/                     — OpenCode (REST+SSE, demuxed sessions)
├── adapter-resolver.ts           — Resolves adapter by name
├── create-adapter.ts             — Factory for all adapters
├── file-storage.ts               — SessionStorage impl (debounced + migrator)
├── state-migrator.ts             — Schema versioning, migration chain
├── structured-logger.ts          — JSON-line logging
├── sliding-window-breaker.ts     — Circuit breaker
└── ...                           — other infrastructure adapters

src/daemon/                       — Process supervisor + daemon lifecycle
src/relay/                        — Encryption + tunnel management
src/http/                         — HTTP request routing
src/server/                       — WebSocket layer
src/types/                        — Shared type definitions
src/interfaces/                   — Runtime contracts
src/utils/                        — Utilities (crypto, NDJSON, etc.)

web/                              — React 19 consumer (separate Vite build)
shared/                           — Flattened types for frontend (NO core/ imports)
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
│  DomainEventBus         → emit(event), on(type, handler): Disposable │
│  SessionRepository      → persist(snapshot), remove(id), restoreAll()│
└──────────────────────────────────────────────────────────────────────┘
```
