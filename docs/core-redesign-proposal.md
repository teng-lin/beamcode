# Core Module Redesign Proposal

> Date: 2026-02-20
> Status: Draft v2 — merged design (Claude Opus + Codex review), synced to `119104b`
> Scope: `src/core/` — SessionManager, SessionBridge, and all extracted specialists

## Table of Contents

- [Executive Summary](#executive-summary)
- [Current Architecture](#current-architecture)
  - [Module Inventory](#module-inventory)
  - [Data Flow](#data-flow)
  - [What's Already Good](#whats-already-good)
- [Diagnosis: Five Structural Problems](#diagnosis-five-structural-problems)
  - [1. The Session God Struct](#1-the-session-god-struct)
  - [2. SessionManager + SessionBridge Artificial Split](#2-sessionmanager--sessionbridge-artificial-split)
  - [3. Three-Hop Event Forwarding](#3-three-hop-event-forwarding)
  - [4. Callback Spaghetti for Wiring](#4-callback-spaghetti-for-wiring)
  - [5. Dual Session Registry](#5-dual-session-registry)
- [Proposed Architecture](#proposed-architecture)
  - [Core Invariant](#core-invariant)
  - [Four Bounded Contexts](#four-bounded-contexts)
  - [Design Rules](#design-rules)
  - [Overview Diagram](#overview-diagram)
- [Design Decisions](#design-decisions)
  - [1. SessionRuntime — Per-Session State Owner](#1-sessionruntime--per-session-state-owner)
  - [2. Commands vs Domain Events](#2-commands-vs-domain-events)
  - [3. SessionCoordinator — Global Lifecycle Only](#3-sessioncoordinator--global-lifecycle-only)
  - [4. ConsumerGateway — Transport Only](#4-consumergateway--transport-only)
  - [5. BackendConnector — Adapter Abstraction + Passthrough](#5-backendconnector--adapter-abstraction--passthrough)
  - [6. MessageRouter — Pure Translation + Reduction](#6-messagerouter--pure-translation--reduction)
  - [7. SlashCommandService — One Interface](#7-slashcommandservice--one-interface)
  - [8. Policy Services — Observe and Advise](#8-policy-services--observe-and-advise)
  - [9. SessionRepository — Snapshots Not Live Objects](#9-sessionrepository--snapshots-not-live-objects)
  - [10. Explicit Lifecycle State Machine](#10-explicit-lifecycle-state-machine)
- [Target Module Responsibilities](#target-module-responsibilities)
- [Module Dependency Graph](#module-dependency-graph)
- [Summary of Changes](#summary-of-changes)
- [Migration Strategy](#migration-strategy)

---

## Executive Summary

BeamCode's core is a **message broker** — it routes messages between remote consumers
(browser/phone via WebSocket) and local AI coding backends (Claude CLI, Codex, ACP) with
session-scoped state. The current design grew organically through progressive extraction from
a monolithic `SessionBridge`, producing a workable but structurally tangled system.

This proposal identifies five structural problems and presents a redesign built around
a **per-session runtime actor** that is the sole owner of mutable state, with four bounded
contexts (SessionControl, BackendPlane, ConsumerPlane, MessagePlane) and explicit
command/event separation.

> **Core invariant: Only `SessionRuntime` can mutate session state.
> Transport modules emit commands. Pure functions transform data.
> Policy services observe and advise — they never mutate.**

---

## Current Architecture

### Module Inventory

| Module | File | Lines | Responsibility |
|--------|------|-------|---------------|
| **SessionManager** | `session-manager.ts` | 547 | Top-level facade. Wraps SessionBridge + ClaudeLauncher. Event forwarding, process lifecycle hooks, auto-naming, relaunch dedup. |
| **SessionBridge** | `session-bridge.ts` | 742 | Central coordinator. Owns SessionStore, orchestrates all specialists. Inbound message dispatch (`routeConsumerMessage`), T1 boundary, slash command wiring. |
| **BackendLifecycleManager** | `backend-lifecycle-manager.ts` | 553 | Backend adapter lifecycle: connect, disconnect, send, async message consumption loop. Passthrough response interception. |
| **UnifiedMessageRouter** | `unified-message-router.ts` | 521 | Outbound message dispatch: routes `UnifiedMessage` (from backends) to appropriate handler. T4 boundary. State reduction. Team event diffing. |
| **ConsumerTransportCoordinator** | `consumer-transport-coordinator.ts` | 269 | Consumer WebSocket lifecycle: accept/reject connections, message parsing/validation, rate limiting, disconnection cleanup. |
| **SessionStore** | `session-store.ts` | 268 | CRUD + persistence for the in-memory session map. Holds `Session` objects. |
| **ConsumerBroadcaster** | `consumer-broadcaster.ts` | 144 | Sends `ConsumerMessage` to WebSocket clients with backpressure protection and RBAC separation. |
| **SessionTransportHub** | `session-transport-hub.ts` | 142 | Wires the `WebSocketServerLike` to the bridge for both consumer and CLI (inverted-connection) paths. |
| **SlashCommandChain** | `slash-command-chain.ts` | 378 | Chain-of-responsibility for slash commands: LocalHandler, AdapterNativeHandler, PassthroughHandler, UnsupportedHandler. |

**Supporting modules** (well-focused, mostly keepers):

| Module | File | Lines | Role |
|--------|------|-------|------|
| ConsumerGatekeeper | `consumer-gatekeeper.ts` | 139 | Auth + RBAC + rate limiting |
| MessageQueueHandler | `message-queue-handler.ts` | 139 | Single-slot message queue |
| CapabilitiesProtocol | `capabilities-protocol.ts` | 144 | Initialize handshake with backend |
| GitInfoTracker | `git-info-tracker.ts` | 83 | Git resolution + refresh |
| ReconnectController | `reconnect-controller.ts` | 59 | Watchdog for stuck `starting` sessions |
| IdleSessionReaper | `idle-session-reaper.ts` | 77 | Timer-based cleanup |
| SessionStateReducer | `session-state-reducer.ts` | 256 | Pure state reduction function |
| ConsumerMessageMapper | `consumer-message-mapper.ts` | 345 | Pure T4 mapping functions |
| InboundNormalizer | `inbound-normalizer.ts` | 125 | Pure T1 mapping |
| MessageTracer | `message-tracer.ts` | 632 | Debug tracing at T1/T2/T3/T4 boundaries |

### Data Flow

#### Inbound: Consumer → Backend

```
Browser WS → NodeWebSocketServer
  → SessionTransportHub.handleConsumerConnection()
    → bridge.handleConsumerOpen(ws, ctx)
      → ConsumerTransportCoordinator.handleConsumerOpen()
        → ConsumerGatekeeper.authenticateAsync()
        → acceptConsumer(): send identity, session_init, history, permissions, queued msg

[consumer sends message]
  → bridge.handleConsumerMessage(ws, sessionId, data)
    → ConsumerTransportCoordinator.handleConsumerMessage()
      → size check (256KB) → JSON.parse → Zod validate → authorize → rate limit
      → routeConsumerMessage callback → SessionBridge.routeConsumerMessage()
        → switch(msg.type):
          case 'user_message':
            → push to history → broadcast to consumers
            → normalizeInbound(msg) [T1: InboundMessage → UnifiedMessage]
            → if backend connected: backendSession.send(unified)
              else: pendingMessages.push(unified)
```

#### Outbound: Backend → Consumers

```
BackendLifecycleManager.startBackendConsumption()
  for await (msg of backendSession.messages):
    → maybeEmitPendingPassthroughFromUnified() [slash interception]
    → routeUnifiedMessage callback → UnifiedMessageRouter.route()
      → reduceState(session.state, msg) [pure state transition]
      → emitTeamEvents() [diff old vs new team state]
      → switch(msg.type):
        case 'assistant':
          → mapAssistantMessage(msg) [T4: UnifiedMessage → ConsumerMessage]
          → dedup by message ID → push to history
          → broadcaster.broadcast(session, consumerMsg)
            → for each ws: ws.send(json) [backpressure guarded]
          → persist
```

### What's Already Good

These foundations should be preserved in any redesign:

1. **T1/T2/T3/T4 named translation boundaries** — pure mapping functions with clear names
2. **`BackendAdapter` + `BackendSession` interfaces** — clean async iterable contract, now with `stop?()` for graceful teardown
3. **`SessionStateReducer`** — pure function, no side effects
4. **`ConsumerMessageMapper`** — pure T4 functions (recently simplified: dropped backward-compat aliases `call_id`/`toolCallId` in favor of canonical `tool_use_id`)
5. **`InboundNormalizer`** — pure T1 functions
6. **`ConsumerGatekeeper`** — well-scoped auth + RBAC
7. **Chain-of-responsibility for slash commands** — good pattern
8. **Progressive extraction approach** — the direction was right, it just didn't go far enough
9. **Metadata passthrough convention** — recent `status_change` enrichment (`119104b`) shows the pattern of forwarding adapter metadata through to consumers, which the pipeline design should preserve

---

## Diagnosis: Five Structural Problems

### 1. The Session God Struct

The `Session` interface in `session-store.ts` has 20+ fields spanning every domain concern:

```typescript
interface Session {
  id: string
  backendSessionId?: string                              // backend identity
  backendSession: BackendSession | null                  // live backend connection
  backendAbort: AbortController | null                   // consumption loop control
  consumerSockets: Map<WebSocketLike, ConsumerIdentity>  // consumer transport
  consumerRateLimiters: Map<WebSocketLike, RateLimiter>  // rate limiting
  anonymousCounter: number                               // auth state
  state: SessionState                                    // broadcast-ready snapshot
  pendingPermissions: Map<string, PermissionRequest>     // permission handling
  messageHistory: ConsumerMessage[]                      // replay buffer
  pendingMessages: UnifiedMessage[]                      // pre-connect queue
  queuedMessage: QueuedMessage | null                    // single-slot queue
  lastStatus: 'compacting'|'idle'|'running'|null         // status tracking
  lastActivity: number                                   // idle detection
  pendingInitialize: {...} | null                         // capabilities handshake
  teamCorrelationBuffer: TeamToolCorrelationBuffer       // team tool pairing
  registry: SlashCommandRegistry                         // slash commands
  pendingPassthroughs: PendingPassthrough[]               // slash passthrough
  adapterName?: string                                   // adapter routing
  adapterSlashExecutor: AdapterSlashExecutor | null      // adapter commands
  adapterSupportsSlashPassthrough: boolean               // adapter capability
}
```

**Every specialist module** reaches into this shared mutable bag:
- `BackendLifecycleManager` mutates `backendSession`, `backendAbort`, `pendingPassthroughs`
- `ConsumerTransportCoordinator` mutates `consumerSockets`, `consumerRateLimiters`
- `UnifiedMessageRouter` mutates `messageHistory`, `lastStatus`, `state`
- `MessageQueueHandler` mutates `queuedMessage`, `pendingMessages`
- `CapabilitiesProtocol` mutates `pendingInitialize`, `state`

There is no ownership boundary. Any module can read or write any field.

### 2. SessionManager + SessionBridge Artificial Split

`SessionManager` (547L) wraps `SessionBridge` (742L) = **1,289 lines of orchestration** across
two classes that share a single responsibility: "manage sessions."

The split exists for historical reasons — SessionBridge was built first for the adapter layer,
then SessionManager was added to integrate `ClaudeLauncher` for process management. The result:

- Every public API call goes `manager → bridge → specialist` (3 layers)
- `SessionManager.wireEvents()` is a ~100-line method that forwards all bridge events
  to its own emitter plus adds process lifecycle hooks
- Business logic is split confusingly: auto-naming lives in SessionManager,
  but first-turn detection lives in UnifiedMessageRouter

### 3. Three-Hop Event Forwarding

Events travel through three layers:

```
Specialist (callback) → SessionBridge.emit() → SessionManager.emit()
```

This means:
- 30+ `trackListener()` calls in `SessionManager.wireEvents()`
- Adding a new event requires touching 3 files
- The event chain is invisible without reading the wiring code
- Cleanup tracking (`cleanupFns` array) to prevent listener leaks on restart

### 4. Callback Spaghetti for Wiring

Specialists receive their dependencies as callbacks in their constructor options:

```typescript
// BackendLifecycleManager receives:
{
  routeUnifiedMessage: (session, msg) => void,  // → calls UnifiedMessageRouter
  emitEvent: EmitEvent,                          // → calls bridge.emit()
}

// ConsumerTransportCoordinator receives:
{
  routeConsumerMessage: (session, msg, ws) => void,  // → calls SessionBridge
  emit: EmitBridgeEvent,                              // → calls bridge.emit()
}

// UnifiedMessageRouter receives:
{
  emitEvent: EmitEvent,                               // → calls bridge.emit()
  persistSession: PersistSession,                     // → calls store.persist()
}
```

This inverts the dependency (good) but makes the data flow invisible (bad). You can't see
the call graph without reading SessionBridge's constructor where these callbacks are bound.
It's implicit composition — no type or structure tells you "InboundMessage flows from
ConsumerTransportCoordinator → SessionBridge → BackendLifecycleManager."

### 5. Dual Session Registry

Two separate registries track session state:

| Registry | Location | Contains |
|----------|----------|----------|
| `SessionStore` (bridge-side) | `session-store.ts` | `Session` with live sockets, message history, state |
| `SessionRegistry` / `ClaudeLauncher` (launcher-side) | `claude-launcher.ts` | `SessionInfo` with PID, process state, exit codes |

`SessionManager.wireEvents()` keeps them in sync:

```typescript
launcher.on('process:spawned', ({ sessionId, pid }) => {
  // Update bridge-side session state
  bridge.seedSessionState(sessionId, { pid })
})

launcher.on('backend:session_id', ({ sessionId, backendSessionId }) => {
  // Update launcher registry AND bridge store
  registry.update(sessionId, { backendSessionId })
})
```

This sync logic is fragile and a source of subtle bugs when events arrive out of order.

---

## Proposed Architecture

### Core Invariant

> **Only `SessionRuntime` can mutate session state.**

This is the single most important design rule. In the current system, 5+ modules reach into
the `Session` struct and mutate different fields. In the redesign, there is exactly one
writer per session: the `SessionRuntime` instance that owns that session's lifecycle.

Everything else either:
- **Emits commands** (transport modules, policy services) — requests for state change
- **Transforms data** (pure functions) — normalizer, reducer, mapper
- **Projects state** (read-only) — broadcaster, repository

### Four Bounded Contexts

| Context | Responsibility | Modules |
|---------|---------------|---------|
| **SessionControl** | Global lifecycle, per-session state ownership | `SessionCoordinator`, `SessionRuntime` (per-session), `SessionRepository`, `ReconnectPolicy`, `IdlePolicy`, `CapabilitiesPolicy` |
| **BackendPlane** | Adapter abstraction, connect/send/stream | `BackendConnector`, `AdapterResolver`, `BackendAdapter`(s) |
| **ConsumerPlane** | WebSocket transport, auth, rate limits, outbound push | `ConsumerGateway`, `OutboundPublisher` |
| **MessagePlane** | Pure translation, reduction, slash command resolution | `MessageRouter`, `StateReducer`, `ConsumerProjector`, `SlashCommandService` |

### Design Rules

| # | Rule | Rationale |
|---|------|-----------|
| 1 | Only `SessionRuntime` can change session state | Eliminates the shared-mutable-bag problem |
| 2 | Transport modules emit commands, never trigger business side effects directly | Clean separation between I/O and logic |
| 3 | `MessageRouter` is pure mapping + reduction; broadcasting is a projector step | No transport knowledge in message handling |
| 4 | Slash handling has one entrypoint (`executeSlashCommand`) and one completion contract | No more split between registration and interception |
| 5 | Policy services observe state and emit commands to the runtime — they never mutate | Reconnect, idle, capabilities become advisors |
| 6 | Explicit lifecycle states for each session | Testable state machine, no implicit status inference |
| 7 | Session-scoped domain events flow from runtime; coordinator emits only global lifecycle events | Typed, meaningful events replace the 3-hop forwarding chain |
| 8 | Direct method calls, not actor mailbox | Node.js is single-threaded — the principle matters, not the mechanism |
| 9 | Per-session command handling is serialized | Avoids async interleaving bugs while keeping direct-call ergonomics |

### Overview Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SessionCoordinator                              │
│                    (global lifecycle + registry)                        │
│              create / delete / list / restore / shutdown                │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ one per session
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    SessionRuntime (per-session)                         │
│              ════════════════════════════════════                       │
│              SOLE OWNER of mutable SessionState                         │
│              Thin command handler — delegates to pure fns               │
│                                                                         │
│  ┌─ Inbound ──────────────────────────────────────────────────────┐     │
│  │                                                                │     │
│  │  receive(cmd: InboundCommand)                                  │     │
│  │    ├─ UserMessage ──▶ normalize(T1) → send to backend          │     │
│  │    ├─ Permission ───▶ validate → send to backend               │     │
│  │    ├─ SlashCommand ─▶ slashService.execute(cmd)                │     │
│  │    ├─ Interrupt ────▶ normalize(T1) → send to backend          │     │
│  │    └─ QueueOp ──────▶ update queue state                       │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                         │
│  ┌─ Outbound ─────────────────────────────────────────────────────┐     │
│  │                                                                │     │
│  │  handleBackendMessage(msg: UnifiedMessage)                     │     │
│  │    ├─ 1. state = reducer.reduce(state, msg)        [pure]      │     │
│  │    ├─ 2. consumerMsg = projector.project(msg)      [pure]      │     │
│  │    ├─ 3. history.push(consumerMsg)                 [mutate]    │     │
│  │    ├─ 4. publisher.broadcast(consumerMsg)          [side-eff]  │     │
│  │    └─ 5. emit(DomainEvent)                         [notify]    │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                         │
│  State machine: STARTING → AWAITING_BACKEND → ACTIVE → IDLE             │
│                 → DEGRADED → CLOSING → CLOSED                           │
│                                                                         │
│  Emits domain events:  SessionStarted, BackendConnected,                │
│    MessageRouted, PermissionRequested, SlashExecuted, SessionClosed     │
└───┬───────────┬───────────┬──────────────────────┬──────────────────────┘
    │           │           │                      │
    ▼           ▼           ▼                      ▼
┌────────┐ ┌────────┐ ┌──────────┐          ┌───────────┐
│Backend │ │Consum. │ │ Slash    │          │ Policies  │
│Connect.│ │Gateway │ │ Command  │          │           │
│        │ │        │ │ Service  │          │•Reconnect │
│•connect│ │•accept │ │          │          │•Idle      │
│•send   │ │•reject │ │•execute()│          │•Caps      │
│•consume│ │•push   │ │ one API  │          │           │
│•disconn│ │•close  │ │ all strat│          │ Observe   │
│        │ │        │ │          │          │ state,    │
│ Emits: │ │ Emits: │ │ Handles: │          │ emit cmds │
│ Backend│ │ Inbound│ │ •local   │          │ to runtime│
│ Event  │ │ Command│ │ •native  │          └───────────┘
│ (to    │ │ (to    │ │ •passthru│
│ runtime│ │ runtime│ │ •reject  │
│  )     │ │  )     │ └──────────┘
└────────┘ └────────┘

  PURE FUNCTIONS (stateless, no transport knowledge):
  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
  │ InboundNorm.   │ │ StateReducer   │ │ ConsumerProj.  │
  │ (T1)           │ │ (pure reduce)  │ │ (T4 mapping)   │
  └────────────────┘ └────────────────┘ └────────────────┘

  INFRASTRUCTURE:
  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
  │ SessionRepo    │ │ OutboundPubl.  │ │ AdapterResolver│
  │ (persist/snap) │ │ (WS broadcast) │ │ (adapter lookup│
  └────────────────┘ └────────────────┘ └────────────────┘
```

---

## Design Decisions

### 1. SessionRuntime — Per-Session State Owner

The current `Session` is a 20-field mutable struct that every module reaches into. The
redesign replaces it with a `SessionRuntime` class — one instance per session — that is
the **sole writer** of all session state.

The runtime is a **thin command handler**, not a god object. It receives commands from
transport modules and policy services, delegates to pure functions for the actual logic,
and applies the resulting state changes:

```typescript
class SessionRuntime {
  // ── Private mutable state — no one else can write ──
  private lifecycle: LifecycleState = "starting"
  private backend: BackendState
  private consumers: ConnectionState
  private conversation: ConversationState
  private permissions: PermissionState
  private commands: CommandState
  private projected: SessionState          // read-only projection for external consumers

  constructor(
    readonly id: string,
    private backendConnector: BackendConnector,
    private consumerGateway: ConsumerGateway,
    private slashService: SlashCommandService,
    private reducer: SessionStateReducer,       // pure
    private projector: ConsumerProjector,       // pure (T4)
    private normalizer: InboundNormalizer,       // pure (T1)
    private publisher: OutboundPublisher,
    private repo: SessionRepository,
    private bus: DomainEventBus,
  ) {}

  // ── Read-only access for external consumers ──
  get state(): Readonly<SessionState> { return this.projected }
  get consumerCount(): number { return this.consumers.sockets.size }
  get isBackendConnected(): boolean { return this.backend.session !== null }

  // ── Inbound command handling ──

  handleInboundCommand(cmd: InboundCommand): void {
    switch (cmd.type) {
      case "user_message":
        return this.handleUserMessage(cmd)
      case "permission_response":
        return this.handlePermissionResponse(cmd)
      case "slash_command":
        return this.slashService.execute(this, cmd)
      case "interrupt":
      case "set_model":
      case "set_permission_mode":
        return this.sendToBackend(this.normalizer.normalize(cmd))
      case "queue_message":
        return this.handleQueueMessage(cmd)
      case "cancel_queued_message":
        return this.handleCancelQueue()
    }
  }

  // ── Backend message handling (called by BackendConnector) ──

  handleBackendMessage(msg: UnifiedMessage): void {
    // 1. Pure state reduction
    const prevTeam = this.projected.team
    this.projected = this.reducer.reduce(this.projected, msg, this.commands.correlationBuffer)

    // 2. Lifecycle transition
    this.updateLifecycle(msg)

    // 3. Dispatch by message type
    switch (msg.type) {
      case "assistant":    return this.handleAssistant(msg)
      case "result":       return this.handleResult(msg)
      case "stream_event": return this.handleStreamEvent(msg)
      case "status_change": return this.handleStatusChange(msg)
      case "permission_request": return this.handlePermissionRequest(msg)
      case "session_init": return this.handleSessionInit(msg)
      case "control_response": return this.handleControlResponse(msg)
      case "tool_progress": return this.handleToolProgress(msg)
      case "tool_use_summary": return this.handleToolUseSummary(msg)
      case "auth_status": return this.handleAuthStatus(msg)
      case "configuration_change": return this.handleConfigChange(msg)
      case "session_lifecycle": return this.handleSessionLifecycle(msg)
      default:
        // Unhandled types silently consumed (logged via tracer)
        break
    }

    // 4. Emit team diffs
    this.emitTeamDiff(prevTeam, this.projected.team)
  }

  // ── Policy command handling ──

  handlePolicyCommand(cmd: PolicyCommand): void {
    switch (cmd.type) {
      case "reconnect_timeout":
        return this.transitionTo("degraded")
      case "idle_reap":
        return this.close()
      case "capabilities_timeout":
        this.bus.emit({ type: "capabilities:timeout", sessionId: this.id })
        break
    }
  }

  // ── Private handlers (thin — delegate to pure fns, apply mutations) ──

  private handleUserMessage(cmd: UserMessageCommand): void {
    const echoMsg = toConsumerEcho(cmd)
    this.conversation.history.push(echoMsg)
    this.publisher.broadcast(this, echoMsg)

    const unified = this.normalizer.normalize(cmd)
    if (this.backend.session) {
      this.backend.session.send(unified)
    } else {
      this.conversation.pendingMessages.push(unified)
    }

    this.conversation.lastStatus = "running"
    this.repo.persist(this.snapshot())
  }

  private handleAssistant(msg: UnifiedMessage): void {
    const consumerMsg = this.projector.mapAssistant(msg)
    if (this.isDuplicate(consumerMsg)) return
    this.conversation.history.push(consumerMsg)
    this.publisher.broadcast(this, consumerMsg)
    this.repo.persist(this.snapshot())
  }

  private handleResult(msg: UnifiedMessage): void {
    const consumerMsg = this.projector.mapResult(msg)
    this.conversation.history.push(consumerMsg)
    this.conversation.lastStatus = "idle"
    this.publisher.broadcast(this, consumerMsg)
    this.repo.persist(this.snapshot())

    // Auto-send queued message now that we're idle
    if (this.conversation.queuedMessage) {
      this.drainQueue()
    }

    // First turn detection
    if (this.isFirstTurn()) {
      this.bus.emit({
        type: "session:first_turn",
        sessionId: this.id,
        firstUserMessage: this.extractFirstUserMessage(),
      })
    }
  }
}
```

**Why this avoids the god object trap:** `SessionRuntime` is a **coordinator**, not a
logic container. The switch-case bodies are 3-8 lines each — they call pure functions
(`reducer.reduce`, `projector.mapAssistant`, `normalizer.normalize`) and apply the
results. The complexity lives in the pure functions, which are independently testable.

**Why not a literal actor mailbox:** Node.js is single-threaded. We keep direct method
calls (`runtime.handleInboundCommand(cmd)`) instead of introducing actor framework
ceremony. To avoid async interleaving across `await` boundaries, each runtime still
processes commands through a lightweight per-session serial executor (promise chain).
If the system ever moves to worker threads, this can evolve into a full mailbox.

### 2. Commands vs Domain Events

The current system uses one `EventBus` for both "please do X" and "X happened." The
redesign explicitly separates these:

**Commands** — requests to change state (flow *into* the runtime):

```typescript
// Inbound commands (from ConsumerGateway)
type InboundCommand =
  | { type: "user_message"; sessionId: string; content: string; images?: Image[] }
  | { type: "permission_response"; sessionId: string; requestId: string; behavior: "allow" | "deny" }
  | { type: "slash_command"; sessionId: string; command: string; requestId?: string }
  | { type: "interrupt"; sessionId: string }
  | { type: "set_model"; sessionId: string; model: string }
  | { type: "set_permission_mode"; sessionId: string; mode: string }
  | { type: "queue_message"; sessionId: string; content: string }
  | { type: "cancel_queued_message"; sessionId: string }
  | { type: "update_queued_message"; sessionId: string; content: string }

// Backend signals (from BackendConnector to SessionRuntime only — not DomainEventBus)
type BackendEvent =
  | { type: "backend:message"; sessionId: string; message: UnifiedMessage }
  | { type: "backend:connected"; sessionId: string }
  | { type: "backend:disconnected"; sessionId: string; code: number; reason: string }

// Policy commands (from policy services — advisory)
type PolicyCommand =
  | { type: "reconnect_timeout"; sessionId: string }
  | { type: "idle_reap"; sessionId: string }
  | { type: "capabilities_timeout"; sessionId: string }
```

**Domain events** — notifications of what happened (flow *out of* runtime/coordinator, never from transport/policy):

```typescript
type DomainEvent =
  // Session lifecycle
  | { type: "session:created"; sessionId: string }
  | { type: "session:closed"; sessionId: string }
  | { type: "session:first_turn"; sessionId: string; firstUserMessage: string }
  | { type: "session:lifecycle_changed"; sessionId: string; from: LifecycleState; to: LifecycleState }

  // Backend
  | { type: "backend:connected"; sessionId: string }
  | { type: "backend:disconnected"; sessionId: string; code: number; reason: string }
  | { type: "backend:session_id"; sessionId: string; backendSessionId: string }
  | { type: "backend:relaunch_needed"; sessionId: string }

  // Consumer
  | { type: "consumer:connected"; sessionId: string; identity: ConsumerIdentity; count: number }
  | { type: "consumer:disconnected"; sessionId: string; identity: ConsumerIdentity; count: number }
  | { type: "consumer:authenticated"; sessionId: string; userId: string; role: ConsumerRole }

  // Process
  | { type: "process:spawned"; sessionId: string; pid: number }
  | { type: "process:exited"; sessionId: string; exitCode: number | null; uptimeMs: number; circuitBreaker?: CircuitBreakerState }

  // Messages (for tracing/metrics/external consumers)
  | { type: "message:inbound"; sessionId: string; message: InboundCommand }
  | { type: "message:outbound"; sessionId: string; message: ConsumerMessage }

  // Permissions
  | { type: "permission:requested"; sessionId: string; request: PermissionRequest }
  | { type: "permission:resolved"; sessionId: string; requestId: string; behavior: string }

  // Slash commands
  | { type: "slash:executed"; sessionId: string; command: string; source: string; durationMs: number }
  | { type: "slash:failed"; sessionId: string; command: string; error: string }

  // Capabilities
  | { type: "capabilities:ready"; sessionId: string; commands: InitializeCommand[]; models: InitializeModel[]; account: InitializeAccount | null }
  | { type: "capabilities:timeout"; sessionId: string }

  // Team
  | { type: "team:created"; sessionId: string; teamName: string }
  | { type: "team:deleted"; sessionId: string; teamName: string }
  | { type: "team:member:joined"; sessionId: string; member: TeamMember }
  | { type: "team:member:idle"; sessionId: string; member: TeamMember }
  | { type: "team:member:shutdown"; sessionId: string; member: TeamMember }
  | { type: "team:task:created"; sessionId: string; task: TeamTask }
  | { type: "team:task:claimed"; sessionId: string; task: TeamTask }
  | { type: "team:task:completed"; sessionId: string; task: TeamTask }

  // Errors
  | { type: "error"; source: string; error: Error; sessionId?: string }
```

**The `DomainEventBus` is flat and typed — one hop, no forwarding:**

```typescript
interface DomainEventBus {
  emit(event: DomainEvent): void
  on<T extends DomainEvent["type"]>(
    type: T,
    handler: (event: Extract<DomainEvent, { type: T }>) => void,
  ): Disposable
}
```

This replaces the current `BridgeEventMap` → `SessionBridge.emit()` →
`SessionManager.emit()` three-hop chain with: emit once at the source, subscribe
directly at the consumer.

### 3. SessionCoordinator — Global Lifecycle Only

Replaces `SessionManager` (547L) + the lifecycle parts of `SessionBridge` (742L).
Owns the runtime map but not session state — that's each `SessionRuntime`'s job:

```typescript
class SessionCoordinator {
  private runtimes = new Map<string, SessionRuntime>()

  constructor(
    private repo: SessionRepository,
    private backendConnector: BackendConnector,
    private consumerGateway: ConsumerGateway,
    private processSupervisor: ProcessSupervisor,
    private bus: DomainEventBus,
    // ... pure function factories injected for runtime construction
  ) {}

  async start(): Promise<void> {
    await this.restoreFromStorage()
    this.subscribeToDomainEvents()
    this.consumerGateway.start()
  }

  async stop(): Promise<void> {
    this.consumerGateway.stop()
    for (const [id] of this.runtimes) {
      await this.deleteSession(id)
    }
    await this.backendConnector.stopAdapters()
  }

  async createSession(options: CreateSessionOptions): Promise<SessionRuntime> {
    const runtime = this.buildRuntime(options.id ?? generateId(), options)
    this.runtimes.set(runtime.id, runtime)

    if (options.connectionMode === "inverted") {
      await this.processSupervisor.spawn(runtime.id, options)
    } else {
      await this.backendConnector.connect(runtime, options)
    }

    this.bus.emit({ type: "session:created", sessionId: runtime.id })
    return runtime
  }

  async deleteSession(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    runtime.close()
    await this.processSupervisor.kill(id)
    this.repo.remove(id)
    this.runtimes.delete(id)
    this.bus.emit({ type: "session:closed", sessionId: id })
  }

  getRuntime(id: string): SessionRuntime | undefined {
    return this.runtimes.get(id)
  }

  listSessions(): SessionSummary[] {
    return [...this.runtimes.values()].map(r => r.snapshot())
  }

  // ── Domain event reactions ──

  private subscribeToDomainEvents(): void {
    this.bus.on("backend:relaunch_needed", (e) => this.relaunchWithDedup(e.sessionId))
    this.bus.on("session:first_turn", (e) => this.autoName(e.sessionId, e.firstUserMessage))
    this.bus.on("process:exited", (e) => this.handleProcessExit(e))
  }

  private relaunchWithDedup(sessionId: string): void {
    // Dedup timer pattern — same logic as current, localized here
  }

  private autoName(sessionId: string, firstMessage: string): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime || runtime.state.name) return
    const name = firstMessage.slice(0, 50)
    runtime.setName(name) // runtime applies the mutation
    this.repo.persist(runtime.snapshot())
  }
}
```

### 4. ConsumerGateway — Transport Only

Handles WebSocket I/O, authentication, rate limiting. **No business logic.** On receiving
a valid message, it wraps it as an `InboundCommand` and sends it to the runtime:

```typescript
class ConsumerGateway {
  constructor(
    private coordinator: { getRuntime(id: string): SessionRuntime | undefined },
    private gatekeeper: ConsumerGatekeeper,     // auth + RBAC + rate limit (kept)
    private publisher: OutboundPublisher,
  ) {}

  start(): void { /* wire WS server callbacks */ }
  stop(): void { /* close WS server */ }

  async handleConnection(ws: WebSocketLike, ctx: ConnectionContext): Promise<void> {
    const runtime = this.coordinator.getRuntime(ctx.sessionId)
    if (!runtime) return this.reject(ws, 4004, "Session not found")

    // Auth (async if authenticator present)
    const identity = await this.gatekeeper.authenticate(ws, ctx)
    if (!identity) return // gatekeeper already closed the socket

    // Register socket (runtime owns the mutation)
    runtime.addConsumer(ws, identity) // runtime emits consumer:connected

    // Send replay: identity, session_init, history, pending permissions, queued msg
    this.publisher.sendReplayTo(ws, runtime)
  }

  handleMessage(ws: WebSocketLike, sessionId: string, data: string): void {
    const runtime = this.coordinator.getRuntime(sessionId)
    if (!runtime) return

    // Validate: size check, JSON parse, Zod schema, RBAC, rate limit
    const result = this.gatekeeper.validate(ws, runtime, data)
    if (!result.ok) return // gatekeeper sent error response

    // Wrap as command and hand to runtime
    runtime.handleInboundCommand(result.command)
  }

  handleClose(ws: WebSocketLike, sessionId: string): void {
    const runtime = this.coordinator.getRuntime(sessionId)
    if (!runtime) return
    runtime.removeConsumer(ws) // runtime emits consumer:disconnected
  }
}
```

### 5. BackendConnector — Adapter Abstraction + Passthrough

Merges `BackendLifecycleManager` + `SessionTransportHub` (CLI path) + the passthrough
interception from `SlashCommandChain`. Owns connect/disconnect/send/consume and the
passthrough lifecycle (both registration and response interception):

```typescript
class BackendConnector {
  constructor(
    private adapterResolver: AdapterResolver,
  ) {}

  async connect(runtime: SessionRuntime, options: ConnectOptions): Promise<void> {
    const adapter = this.adapterResolver.resolve(runtime.adapterName)
    const session = await adapter.connect(options)
    runtime.setBackendSession(session, adapter) // runtime emits backend:connected
    this.startConsumptionLoop(runtime, session)
  }

  disconnect(runtime: SessionRuntime): void {
    runtime.clearBackendSession({ code: 1000, reason: "normal" }) // runtime emits backend:disconnected
  }

  async stopAdapters(): Promise<void> {
    await this.adapterResolver.stopAll?.()
  }

  // ── Passthrough: registration + interception co-located ──

  registerPassthrough(runtime: SessionRuntime, command: string, requestId: string): void {
    runtime.pushPassthrough({ command, requestId, buffer: "", startedAtMs: Date.now() })
    // Send as user message to backend
    runtime.sendToBackend({
      type: "user_message",
      content: command,
      metadata: { isPassthrough: true },
    } as UnifiedMessage)
  }

  // ── Private: consumption loop ──

  private async startConsumptionLoop(runtime: SessionRuntime, session: BackendSession): Promise<void> {
    try {
      for await (const msg of session.messages) {
        if (runtime.isClosing) break
        runtime.touchActivity()

        // Intercept passthrough BEFORE routing to runtime
        if (this.interceptPassthrough(runtime, msg)) continue

        // Route to runtime's outbound handler
        runtime.handleBackendMessage(msg)
      }
    } finally {
      runtime.handleBackendStreamEnd() // runtime emits backend:disconnected if needed
    }
  }

  private interceptPassthrough(runtime: SessionRuntime, msg: UnifiedMessage): boolean {
    const pending = runtime.peekPassthrough()
    if (!pending) return false
    // ... buffering, completion, emit slash_command_result — all in one place
    return false
  }
}
```

### 6. MessageRouter — Pure Translation + Reduction

Extracts the pure functions from `UnifiedMessageRouter` into a stateless service.
**No transport knowledge, no broadcasting, no persistence** — those are the runtime's
responsibility after calling these functions:

```typescript
// These already exist and are kept as-is:
// - InboundNormalizer (T1: InboundMessage → UnifiedMessage)
// - SessionStateReducer (pure state transition)
// - ConsumerMessageMapper (T4: UnifiedMessage → ConsumerMessage)

// New: ConsumerProjector wraps the mapper with dedup + history-worthiness logic
class ConsumerProjector {
  constructor(
    private mapper: ConsumerMessageMapper,   // existing pure T4
  ) {}

  // Returns null if message should not be projected (e.g., duplicate, keep_alive)
  projectAssistant(msg: UnifiedMessage, history: ConsumerMessage[]): ConsumerMessage | null {
    const mapped = this.mapper.mapAssistantMessage(msg)
    if (this.isDuplicate(mapped, history)) return null
    return mapped
  }

  projectResult(msg: UnifiedMessage): ConsumerMessage {
    return this.mapper.mapResultMessage(msg)
  }

  projectStreamEvent(msg: UnifiedMessage): ConsumerMessage {
    return this.mapper.mapStreamEvent(msg)
  }

  projectStatusChange(msg: UnifiedMessage): ConsumerMessage {
    // Includes metadata passthrough (step/retry/plan data per 119104b)
    return this.mapper.mapStatusChange(msg)
  }

  // ... one method per message type, all pure
}
```

The runtime calls these and applies the results:

```typescript
// Inside SessionRuntime.handleAssistant():
const consumerMsg = this.projector.projectAssistant(msg, this.conversation.history)
if (!consumerMsg) return              // dedup — pure function decided to skip
this.conversation.history.push(consumerMsg)  // mutation — only runtime does this
this.publisher.broadcast(this, consumerMsg)  // side effect — only runtime triggers this
this.repo.persist(this.snapshot())           // persistence — only runtime triggers this
```

### 7. SlashCommandService — One Interface

Consolidates `SlashCommandChain` into a single service with one entrypoint and one
completion contract. The passthrough strategy delegates to `BackendConnector` for both
registration and interception (co-located):

```typescript
class SlashCommandService {
  constructor(
    private backendConnector: BackendConnector,
    private publisher: OutboundPublisher,
  ) {}

  execute(runtime: SessionRuntime, cmd: SlashCommandInbound): void {
    const command = cmd.command
    const ctx = { command, requestId: cmd.requestId, startedAtMs: Date.now() }

    // Strategy 1: Local (e.g., /help)
    if (this.isLocal(command)) {
      return this.executeLocal(runtime, ctx)
    }

    // Strategy 2: Adapter-native (adapter has its own executor)
    const executor = runtime.getSlashExecutor()
    if (executor?.handles(command)) {
      return this.executeNative(runtime, executor, ctx)
    }

    // Strategy 3: Passthrough (send as user message, intercept response)
    if (runtime.supportsPassthrough) {
      this.backendConnector.registerPassthrough(runtime, command, ctx.requestId ?? generateId())
      return
    }

    // Strategy 4: Unsupported
    this.publisher.broadcast(runtime, {
      type: "slash_command_error",
      command,
      error: `Command not supported: ${command}`,
    })
    runtime.recordSlashFailure(command, "unsupported")
  }

  // ── Private strategy implementations ──

  private executeLocal(runtime: SessionRuntime, ctx: SlashContext): void {
    const result = generateHelpText(runtime.state)
    this.publisher.broadcast(runtime, { type: "slash_command_result", ...result })
    runtime.recordSlashSuccess({
      command: ctx.command,
      source: "emulated",
      durationMs: Date.now() - ctx.startedAtMs,
    })
  }

  private async executeNative(
    runtime: SessionRuntime,
    executor: AdapterSlashExecutor,
    ctx: SlashContext,
  ): Promise<void> {
    const result = await executor.execute(ctx.command)
    if (result) {
      this.publisher.broadcast(runtime, { type: "slash_command_result", content: result.content })
      runtime.recordSlashSuccess({
        command: ctx.command,
        source: result.source,
        durationMs: result.durationMs,
      })
    }
  }
}
```

### 8. Policy Services — Observe and Advise

The current `ReconnectController`, `IdleSessionReaper`, and `CapabilitiesProtocol` directly
participate in event chains or mutate state. The redesign makes them **observers that emit
commands** to the runtime:

```typescript
class ReconnectPolicy {
  constructor(
    private coordinator: { getRuntime(id: string): SessionRuntime | undefined },
    private bus: DomainEventBus,
    private config: { reconnectTimeoutMs: number },
  ) {
    // Observe: sessions stuck in "starting" after restart
    bus.on("session:lifecycle_changed", (e) => {
      if (e.to === "awaiting_backend") {
        this.startWatchdog(e.sessionId)
      } else {
        this.clearWatchdog(e.sessionId)
      }
    })
  }

  private startWatchdog(sessionId: string): void {
    setTimeout(() => {
      const runtime = this.coordinator.getRuntime(sessionId)
      if (runtime?.lifecycle === "awaiting_backend") {
        // Advise the runtime — don't mutate state directly
        runtime.handlePolicyCommand({ type: "reconnect_timeout", sessionId })
      }
    }, this.config.reconnectTimeoutMs)
  }
}

class IdlePolicy {
  constructor(
    private coordinator: {
      getRuntime(id: string): SessionRuntime | undefined
      listRuntimeEntries(): Iterable<[string, SessionRuntime]>
    },
    private bus: DomainEventBus,
    private config: { idleTimeoutMs: number },
  ) {
    // Periodic scan for idle sessions
    setInterval(() => this.sweep(), 60_000)
  }

  private sweep(): void {
    for (const [id, runtime] of this.coordinator.listRuntimeEntries()) {
      if (runtime.consumerCount === 0
        && !runtime.isBackendConnected
        && Date.now() - runtime.lastActivity > this.config.idleTimeoutMs) {
        runtime.handlePolicyCommand({ type: "idle_reap", sessionId: id })
      }
    }
  }
}

class CapabilitiesPolicy {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private coordinator: { getRuntime(id: string): SessionRuntime | undefined },
    private bus: DomainEventBus,
    private config: { capabilitiesTimeoutMs: number },
  ) {
    bus.on("backend:connected", (e) => this.startTimeout(e.sessionId))
    bus.on("capabilities:ready", (e) => this.clearTimeout(e.sessionId))
  }

  private startTimeout(sessionId: string): void {
    this.clearTimeout(sessionId)
    const timer = setTimeout(() => {
      // If capabilities haven't arrived, advise the runtime.
      // Runtime decides whether to emit capabilities:timeout and/or apply defaults.
      const runtime = this.coordinator.getRuntime(sessionId)
      runtime?.handlePolicyCommand({ type: "capabilities_timeout", sessionId })
    }, this.config.capabilitiesTimeoutMs)
    this.timers.set(sessionId, timer)
  }

  private clearTimeout(sessionId: string): void {
    const timer = this.timers.get(sessionId)
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(sessionId)
  }
}
```

### 9. SessionRepository — Snapshots Not Live Objects

The current `SessionStore.persist()` serializes the live mutable `Session` object.
The redesign persists **snapshots** — immutable point-in-time copies:

```typescript
interface SessionRepository {
  persist(snapshot: SessionSnapshot): Promise<void>
  remove(id: string): Promise<void>
  restoreAll(): Promise<RestoredSession[]>
}

// Immutable snapshot — safe to serialize, no live references
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

The runtime calls `repo.persist(this.snapshot())` — creating a snapshot copies the
relevant fields, ensuring the repository never holds a reference to live mutable state.

### 10. Explicit Lifecycle State Machine

Replace the implicit status tracking (`lastStatus`, `backendSession !== null`, etc.)
with a first-class state machine:

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
  ┌──────────┐    process spawned    ┌──────────────────┐
  │ starting │  ──────────────────▶  │ awaiting_backend │
  └──────────┘    (inverted only)    └────────┬─────────┘
       │                                      │
       │ adapter.connect()                    │ CLI connects on /ws/cli/:id
       │ (direct mode)                        │
       │                                      │
       └──────────────┬───────────────────────┘
                      │
                      ▼
                 ┌─────────┐
           ┌────▶│  active │◀─── user_message received
           │     └────┬────┘
           │          │
           │     result received
           │          │
           │          ▼
           │     ┌─────────┐
           │     │  idle   │──── user_message ───▶ active
           │     └────┬────┘
           │          │
           │     stream ends unexpectedly
           │          │
           │          ▼
           │    ┌───────────┐
           │    │ degraded   │── relaunch succeeds ──┐
           │    └─────┬─────┘                        │
           │          │                              │
           │          │ relaunch fails               │
           │          │ or idle_reap                 │
           │          ▼                              │
           │    ┌───────────┐                        │
           │    │  closing  │                        │
           │    └─────┬─────┘                        │
           │          │                              │
           │          ▼                              │
           │    ┌────────────┐                       │
           └────│  closed    │◀──────────────────────┘
                └────────────┘    (only if relaunch also
                                  detects session gone)
```

The state machine enables:
- **Guard clauses:** `handleInboundCommand` rejects commands in `closing`/`closed`
- **Policy triggers:** `ReconnectPolicy` watches for `awaiting_backend`, `IdlePolicy` watches for `idle`
- **Testability:** State transitions are explicit and can be unit-tested

---

## Target Module Responsibilities

| Module | Responsibility | Writes State? | ~Lines |
|--------|---------------|:------------:|-------:|
| **SessionCoordinator** | Global lifecycle: create, delete, list, restore, shutdown. Reacts to domain events (relaunch, auto-name). | No (delegates to runtime) | ~250 |
| **SessionRuntime** | Per-session state owner. Thin command handler: receives commands, delegates to pure functions, applies mutations, emits domain events. | **Yes — sole writer** | ~400 |
| **ConsumerGateway** | WS accept/reject, auth delegation, message validation. Wraps valid messages as `InboundCommand`. | No (emits commands) | ~200 |
| **BackendConnector** | Adapter connect/disconnect/send. Consumption loop. Passthrough registration + interception. | No (calls runtime methods) | ~300 |
| **MessageRouter** | Pure functions only: `InboundNormalizer` (T1), `StateReducer`, `ConsumerProjector` (T4). No transport, no broadcasting, no persistence. | No (pure) | kept |
| **SlashCommandService** | One `execute()` entrypoint. Strategies: local, native, passthrough, unsupported. Passthrough delegates to `BackendConnector`. | No (calls runtime/connector) | ~200 |
| **SessionRepository** | Persist/restore snapshots. Never holds live mutable references. | No (reads snapshots) | ~200 |
| **OutboundPublisher** | WS broadcast with backpressure. RBAC-aware (participants vs observers). Replay on reconnect. | No (reads state) | ~150 |
| **ReconnectPolicy** | Watchdog for `awaiting_backend` timeout. Emits `PolicyCommand`. | No (advises) | ~60 |
| **IdlePolicy** | Periodic sweep for sessions with no consumers and no backend. Emits `PolicyCommand`. | No (advises) | ~80 |
| **CapabilitiesPolicy** | Timeout for capabilities handshake. Emits `PolicyCommand` (`capabilities_timeout`) to runtime. | No (advises) | ~80 |
| **DomainEventBus** | Flat typed pub/sub. One hop. All events in one `DomainEvent` union. | No (infra) | ~80 |

**Estimated new core total:** ~2,000 lines (vs ~3,600 currently), excluding unchanged
pure functions and supporting modules.

---

## Module Dependency Graph

```
                    SessionCoordinator (~250L)
                   ╱    │        │         ╲
                  ╱     │        │          ╲
                 ╱      │        │           ╲
                ▼       ▼        ▼            ▼
         ┌──────────┐  ┌─────┐  ┌──────────┐  ┌───────────────┐
         │ Session  │  │Domai│  │ Consumer │  │   Process     │
         │ Reposit. │  │n    │  │ Gateway  │  │   Supervisor  │
         │ (~200L)  │  │Event│  │ (~200L)  │  │   (existing   │
         │          │  │Bus  │  │          │  │    launcher)  │
         └──────────┘  │(~80)│  └────┬─────┘  └───────────────┘
                       └──┬──┘       │
                          │     Gatekeeper
                          │     (existing ~140L)
                          │
       ┌──────────────────┼──────────────────────┐
       │                  │                      │
       ▼                  ▼                      ▼
  ┌──────────┐    ┌──────────────┐       ┌────────────┐
  │ Backend  │    │SessionRuntime│       │  Policies  │
  │Connector │    │  (~400L)     │       │ •Reconnect │
  │ (~300L)  │    │              │       │ •Idle      │
  │          │    │  SOLE OWNER  │       │ •Caps      │
  └────┬─────┘    │  of state    │       │ (~220L)    │
       │          └──────┬───────┘       └────────────┘
       │                 │
  AdapterResolver        │ delegates to
  (existing)             │
                    ┌────┼─────────────┐
                    ▼    ▼             ▼
              ┌──────┐┌──────┐  ┌──────────┐
              │Slash ││Outb. │  │Pure Fns  │
              │Cmd   ││Publ. │  │•Normaliz.│
              │Svc   ││(~150)│  │•Reducer  │
              │(~200)││      │  │•Projector│
              └──────┘└──────┘  └──────────┘

  No cycles. Pure functions at leaves.
  Runtime delegates to pure fns + services.
  Transport modules emit commands to runtime.
  Policies observe and advise.
```

---

## Summary of Changes

| Current | Redesigned | Benefit |
|---------|-----------|---------|
| `Session` god struct (20+ fields) mutated by 5+ modules | `SessionRuntime` is sole writer; internal state organized as typed sub-structs | One writer per session — structurally enforced |
| `SessionManager` + `SessionBridge` (1,289L) | `SessionCoordinator` (~250L) + `SessionRuntime` (~400L per-session) | Clear split: global lifecycle vs. per-session state |
| 3-hop event forwarding (specialist → bridge → manager) | Flat `DomainEventBus` — one emit, direct subscribe | Adding an event touches 2 files, not 4 |
| Implicit `BridgeEventMap` conflates commands and events | Explicit `InboundCommand` / `PolicyCommand` / `DomainEvent` types | Commands flow in, events flow out — can't confuse them |
| Callback wiring (`routeUnifiedMessage`, `emitEvent`) | Direct method calls (`runtime.handleBackendMessage(msg)`) | Data flow visible in call stack |
| Dual registry (`SessionStore` + `SessionInfo`) | Single `SessionRepository` + runtime owns live state | No sync bugs, one source of truth |
| Passthrough split across `SlashCommandChain` + `BackendLifecycleManager` | `BackendConnector` owns registration + interception; `SlashCommandService` delegates | Related logic co-located |
| `ReconnectController`/`IdleSessionReaper` wire into events and act | Policy services observe and emit `PolicyCommand`s to runtime | Policies advise, they don't mutate |
| Implicit session status (inferred from `lastStatus`, `backendSession !== null`) | Explicit `LifecycleState` enum with state machine | Testable transitions, guard clauses, policy triggers |
| `UnifiedMessageRouter` (521L) does routing + reduction + team events + persistence | `SessionRuntime` coordinates; `ConsumerProjector` (pure) + `StateReducer` (pure) do the work | Pure functions independently testable |

### Non-Negotiable Parity Invariants

The refactor must preserve these recently-fixed behaviors from `origin/main`:

1. **`status_change` metadata parity**  
   Preserve metadata passthrough for step/retry/plan fields and keep null/undefined filtering behavior unchanged.

2. **Adapter teardown parity on shutdown**  
   Preserve adapter-level cleanup through `AdapterResolver.stopAll?.()` / `BackendAdapter.stop?.()` so shutdown and tests do not leave orphan adapter-managed processes.

### What Stays the Same

| Module | Reason |
|--------|--------|
| `InboundNormalizer` (T1) | Already pure, well-scoped |
| `ConsumerMessageMapper` (T4) | Already pure, well-scoped (wrapped by `ConsumerProjector`) |
| `SessionStateReducer` | Already pure, no side effects |
| `BackendAdapter` + `BackendSession` | Clean async iterable contract; `stop?()` / `stopAll?()` align with `BackendConnector.stopAdapters()` |
| `ConsumerGatekeeper` | Well-scoped auth + RBAC (used by `ConsumerGateway`) |
| `MessageTracer` | Cross-cutting concern, injected into runtime |
| `GitInfoTracker` | Small utility, called by runtime on `session_init` and `result` |
| `TeamToolCorrelationBuffer` | Per-session buffer, owned by runtime |

---

## Migration Strategy

This is a significant refactor. A phased approach minimizes risk, with each phase
independently shippable and testable.

### Phase 0: Preparation (low risk)

1. Add comprehensive characterization tests for all current behaviors
2. Ensure test coverage for `SessionBridge.routeConsumerMessage()` (all 14 inbound types)
3. Ensure test coverage for `UnifiedMessageRouter.route()` (all 12 outbound types)
4. Add explicit parity tests for:
   - `status_change` metadata passthrough + null/undefined filtering
   - adapter shutdown cleanup (`stopAll`/`stop`) with no orphan processes
5. These tests become the safety net for all subsequent phases

### Phase 1: DomainEventBus (low risk, high payoff)

1. Introduce `DomainEventBus` alongside existing `TypedEventEmitter`
2. Introduce `DomainEvent` union type in `src/core/interfaces/domain-events.ts`
3. Have `SessionManager` publish to **both** the old emitter and new bus
4. Migrate external subscribers one at a time to `bus.on(...)`
5. Remove old emitter forwarding once all subscribers migrate
6. **Checkpoint:** all existing tests pass, event flow simplified

### Phase 2: Explicit Lifecycle State Machine (low risk)

1. Add `LifecycleState` enum to `Session`
2. Add `transitionTo()` method that validates transitions
3. Derive `lastStatus` from lifecycle state (backward compat)
4. Migrate status checks to use lifecycle state
5. **Checkpoint:** state transitions are explicit, old status still works

### Phase 3: Command/Event Separation (medium risk)

1. Define `InboundCommand` and `PolicyCommand` types
2. Extract `SessionRuntime` class wrapping a `Session` — initially just a thin facade
3. Route inbound messages through `runtime.handleInboundCommand()` instead of
   `SessionBridge.routeConsumerMessage()`
4. Route backend messages through `runtime.handleBackendMessage()` instead of
   `UnifiedMessageRouter.route()`
5. **Checkpoint:** runtime is the sole entry point for state mutations;
   old modules still exist but delegate to runtime

### Phase 4: Extract Transport Modules (medium risk)

1. Extract `ConsumerGateway` from `ConsumerTransportCoordinator` + `SessionTransportHub`
2. Extract `BackendConnector` from `BackendLifecycleManager` + `SessionTransportHub`
3. Co-locate passthrough registration + interception in `BackendConnector`
4. Extract `SlashCommandService` from `SlashCommandChain`
5. **Checkpoint:** transport modules emit commands, runtime handles them

### Phase 5: Extract Policies (low risk)

1. Refactor `ReconnectController` → `ReconnectPolicy` (observe + advise)
2. Refactor `IdleSessionReaper` → `IdlePolicy` (observe + advise)
3. Refactor `CapabilitiesProtocol` → `CapabilitiesPolicy` (observe + advise)
4. **Checkpoint:** policies no longer mutate state directly

### Phase 6: Registry Merge + Repository (medium risk)

1. Introduce `SessionRepository` backed by existing `FileStorage`
2. Change persistence to use snapshots instead of live object references
3. Merge `SessionStore` fields into `SessionRuntime`
4. Migrate `ClaudeLauncher` process state into `SessionRuntime`
5. Remove `SessionStore` and launcher-side `SessionInfo` registry
6. **Checkpoint:** single source of truth, no dual-registry sync

### Phase 7: Coordinator Merge (medium risk, do last)

1. Merge `SessionManager` into `SessionCoordinator`
2. Remove `SessionBridge` (all its logic now lives in `SessionRuntime` + extracted modules)
3. Update composition root (`bin/beamcode.ts`) to construct new module graph
4. **Checkpoint:** final architecture in place

### Phase 8: Cleanup

1. Remove dead types (`BridgeEventMap`, `LauncherEventMap`, `SessionManagerEventMap`)
2. Remove callback types (`EmitEvent`, `PersistSession`, `EmitBridgeEvent`)
3. Update all imports
4. Run full test suite + e2e tests
5. Update architecture documentation
