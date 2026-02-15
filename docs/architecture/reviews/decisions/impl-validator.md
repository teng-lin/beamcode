# Implementation Validator Report: Architecture Decisions vs Codebase Reality

## 1. Decision vs Code Reality

### Decision 1: Library First, Relay-Aware

**Claim**: "SessionBridge state must be serializable (no in-memory-only assumptions)"

**Reality**: **Partially True, with caveats.**

SessionBridge state *is already serializable* via `PersistedSession` (`src/types/session-state.ts:96-103`), which includes `SessionState`, `messageHistory`, `pendingMessages`, and `pendingPermissions`. The `FileStorage` adapter (`src/adapters/file-storage.ts`) already implements atomic writes with crash-safety (WAL pattern, fsync + rename).

**However**, the internal `Session` type (`src/core/session-bridge.ts:47-63`) contains **non-serializable fields** that are deliberately excluded from persistence:
- `cliSocket: WebSocketLike | null` — runtime socket reference
- `consumerSockets: Map<WebSocketLike, ConsumerIdentity>` — active consumer connections
- `consumerRateLimiters: Map<WebSocketLike, RateLimiter>` — rate limiter state
- `pendingInitialize` — timer references

This is intentional design — the bridge already separates "durable state" from "runtime ephemeral state." The relay-aware design would need to serialize *reconnection metadata* (which socket was which consumer), not the sockets themselves. **The current architecture actually supports this well** — adding `message_id`/`seq` to `ConsumerMessage` is additive.

**Claim**: "Consumer interface is abstract (not hardcoded to WebSocket Maps)"

**Reality**: **Mixed.** `WebSocketLike` (`src/interfaces/transport.ts:1-5`) is a minimal interface (`send`/`close` only), which is good abstraction. But `SessionBridge.consumerSockets` is a `Map<WebSocketLike, ConsumerIdentity>` — the bridge internally manages socket-to-identity mapping. For relay, you'd need a `ConsumerConnection` abstraction that wraps both local sockets and remote relay channels. This is a **moderate refactor**, not a trivial one.

**Claim**: "Auth interfaces designed for JWT/mutual TLS"

**Reality**: **YES, this is already done.** `Authenticator` interface (`src/interfaces/auth.ts:28-30`) takes `AuthContext` which has a transport-agnostic `Record<string, unknown>` metadata bag (`src/interfaces/auth.ts:21`). The default is `AnonymousAuthenticator` (via `createAnonymousIdentity` in `src/types/auth.ts:10-12`). A `JWTAuthenticator` could be plugged in today with zero changes to `SessionBridge`. **This claim is fully validated.**

---

### Decision 2: Adapter Priority — SdkUrl + ACP + AgentSDK

**Claim**: SdkUrlAdapter is the current implementation.

**Reality**: The current codebase **IS** the SdkUrl implementation, but it's not structured as an "adapter" in the proposed sense. The `--sdk-url` NDJSON/WebSocket protocol is deeply embedded into:
- `SessionBridge` — directly handles NDJSON parsing via `parseNDJSON<CLIMessage>` (`session-bridge.ts:329`)
- `CLILauncher` — directly constructs `--sdk-url ws://localhost:...` args (`cli-launcher.ts:246-248`)
- `CLIMessage` types — specific to Claude Code's NDJSON wire format (`cli-messages.ts`)

**The proposed `BackendAdapter` abstraction does NOT exist yet.** To extract a `SdkUrlAdapter`, you need to:
1. Define `BackendAdapter` / `BackendSession` interfaces (not yet created)
2. Extract CLI message parsing from `SessionBridge.routeCLIMessage` into an adapter
3. Move `CLILauncher` spawn logic into the adapter
4. Create a `UnifiedMessage` type that all adapters produce (separate from `CLIMessage`)

**This is a significant refactoring effort, not a "Phase 1" extraction.** The `routeCLIMessage` method (lines 730-766) has 12 message type handlers that each update `SessionState` — all of this logic is adapter-specific and needs extraction.

**Claim**: "NDJSON parsing is reusable"

**Reality**: **YES.** `parseNDJSON` and `NDJSONLineBuffer` in `src/utils/ndjson.ts` are already clean, generic utilities with no coupling to `CLIMessage` types. They use generics (`parseNDJSON<T>`). **These are truly reusable.** The coupling is in `SessionBridge.handleCLIMessage` which does `parseNDJSON<CLIMessage>` — that's where the adapter boundary should be.

---

### Decision 3: PTY Strategy — Composable Utility

**Reality**: **This is already partially implemented!** The codebase has:
- `PtyCommandRunner` (`src/adapters/pty-command-runner.ts`) — already a composable utility that spawns a PTY, handles trust prompts, types commands, and captures output
- `CommandRunner` interface (`src/interfaces/command-runner.ts`) — already abstracted
- `SlashCommandExecutor` (`src/core/slash-command-executor.ts`) — orchestrates emulation-first, PTY-fallback, with per-session serialization queues

The proposed `src/utils/pty-bridge/PtyBridge` maps directly to the existing `PtyCommandRunner`. The `AnsiParser` -> existing `stripAnsi` utility. The `PromptDetector` -> existing `hasTrustPrompt`/`hasBypassConfirm` functions.

**Assessment**: Decision 3 is **already 80% implemented**. The "composable utility" pattern is exactly what exists. What's missing is the sidecar concept (PTY running alongside an ACP adapter), but the building blocks are there.

---

### Decision 4: Mobile Readiness — Protocol Types Only

**Claim**: "Adding `message_id` and `seq` to ConsumerMessage costs near-zero effort"

**Reality**: **Mostly true, but more impactful than implied.**

The `ConsumerMessage` union type (`src/types/consumer-messages.ts`) has 18 variants. Adding `message_id`, `seq`, and `timestamp` as required fields to ALL variants means:
1. Every `broadcastToConsumers` and `sendToConsumer` call must inject these fields
2. `messageHistory` serialization grows by ~50 bytes per message x 1000 max history = ~50KB
3. A monotonic sequence counter must be maintained per session (new state in `Session`)
4. All existing tests that assert on `ConsumerMessage` payloads will need updating

It's not "near-zero" — it's a solid **2-3 day effort** including test updates, not the "1 week" budgeted for all of Decision 4's protocol types.

**The `reconnect` and `request_history` inbound message types** are truly zero-cost if defined as types only. Adding them to the `InboundMessage` union (`src/types/inbound-messages.ts`) with a `routeConsumerMessage` case that returns "not implemented" is trivial.

---

### Decision 5: Security Quick Wins

**Claim**: "WebSocket origin validation (1 day)"

**Reality**: **Accurate or even optimistic.**

Looking at `NodeWebSocketServer.listen()` (`src/adapters/node-ws-server.ts:51-105`), the `wss.on("connection")` handler receives `req` (the HTTP upgrade request). Adding origin validation means:
1. Read `req.headers.origin`
2. Compare against allowlist (localhost variants, configured origins)
3. Call `ws.close(4003, "Origin not allowed")` for rejects

This is literally ~15 lines of code. **1 day estimate is accurate if you include tests and docs.** The code structure makes this trivially insertable at line 64, before path matching.

**Claim**: "CLI auth tokens (1 week)"

**Reality**: **Realistic but slightly optimistic.**

The `CLILauncher.spawnCLI` method (`cli-launcher.ts:212-367`) already constructs the `--sdk-url` with full URL control (line 246-248). Adding `?token=SECRET` to the URL is ~5 lines. But the validation side requires:
1. Token generation and storage (per-session secret in `SdkSessionInfo`)
2. Token extraction in `NodeWebSocketServer` from the URL query string (already has URL parsing at line 89)
3. Token comparison before calling `onCLIConnection`
4. Timing-safe comparison to prevent timing attacks

The existing code already extracts query params for consumer connections (`Object.fromEntries(url.searchParams)` at line 95), but the CLI path handler (`CLI_PATH_RE` match) **strips the query string at line 67** before matching. Adding token validation for CLI connections requires restructuring the path matching slightly.

**Estimate: 3-5 days more realistic than "1 week" if scoped tightly.** The "relay-ready auth interfaces" (2 days) are already done as noted in Decision 1.

---

### Decision 6: Single Package, Directory Structure

**Claim**: Proposed directory structure with `core/`, `adapters/`, `utils/`, `server/`

**Reality**: The existing structure is:
```
src/
  core/          Exists (session-bridge, session-manager, cli-launcher, slash-command-executor)
  adapters/      Exists (but contains infra adapters: file-storage, node-ws-server, console-logger, etc.)
  interfaces/    Exists but NOT in proposed layout (proposed puts interfaces under core/)
  types/         Exists but NOT in proposed layout (proposed puts types under core/types/)
  utils/         Exists (ndjson, ansi-strip)
  testing/       Exists, not mentioned in proposed layout
  server/        Does NOT exist (proposed as new)
```

**Conflict**: The decision proposes `core/interfaces/` and `core/types/`, but these currently exist as top-level `interfaces/` and `types/` directories. The proposed layout also puts backend adapters (sdk-url, acp, agent-sdk) under `adapters/`, but the current `adapters/` directory contains **infrastructure adapters** (file-storage, node-ws-server, console-logger, token-bucket-limiter, etc.).

**This means**: Implementing Decision 6 requires either (a) moving interfaces/ and types/ under core/ (breaking ALL import paths), or (b) acknowledging that the proposed layout differs from what exists. The "server/" directory is new and maps to the current NodeWebSocketServer + SessionManager combo.

**Impact**: Moving directories is mechanically simple but touches **every import path** in the codebase. With 12,352 LOC across 56 .ts files, this is a 1-2 day refactor with high test-breakage risk.

---

## 2. Effort Validation

| Decision | Claimed Effort | Validated Effort | Gap |
|----------|---------------|-----------------|-----|
| Decision 1 (Relay-aware design) | +1-2 weeks | +2-3 weeks | Consumer connection abstraction is harder than implied |
| Decision 2 (BackendAdapter extraction) | Part of "10-12 weeks" | ~3 weeks for extraction alone | routeCLIMessage has 12 tightly-coupled handlers to extract |
| Decision 3 (PTY utility) | Included in adapter work | ~0 weeks (already done) | 80% complete, just needs packaging |
| Decision 4 (Mobile protocol types) | +1 week | +1 week | Accurate, if restricted to type-only additions |
| Decision 5 (Security quick wins) | +2 weeks | +2 weeks | Accurate in aggregate; individual items vary |
| Decision 6 (Package structure) | 0 (simplest) | 1-2 days if restructuring, 0 if keeping current layout | Depends on whether you actually reorganize |

**Total: 12-14 weeks claimed -> 14-18 weeks more realistic** (given BackendAdapter extraction complexity).

---

## 3. Hidden Refactoring Not Mentioned

### 3a. `SessionBridge.routeCLIMessage` decomposition
The `routeCLIMessage` method (45 lines) and its 12 handler methods (lines 730-953) are all adapter-specific logic for the `--sdk-url` NDJSON protocol. Extracting `SdkUrlAdapter` means moving ~400 lines of handler logic out of `SessionBridge` and into an adapter. The decisions document doesn't call this out explicitly.

### 3b. `SessionState` generalization
`SessionState` (`types/session-state.ts:17-53`) has fields specific to Claude Code's `--sdk-url` protocol: `claude_code_version`, `mcp_servers`, `agents`, `slash_commands`, `skills`, `permissionMode`. For ACP and AgentSDK adapters, many of these fields are meaningless. The `SessionState` type needs to become either (a) generic with adapter-specific extensions, or (b) split into `CoreSessionState + AdapterMetadata`. **Not mentioned in the decisions.**

### 3c. `CLILauncher` is tightly coupled to `--sdk-url`
The `CLILauncher` class constructs `--sdk-url` arguments, handles `--resume`, etc. For ACP (stdio JSON-RPC) or AgentSDK, the launch mechanism is completely different. Either:
- `CLILauncher` becomes `SdkUrlLauncher` (adapter-specific)
- A new `BackendLauncher` interface is needed
**Not mentioned in the decisions.**

### 3d. Import path migration
If Decision 6 is implemented as written (restructuring to `core/types/`, `core/interfaces/`), every file in the project needs import path updates. With 56 .ts files, this is non-trivial.

### 3e. `TypedEventEmitter` events need generalization
`BridgeEventMap` (`types/events.ts:11-63`) has events like `cli:connected`, `cli:disconnected` that assume a single CLI backend. Multi-adapter support means these become `backend:connected`, `backend:disconnected` with adapter-type metadata. **All event consumers need updating.**

---

## 4. Quick Wins Audit

### "WebSocket origin validation (1 day)" — **ACTUALLY QUICK**
15-20 lines in `node-ws-server.ts:64`. Access to `req.headers.origin` is already available via the `req` parameter. Allowlist comparison is trivial. **1 day including tests is realistic.**

### "CLI auth tokens (1 week)" — **MEDIUM**
Token generation: trivial (use `crypto.randomBytes`). URL injection: trivial. But the CLI path handler in `node-ws-server.ts` currently strips query params before matching (line 67: `const pathOnly = reqUrl.split("?")[0]`). The consumer path handler already extracts query params (line 89), but the CLI path handler needs similar treatment. **3-5 days is more realistic.**

### "Relay-ready auth interfaces (2 days)" — **ALREADY DONE**
`Authenticator` interface exists at `src/interfaces/auth.ts:28-30`. `AuthContext` has transport-agnostic metadata bag. `createAnonymousIdentity` provides the default. Plugging in `JWTAuthenticator` requires zero changes to `SessionBridge`. **This is 0 additional effort.**

---

## 5. Risk Assessment: Which Decision Hits Most Obstacles?

### **Highest Risk: Decision 2 (BackendAdapter Extraction)**

**Why**: The `SessionBridge` is the god object. It currently:
1. Parses NDJSON from CLI (protocol-specific)
2. Manages session state (generic)
3. Routes CLI messages to consumers (generic)
4. Handles permission workflows (protocol-specific to `--sdk-url`)
5. Manages consumer connections (generic)
6. Handles slash commands via emulation or PTY (feature-specific)

Extracting the "generic" from the "protocol-specific" requires a clean interface boundary that doesn't exist yet. The permission workflow in particular (lines 896-919) is deeply intertwined — `can_use_tool` is a `--sdk-url` control message that maps to a consumer-facing permission request. ACP handles permissions differently (if at all), and AgentSDK has no permission bridging.

**Abort trigger validation**: The decision says "If Phase 1 takes > 3 weeks, abstraction is wrong." Given the 12 handler methods in `routeCLIMessage` plus the permission workflow, **3 weeks is aggressive but achievable IF** the team accepts that the first cut won't be perfectly clean. If they want a pristine `BackendAdapter` interface that handles all edge cases, 3 weeks is very tight.

**Second highest risk**: Decision 2's ACP adapter. The decision says ACP covers "Goose, Kiro, Gemini CLI" — but ACP's JSON-RPC stdio protocol is fundamentally different from WebSocket NDJSON. The current codebase has zero stdio handling; everything goes through WebSocket. Adding stdio transport means a second transport path through `SessionBridge`, which the current architecture doesn't support.

---

## Summary

| Aspect | Assessment |
|--------|-----------|
| Architecture direction | Sound — the codebase already has good separation |
| Auth interfaces | Already relay-ready (Decision 5 item 3 is free) |
| PTY strategy | Already implemented (Decision 3 is 80% done) |
| BackendAdapter extraction | Biggest risk; `SessionBridge` needs major decomposition |
| Directory restructuring | Conflicts with current layout; needs explicit migration plan |
| Time estimates | ~15-20% optimistic overall; Decision 2 is the primary underestimate |
| Security quick wins | Origin validation is genuinely quick; tokens need 3-5 days |
| Mobile protocol types | Accurate if type-only; more effort if you add seq tracking |
| Hidden work | SessionState generalization, CLILauncher extraction, event map generalization not accounted for |
