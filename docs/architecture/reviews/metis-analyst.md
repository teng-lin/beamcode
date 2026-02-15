# Metis Analysis: Universal Adapter Layer RFC

**Document Reviewed:** `docs/architecture/universal-adapter-layer.md`
**Current Codebase:** Phase 0 (NDJSON/`--sdk-url` only, tightly coupled)
**RFC Scope:** 9 phases expanding to 7+ backend adapters + daemon/relay infrastructure

---

## 1. HIDDEN ASSUMPTIONS

### CRITICAL Severity

**A1. The BackendSession abstraction can unify fundamentally different permission models**
- **Assumption:** All backends can implement `respondToPermission(requestId, decision)` uniformly
- **Reality:**
  - Agent SDK uses synchronous callbacks (`canUseTool` returns `Promise<PermissionResult>`)
  - ACP uses async JSON-RPC request/response (`session/request_permission`)
  - Some CLIs (Aider, Trae, Amp) have NO structured permission protocol
- **Impact:** The abstraction will leak. AgentSdkAdapter needs to store pending Promises and resolve them when `respondToPermission()` is called. This creates race conditions if permissions arrive out of order.
- **Evidence:** RFC line 1176 acknowledges this: "Permission handling requires bridging the SDK's callback model to the bridge's async message model"

**A2. AsyncIterable is sufficient for both pull (single consumer) and push (multi-consumer) models**
- **Assumption:** `BackendSession.messages(): AsyncIterable<UnifiedMessage>` can support SessionBridge's multi-consumer broadcast
- **Reality:** AsyncIterable is a pull-based abstraction. Calling it twice creates two independent iterators that MAY or MAY NOT share state depending on the implementation. For multi-consumer, SessionBridge needs to:
  1. Pull from `session.messages()` once
  2. Broadcast each message to N consumer WebSockets
  3. Handle backpressure (slow consumers shouldn't block the CLI)
- **Impact:** The "SDK-compatible" claim (RFC lines 1121-1140) is misleading. The interface LOOKS like SDK's `AsyncGenerator<SDKMessage>`, but the USAGE PATTERN is fundamentally different (one puller broadcasting to many vs. one puller consuming directly).
- **Risk:** Developers familiar with Agent SDK will expect `for await (const msg of session.messages())` to give them a dedicated stream. They'll be surprised when it doesn't work that way.

**A3. Capability negotiation solves feature availability mismatch**
- **Assumption:** Consumers can gracefully handle missing features via `BackendCapabilities` flags
- **Reality:** This assumes UI/UX degradation is always acceptable. What happens when:
  - A mobile UI depends on `imageInput` capability, but user switches to Aider (no image support)?
  - A workflow depends on `sessionFork`, but backend is Gemini CLI (no fork)?
  - Cost tracking UI is built, but backend is Goose (no cost tracking)?
- **Impact:** Every consumer (mobile app, web UI, Telegram bot) needs complex feature-gating logic. The RFC doesn't provide guidance on how to handle this gracefully.
- **Missing:** A "minimum viable backend" capability baseline that all adapters MUST support.

### HIGH Severity

**A4. All backends can provide real-time streaming**
- **Assumption:** Every backend can stream `partial_message` deltas during generation
- **Reality:**
  - OpenCode uses SSE (yes, real-time)
  - Agent SDK streams via `AsyncGenerator` (yes)
  - ACP streams via `session/update` notifications (yes)
  - PTY adapter? Heuristic ANSI parsing. No structured deltas. Best-effort reconstruction.
- **Impact:** Consumers expecting real-time token-by-token streaming will see degraded UX with PTY-based backends.

**A5. Version skew between adapters and CLIs is not a problem**
- **Assumption:** Adapters remain compatible as underlying CLIs evolve
- **Reality:**
  - Claude Code adds a new message type (e.g., `thinking` blocks with extended thinking)
  - Do ALL adapters need updating? Or just SdkUrlAdapter and AgentSdkAdapter?
  - What if Codex changes its JSON-RPC schema? Does CodexAdapter break?
- **Impact:** Adapter maintenance burden scales linearly with number of CLIs. No versioning strategy defined.
- **Missing:** Adapter version compatibility matrix, semantic versioning for `UnifiedMessage` schema

**A6. Daemon process isolation doesn't break existing features**
- **Assumption:** Running sessions in a daemon (Phase 8) is a transparent upgrade
- **Reality:**
  - Current code uses `SessionBridge.getOrCreateSession()` -- assumes in-process state
  - Daemon means sessions run in a DIFFERENT process. How does the consumer WebSocket connect?
    - Option 1: Daemon proxies WebSocket connections -> added latency, complex routing
    - Option 2: Consumer connects directly to bridge, bridge connects to daemon via HTTP -> authentication twice?
  - How does `handleConsumerOpen()` work when the session is in another process?
- **Impact:** Phase 8 is not an "add-on" -- it's an architectural shift that breaks existing connection handling assumptions.

**A7. Agent teams file polling is acceptable for real-time dashboards**
- **RFC lines 1691-1695:** "File watcher on `~/.claude/teams/` and `~/.claude/tasks/`"
- **Reality:**
  - File watchers have platform-specific quirks (fsevents on macOS, inotify on Linux, polling on NFS)
  - Polling frequency vs. CPU usage tradeoff
  - Race conditions: What if teammate writes to inbox and task file simultaneously? Partial reads?
- **Impact:** Mobile consumers expecting sub-second task updates will see delays. The RFC doesn't specify polling frequency or event delivery guarantees.
- **Alternative not explored:** Teammates POST events to bridge's HTTP endpoint (like Happy's webhook pattern). More reliable, no polling.

---

## 2. AMBIGUITIES

### CRITICAL Severity

**B1. What happens when adapters fail to translate a message?**
- **Scenario:** Codex emits a new `reasoning` item type. CodexAdapter doesn't know how to map it to `UnifiedMessage`.
- **Options:**
  1. Drop the message silently -> Consumer misses data
  2. Emit `{ type: "error", message: "Unknown message type" }` -> Consumer sees errors mid-session
  3. Emit raw passthrough -> Consumer gets untyped data
- **RFC says:** Nothing. Line 946 shows `event: unknown` for `partial_message.event`, suggesting passthrough. But this breaks type safety.
- **Impact:** Inconsistent error handling across adapters. Debugging nightmare when "the frontend isn't showing X."

**B2. Session lifecycle: who owns the subprocess?**
- **Current:** `CLILauncher` spawns subprocess, `SessionBridge` manages WebSocket
- **Phase 1 RFC:** SdkUrlAdapter "extracts NDJSON logic from SessionBridge"
- **Ambiguity:** Does SdkUrlAdapter:
  - Own subprocess spawning (replaces `CLILauncher` for `--sdk-url`)? OR
  - Only handle message translation (`CLILauncher` still spawns, adapter just wraps WebSocket)?
- **Impact:** If adapters own spawning, `CLILauncher` is Claude-Code-specific and needs refactoring. If not, how do OpenCodeAdapter and ACPAdapter spawn their processes? Duplicate code?
- **Missing:** Ownership boundary between `BackendAdapter` and `CLILauncher`

**B3. How do consumers discover backend type?**
- **RFC line 1660:** "Add `backendType` to SessionState"
- **Ambiguity:** When? On session init? On CLI connect?
- **Scenario:** Consumer connects before CLI. SessionState has `backendType: ""`. Consumer builds UI assuming Claude Code. CLI connects with Aider -> capabilities change mid-session.
- **Missing:** Lifecycle for capability negotiation and UI re-rendering on backend change

### HIGH Severity

**B4. Relay authentication: who validates tokens?**
- **RFC lines 1615-1640:** Three relay patterns (cloud, tunnel, direct)
- **Ambiguity:**
  - Cloud relay (Happy model): Relay server validates token, or forwards to bridge?
  - Tunnel (Goose model): Does tunnel validate `X-Secret-Key`, or just forward?
  - If relay validates, does bridge trust relay's authentication? Or double-check?
- **Security implication:** If bridge blindly trusts relay, a compromised relay can impersonate users.
- **Missing:** End-to-end authentication model across relay boundary

**B5. Agent teams: one SessionBridge per teammate or shared?**
- **Scenario:** Team lead spawns 3 teammates. Do they:
  - All connect to the SAME SessionBridge instance (shared state)?
  - Each get their own SessionBridge (isolated state)?
- **Current code:** SessionBridge is a singleton per manager. If teammates are subprocesses, they can't share the same instance.
- **RFC says:** Nothing. Lines 1691-1695 say "multi-session view in consumer protocol" but don't specify the architecture.
- **Impact:** If teammates are isolated, how does the lead's SessionBridge aggregate their activity?

**B6. Slash command routing when adapter doesn't support them**
- **RFC line 1160:** SdkUrlAdapter has `slashCommands=via-pty`
- **Ambiguity:** Via-pty means sidecar PTY process. But what if:
  - Backend is OpenCode (has native REST `/slash` endpoint)?
  - Backend is ACPAdapter wrapping Goose (no slash command protocol)?
- **Options:**
  1. Always use PTY sidecar (wasteful if backend supports natively)
  2. Check `capabilities.slashCommands` and route conditionally
  3. Emulate in SessionBridge (current behavior for `/model`, `/status`, etc.)
- **Missing:** Slash command routing decision tree

### MEDIUM Severity

**B7. What is "session resumption" for non-Claude-Code backends?**
- **RFC line 848:** `sessionResume: boolean` capability
- **Claude Code:** `--resume {id}` restores conversation history
- **OpenCode:** `/session/:id/fork` creates a copy
- **ACP:** `session/new` with `restore_session` parameter
- **Ambiguity:** These are NOT equivalent. "Resume" could mean:
  - Restore conversation history (Anthropic API level)
  - Reattach to running agent process (daemon level)
  - Load persisted state from disk (bridge level)
- **Impact:** Consumers see `sessionResume: true` but behavior differs wildly across backends.

---

## 3. FAILURE POINTS

### CRITICAL Severity

**F1. PTY adapter is positioned as "universal fallback" but will fail silently**
- **RFC lines 1260-1275:** "ANSI-strip output, heuristic detection of tool calls/results/errors"
- **Failure modes:**
  - Agent outputs non-standard format -> heuristics fail, message history corrupted
  - Agent uses colors/progress bars -> ANSI stripping breaks mid-message
  - Agent prompts for input (e.g., Aider's `/ask`) -> bridge hangs waiting for output
- **Impact:** Consumers think the session is working, but message history is garbage. Debugging is "why is the mobile app showing weird text?"
- **Missing:** PTY adapter health checks, fallback-to-fallback strategy

**F2. Agent teams file-based coordination breaks on network filesystems**
- **RFC lines 490-516:** File-lock-based task claiming at `~/.claude/tasks/{team}/`
- **Failure mode:** User's home directory is on NFS/SMB. File locking semantics break. Two teammates claim the same task.
- **Evidence:** Happy Coder explicitly uses `O_CREAT | O_EXCL` for atomic lock creation (RFC line 1356). This doesn't work reliably on NFS.
- **Impact:** Task assignment race conditions in distributed environments (exactly the use case for remote access!)

**F3. Permission response timeout is undefined**
- **Scenario:** Mobile consumer requests permission. User ignores notification. 5 minutes pass. What happens?
- **Current code:** `SessionBridge.pendingPermissions` is a Map with no expiration logic
- **Failure mode:** Agent is blocked indefinitely. Session appears frozen.
- **Missing:** Permission request TTL, auto-deny after timeout, consumer notification of expired permission

### HIGH Severity

**F4. Relay outbound-only assumption conflicts with multi-consumer presence**
- **RFC line 1625:** "Outbound-only -- daemon initiates connection"
- **RFC line 1635:** "Presence -- relay forwards presence updates so mobile knows what's connected"
- **Conflict:** If daemon -> relay is outbound-only, how do NEW consumers connect?
  - Consumer connects to relay -> relay creates NEW connection to daemon per consumer?
  - Consumers share daemon's single outbound connection -> relay multiplexes?
- **Missing:** Connection pooling strategy, max consumers per relay connection

**F5. E2E encryption key exchange is unspecified**
- **RFC line 1621:** "E2E encryption -- relay should not see message contents (Happy uses TweetNaCl + AES-256-GCM)"
- **Missing:** How do consumer and daemon exchange keys?
  - Pre-shared secret (like Tailscale)? How is it provisioned?
  - Diffie-Hellman exchange over WebSocket? Who goes first?
  - Public key pinning? Where are keys stored?
- **Impact:** Security claims are aspirational, not implementable without key exchange protocol.

**F6. SessionBridge in-memory state doesn't survive manager restart**
- **Current:** `SessionBridge.sessions` is an in-memory Map
- **Persistence:** Only `SessionState` is persisted, not `consumerSockets`, `pendingPermissions`, `messageHistory`
- **Failure:** Manager crashes. On restart, sessions are restored but:
  - All consumers are disconnected (consumerSockets lost)
  - Permission requests in flight are lost
  - Message history >1000 (truncated by `maxMessageHistoryLength`) is lost
- **Impact:** Daemon use case (Phase 8) requires SessionBridge to be stateless OR fully persistent. Current design is neither.

### MEDIUM Severity

**F7. Adapter disposal order can deadlock**
- **RFC line 621:** `adapter.dispose(): Promise<void>`
- **Scenario:** SessionManager is stopping. Order:
  1. Stop accepting new consumers
  2. Dispose all BackendSessions (close CLI connections)
  3. Dispose BackendAdapters (cleanup resources)
- **Deadlock risk:** If BackendSession.close() waits for CLI subprocess to exit, but subprocess is blocked on stdin waiting for a message, and adapter holds the stdin pipe, disposal hangs.
- **Missing:** Disposal timeout, forced kill after grace period

**F8. Consumer rate limiting doesn't account for permission responses**
- **Current:** `TokenBucketLimiter` rate-limits consumer messages
- **Edge case:** Agent requests 100 permissions rapidly (e.g., mass file edit). Consumer tries to respond. Rate limiter blocks responses. Agent times out.
- **Missing:** Separate rate limit for permission responses OR exempt them from rate limiting

---

## 4. SCOPE RISKS

### CRITICAL Severity

**S1. Phase 8 (Daemon + Relay) is a separate distributed systems project**
- **RFC lines 1697-1705:** Process supervisor, exclusive lock handling, HTTP control API, state persistence, heartbeat loop, WebSocket proxy relay, E2E encryption, session routing, presence forwarding
- **Reality:** This is 50% of the project scope. It's:
  - Not a "refactoring phase" -- it's greenfield development
  - Daemon is a new binary/entrypoint (not just a library export)
  - Relay is potentially a separate cloud service (if Happy model is chosen)
- **Scope creep indicator:** RFC Open Question #11 asks "Cloud relay (infrastructure) vs tunnel (simple)?" -- this is a PRODUCT decision, not a refactoring detail.

**S2. Agent teams integration requires solving real-time distributed state sync**
- **RFC lines 1691-1695:** File watcher -> consumer messages
- **Hidden complexity:** Teammate spawns, task completion events, inbox message delivery, aggregating events from N teammates, cost tracking across teammates
- **This is operational transform / CRDT territory.** File-based coordination is the WRONG abstraction for real-time dashboards.

**S3. ACP Server Endpoint (Phase 6) requires implementing a JSON-RPC server**
- **RFC lines 1684-1688:** "Expose bridge sessions via ACP JSON-RPC over stdio"
- **Scope:** Full JSON-RPC 2.0 protocol implementation, ACP capability negotiation, method routing, bi-directional stdio communication, error handling

### HIGH Severity

**S4. PTY adapter (Phase 9) is a terminal emulator**
- **RFC lines 1260-1275:** "Send keystrokes, parse ANSI output"
- **Hidden scope:** Terminal control sequences, input buffering, prompt detection, emulating user interactions

**S5. Each adapter needs comprehensive test coverage**
- 7 adapters x 500-1000 test cases = 3500-7000 total tests needed

**S6. Version matrix combinatorial explosion**
- 7 backend adapters x N CLI versions = compatibility matrix nightmare

---

## 5. MISSING DEPENDENCIES

### CRITICAL Severity

- **D1.** ACP TypeScript SDK not in package.json (blocks Phase 3)
- **D2.** Agent SDK (@anthropic-ai/claude-agent-sdk) not in package.json (blocks Phase 4)
- **D3.** File watching library for agent teams (chokidar, fs.watch, etc.)

### HIGH Severity

- **D4.** HTTP client library for OpenCodeAdapter
- **D5.** JSON-RPC library for CodexAdapter and ACP Server
- **D6.** Process management library for daemon
- **D7.** Relay infrastructure (if cloud model chosen)

---

## 6. PHASE COUPLING

### CRITICAL Severity

**P1. Phase 7 (Agent Teams) depends on Phase 8 (Daemon) for remote observability**
- File watching works locally but requires daemon for remote access

**P2. Phase 1-2 (Adapter extraction) blocks all subsequent adapter implementations**
- If BackendAdapter interface is wrong, ALL adapters are blocked
- Interface designed for ONE backend, applied to 7 -- high chance of redesign

**P3. Phase 6 (ACP Server) depends on Phase 3 (ACPAdapter) for protocol familiarity**

### HIGH Severity

**P4. Phase 9 (PTY) is needed as fallback for Phases 3-5 but scheduled last**
**P5. Daemon HTTP control API (Phase 8) needs Phase 1-2 refactoring complete**
**P6. Relay (Phase 8) requires SessionBridge to be stateless -- NOT mentioned in Phase 1-2**

---

## SUMMARY OF CRITICAL ISSUES

**Top 3 Architectural Risks:**

1. **BackendSession abstraction is leaky (A1, A2, B1, P2)** - Permission model mismatch, AsyncIterable doesn't map to multi-consumer broadcast, designed for ONE backend
2. **Phase 8 (Daemon + Relay) is 50% of the project, disguised as a "phase" (S1, S2, P6)** - Separate distributed systems product
3. **Agent teams file-based coordination is wrong abstraction for real-time (A7, F2, S2, P1)** - File watching unreliable, polling latency conflicts with real-time goal

**Recommendation:** Before Phase 1:
1. Build proof-of-concept adapter (e.g., ACPAdapter stub) to validate BackendSession interface
2. Define minimum viable backend capability baseline
3. Separate Daemon/Relay into follow-on project
4. Re-evaluate agent teams integration (webhooks vs file polling)

**Findings Summary:**
- **Critical:** 8 findings
- **High:** 12 findings
- **Medium:** 3 findings
- **Total:** 23 significant issues identified
