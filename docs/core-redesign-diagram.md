# Core Redesign — Module Diagrams

> Companion to [core-redesign-proposal.md](./core-redesign-proposal.md)
> Updated: v3 aligned to `core-redesign-proposal.md` final review

## 1. Module Overview (After Refactoring)

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
│                       SessionCoordinator                                    │
│                          (~250 lines)                                       │
│                                                                             │
│  Global lifecycle — creates/destroys SessionRuntime instances               │
│  Reacts to domain events (relaunch, auto-name, process exit)                │
│  Owns the runtime map, NOT session state                                    │
└───┬──────────┬──────────┬──────────┬──────────┬─────────────────────────────┘
    │          │          │          │          │
    ▼          ▼          ▼          ▼          ▼
┌────────┐┌────────┐┌─────────┐┌─────────┐┌──────────────┐
│Session ││Domain  ││Consumer ││ Backend ││   Process    │
│Reposit.││EventBus││ Gateway ││Connector││  Supervisor  │
└────────┘└────────┘└─────────┘└─────────┘└──────────────┘
                         │          │
                         ▼          ▼
                    ┌──────────────────────────┐
                    │    SessionRuntime        │
                    │    (one per session)     │
                    │    SOLE STATE OWNER      │
                    └──────────────────────────┘
```

## 2. SessionRuntime — Internal Structure

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

## 3. Command/Event Flow — Separation of Concerns

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

## 4. DomainEventBus — Flat Pub/Sub (One Hop)

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

## 5. Inbound Data Flow (Consumer → Backend)

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

## 6. Outbound Data Flow (Backend → Consumers)

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
│  │ 3. DISPATCH (each handler is 3-8L)  │                        │
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

### T1/T2/T3/T4 Boundary Map (Preserved)

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

## 7. Session Lifecycle — State Machine

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

## 8. Policy Services — Observe and Advise Pattern

```
  ┌──────────────────────────────────────────────────────────────┐
  │                        Policy Pattern                         │
  │                                                               │
  │  Policies NEVER mutate state.                                 │
  │  They observe events and emit commands to the runtime.        │
  │                                                               │
  │  This replaces the current pattern where ReconnectController  │
  │  and IdleSessionReaper wire into event chains and directly    │
  │  call methods that mutate session state.                      │
  └──────────────────────────────────────────────────────────────┘

  ┌──────────────┐                    ┌───────────────┐
  │  Reconnect   │    observes        │               │
  │  Policy      │◀───────────────────│  DomainEvent  │
  │              │  lifecycle_changed │  Bus          │
  │  if state == │                    │               │
  │  "awaiting"  │    emits           │               │
  │  for too long│───────────────────▶│  PolicyCommand│
  │              │  reconnect_timeout │  → Runtime    │
  └──────────────┘                    └───────────────┘

  ┌──────────────┐                    ┌───────────────┐
  │  Idle        │    periodic scan   │               │
  │  Policy      │    of runtimes     │  SessionCoord │
  │              │◀───────────────────│  .runtimes    │
  │  if idle +   │                    │               │
  │  no consumers│    emits           │               │
  │  + timeout   │───────────────────▶│  PolicyCommand│
  │              │  idle_reap         │  → Runtime    │
  └──────────────┘                    └───────────────┘

  ┌──────────────┐                    ┌───────────────┐
  │  Capabilities│    observes        │               │
  │  Policy      │◀───────────────────│  DomainEvent  │
  │              │  backend:connected │  Bus          │
  │  if caps not │                    │               │
  │  received in │    emits           │               │
  │  timeout     │───────────────────▶│  PolicyCommand│
  │              │  capabilities_     │  → Runtime    │
  │              │  timeout           │               │
  └──────────────┘                    └───────────────┘
```

## 9. Current vs Proposed — Side by Side

```
 CURRENT (9 core modules, ~3600 lines)       PROPOSED (12 modules, ~2000 lines)
 ═══════════════════════════════════════      ══════════════════════════════════════

 ┌───────────────────┐                       ┌───────────────────┐
 │  SessionManager   │ 547L                  │ SessionCoordinator│ ~250L
 │  (facade + events │                       │ (global lifecycle │
 │   + process hooks)│                       │  + runtime map)   │
 └────────┬──────────┘                       └────────┬──────────┘
          │ wraps                                      │ creates
          ▼                                            ▼
 ┌───────────────────┐                       ┌───────────────────┐
 │  SessionBridge    │ 742L                  │  SessionRuntime   │ ~400L
 │  (central coord.  │────────────────────▶  │  (per-session     │
 │   + routing +     │                       │   SOLE STATE OWNER│
 │   T1 boundary)    │                       │   thin cmd handler│
 └─┬──┬──┬──┬──┬──┬──┘                       │   delegates to    │
   │  │  │  │  │  │                          │   pure functions) │
   │  │  │  │  │  │                          └───────────┬───────┘
   ▼  │  │  │  │  │                                      │
 ┌────┤  │  │  │  │         ┌────────────────────┐       │
 │Sess│  │  │  │  │         │ ConsumerGateway    │ ~200L │
 │Stor│  │  │  │  │         │ (WS transport only │       │
 │268L│  │  │  │  │    ──▶  │  no business logic │       │
 └────┘  │  │  │  │         │  emits InboundCmd) │       │
         │  │  │  │         └────────────────────┘       │
   ┌─────┘  │  │  │                                      │
   ▼        │  │  │         ┌────────────────────┐       │
 ┌────────┐ │  │  │         │ BackendConnector   │ ~300L │
 │Consumer│ │  │  │         │ (adapter lifecycle │       │
 │Transp. │ │  │  │    ──▶  │  + consumption loop│       │
 │Coord   │ │  │  │         │  + passthrough co- │       │
 │269L    │ │  │  │         │  located)          │       │
 └────────┘ │  │  │         └────────────────────┘       │
            │  │  │                                      │
   ┌────────┘  │  │         ┌───────────────────┐        │
   ▼           │  │         │ SlashCommandSvc    │ ~200L │
 ┌──────────┐  │  │         │ (one execute()     │       │
 │Backend   │  │  │    ──▶  │  entrypoint, all   │       │
 │Lifecycle │  │  │         │  strategies)       │       │
 │Manager   │  │  │         └────────────────────┘       │
 │553L      │  │  │                                      │
 └──────────┘  │  │         ┌───────────────────┐        │
               │  │         │ SessionRepository  │ ~200L │
   ┌───────────┘  │    ──▶  │ (snapshots, not   │        │
   ▼              │         │  live objects)     │       │
 ┌──────────┐     │         └────────────────────┘       │
 │Unified   │     │                                      │
 │Message   │     │         ┌───────────────────┐        │
 │Router    │     │    ──▶  │ ConsumerProjector  │ ~150L │
 │521L      │     │         │ (wraps existing T4 │       │
 └──────────┘     │         │  mapper + dedup)   │       │
                  │         └────────────────────┘       │
   ┌──────────────┘                                      │
   ▼                        ┌───────────────────┐        │
 ┌──────────────┐           │ DomainEventBus     │ ~80L  │
 │SessionTransp.│      ──▶  │ (flat typed pub/sub│       │
 │Hub 142L      │           │  replaces 3-hop)   │       │
 └──────────────┘           └────────────────────┘       │
                                                         │
 ┌──────────────┐           ┌────────────────────┐       │
 │Consumer      │      ──▶  │ OutboundPublisher  │ ~150L │
 │Broadcaster   │           │ (broadcast +       │       │
 │144L          │           │  replay + presence)│       │
 └──────────────┘           └────────────────────┘       │
                                                         │
 ┌──────────────┐           ┌────────────────────┐       │
 │SlashCommand  │      ──▶  │ Policy services    │ ~220L │
 │Chain 378L    │           │ •ReconnectPolicy   │       │
 └──────────────┘           │ •IdlePolicy        │       │
                            │ •CapabilitiesPolicy│       │
 ┌──────────────┐           │ (observe + advise) │       │
 │Reconnect     │      ──▶  └────────────────────┘       │
 │Controller 59L│                                        │
 └──────────────┘                                        │
 ┌──────────────┐                                        │
 │IdleSession   │                                        │
 │Reaper 77L    │                                        │
 └──────────────┘                                        │

 UNCHANGED (pure functions + small utilities):
 ├── InboundNormalizer (T1)      125L  ─── kept as-is
 ├── ConsumerMessageMapper (T4)  345L  ─── wrapped by ConsumerProjector
 ├── SessionStateReducer         256L  ─── kept as-is
 ├── ConsumerGatekeeper          139L  ─── used by ConsumerGateway
 ├── GitInfoTracker               83L  ─── called by runtime
 ├── TeamToolCorrelationBuffer         ─── owned by runtime
 ├── MessageTracer               632L  ─── injected into runtime
 └── BackendAdapter interface          ─── kept (with stop?())
```

### Non-Negotiable Parity Invariants

```
1) status_change metadata parity
   - Preserve metadata passthrough for step/retry/plan fields.
   - Preserve null/undefined metadata filtering behavior.

2) adapter teardown parity on shutdown
   - Preserve AdapterResolver.stopAll?.() / BackendAdapter.stop?.() flow.
   - No orphan adapter-managed processes after shutdown/test teardown.
```

## 10. File Layout (Proposed)

```
src/core/
├── session-coordinator.ts        NEW   — global lifecycle + runtime map (~250L)
├── session-runtime.ts            NEW   — per-session state owner (~400L)
├── domain-events.ts              NEW   — DomainEvent union + DomainEventBus (~80L)
├── commands.ts                   NEW   — InboundCommand, BackendEvent, PolicyCommand types
├── lifecycle-state.ts            NEW   — LifecycleState enum + transition validator
│
├── transport/
│   ├── consumer-gateway.ts       NEW   — WS accept/reject/message, emits commands (~200L)
│   ├── backend-connector.ts      NEW   — adapter lifecycle + consumption + passthrough (~300L)
│   └── outbound-publisher.ts     REFACTORED — broadcast + replay + presence (~150L)
│
├── services/
│   ├── slash-command-service.ts   NEW   — one execute() entrypoint (~200L)
│   └── consumer-projector.ts      NEW   — wraps T4 mapper + dedup logic (~150L)
│
├── policy/
│   ├── reconnect-policy.ts       REFACTORED — observe + advise (~60L)
│   ├── idle-policy.ts            REFACTORED — observe + advise (~80L)
│   └── capabilities-policy.ts    REFACTORED — observe + advise (~80L)
│
├── persistence/
│   └── session-repository.ts     NEW   — snapshot persistence (~200L)
│
├── consumer-gatekeeper.ts        KEPT  — auth + RBAC + rate limiting (~139L)
├── session-state-reducer.ts      KEPT  — pure reducer (~256L)
├── consumer-message-mapper.ts    KEPT  — pure T4 mapper (~345L)
├── inbound-normalizer.ts         KEPT  — pure T1 mapper (~125L)
├── git-info-tracker.ts           KEPT  — git resolution (~83L)
├── message-tracer.ts             KEPT  — debug tracing (~632L)
├── team-tool-correlation.ts      KEPT  — team tool pairing
│
├── DELETED:
│   ├── session-manager.ts        ──▶ replaced by session-coordinator.ts
│   ├── session-bridge.ts         ──▶ split into session-runtime.ts + extracted modules
│   ├── backend-lifecycle-manager.ts ──▶ merged into backend-connector.ts
│   ├── unified-message-router.ts ──▶ logic moved into session-runtime.ts outbound handler
│   ├── consumer-transport-coordinator.ts ──▶ merged into consumer-gateway.ts
│   ├── session-transport-hub.ts  ──▶ split into consumer-gateway + backend-connector
│   ├── session-store.ts          ──▶ session state moved into session-runtime.ts
│   ├── slash-command-chain.ts    ──▶ refactored into slash-command-service.ts
│   ├── reconnect-controller.ts   ──▶ refactored into reconnect-policy.ts
│   ├── idle-session-reaper.ts    ──▶ refactored into idle-policy.ts
│   ├── capabilities-protocol.ts  ──▶ refactored into capabilities-policy.ts
│   └── message-queue-handler.ts  ──▶ queue logic absorbed into session-runtime.ts
│
└── interfaces/
    ├── backend-adapter.ts        KEPT
    ├── adapter-resolver.ts       KEPT
    ├── domain-events.ts          NEW  — DomainEvent type, DomainEventBus interface
    └── commands.ts               NEW  — InboundCommand, PolicyCommand types
```
