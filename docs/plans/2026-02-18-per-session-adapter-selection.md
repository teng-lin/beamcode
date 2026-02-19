# Per-Session Adapter Selection — Merged Implementation Plan (v3)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow each BeamCode session to use a different backend adapter (Claude Code, Codex, ACP), selected at session creation time from the web UI or API.

**Architecture:** Extract a `SessionLauncher` interface (from the Generic SessionManager Design RFC) as the type foundation, then introduce `createAdapterResolver` for per-session adapter routing. `BackendLifecycleManager` resolves the adapter per-session. Non-SdkUrl sessions are registered in the launcher's session map (transitional — replaced when per-backend launchers land).

**Tech Stack:** TypeScript, Node.js, React 19, Zustand 5, Zod, Vitest

**Source plans:**
- `docs/plans/2026-02-18-per-session-adapter-selection.md` (v2, reviewed by momus + oracle)
- `docs/plans/2026-02-18-generic-session-manager-design.md` (draft)

**Review consensus:** Six independent reviewers (Claude, Codex ×2, Gemini ×2, Oracle, Momus, Security, Code-Explorer) agreed: extract `SessionLauncher` interface first, then build per-session selection on top.

---

## Review Findings Incorporated in v3

| Finding | Severity | Fix | Source |
|---------|----------|-----|--------|
| Lazy SdkUrlAdapter init breaks CLI handler when default is Codex | CRITICAL | Eagerly resolve sdk-url in `createAdapterResolver` | Oracle, Momus, Codex |
| LauncherEventMap wrong payload + missing events | CRITICAL | Reuse existing `LauncherEventMap` from `src/types/events.ts` | Momus, Explorer, Codex |
| wireEvents calls `setCLISessionId` not `setBackendSessionId` | CRITICAL | Update wireEvents in Task 5 | Momus, Explorer, Codex |
| Wrong import path `typed-event-emitter` → `typed-emitter` | HIGH | Fixed | Explorer, Momus, Codex |
| `LaunchOptions` name collision with `session-state.ts` | HIGH | Renamed to `SessionLaunchInput` | Momus |
| SdkUrlLauncher extends ProcessSupervisor, not TypedEventEmitter | HIGH | Keep extends, add implements | Explorer |
| Unsafe cast `adapterName as CliAdapterName` | HIGH | Runtime validation added | Security, Momus |
| State restore for non-SdkUrl sessions appears "connected" | HIGH | Added post-restore reconnect logic | Oracle |
| Orphaned sessions on connect failure | HIGH | Rollback on failure in `createSession` | Codex |
| API response hardcodes `state: "connected"` for sdk-url | MEDIUM | Return actual state from launcher | Codex |
| `launch()` return type too narrow for API | MEDIUM | Return `SdkSessionInfo` from interface | Explorer |
| Existing `EmptyState.tsx` component conflict | MEDIUM | Modify existing component | Momus |
| Integration test only retests resolver | MEDIUM | Added create/delete lifecycle tests | Momus, Codex |

---

## Key Design Decisions

### D1: SdkUrlAdapter is singleton, others are fresh per-session

`SdkUrlAdapter` contains a `SocketRegistry` — the rendezvous point where `connect()` registers a pending socket and `deliverSocket()` resolves it when the CLI connects back. The resolver caches the single SdkUrlAdapter instance while creating fresh Codex/ACP adapters per session (they hold only per-session state).

**IMPORTANT:** The SdkUrlAdapter is eagerly constructed during resolver creation to ensure the WebSocket CLI handler always has access, even when the default adapter is non-inverted (e.g., Codex).

### D2: SessionLauncher interface before per-session routing

Rather than bolting `registerExternalSession` onto `SdkUrlLauncher` first, we extract a `SessionLauncher` interface that `SdkUrlLauncher` implements. This gives `SessionManager` a clean type boundary. Non-SdkUrl sessions still register in the launcher's map (pragmatic), but the type is generic — when per-backend launchers arrive (Codex, Gemini, opencode), they implement `SessionLauncher` and own their own session maps.

### D3: WebSocket CLI handler is always enabled

`SessionManager.start()` currently gates the inverted connection handler on the global adapter being inverted. We change it to use the resolver's eagerly-created `SdkUrlAdapter`, so SdkUrl sessions created from the UI work even when the default adapter is Codex.

### D4: `set_adapter` WS message becomes an error for active sessions

Adapter is immutable per-session. The existing `set_adapter` handler in `routeConsumerMessage` becomes an explicit error response instead of a silent no-op.

---

## Phase 1A: Adapter Resolution Infrastructure (Tasks 1-4)

### Task 1: Create adapter resolver with eager SdkUrlAdapter singleton

**Files:**
- Create: `src/adapters/adapter-resolver.ts`
- Test: `src/adapters/__tests__/adapter-resolver.test.ts`

**Step 1: Write the failing test**

```ts
// src/adapters/__tests__/adapter-resolver.test.ts
import { describe, expect, it, vi } from "vitest";
import { createAdapterResolver } from "../adapter-resolver.js";

describe("createAdapterResolver", () => {
  const mockDeps = {
    processManager: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  };

  it("resolves sdk-url adapter", () => {
    const resolver = createAdapterResolver(mockDeps);
    const adapter = resolver.resolve("sdk-url");
    expect(adapter.name).toBe("sdk-url");
  });

  it("resolves codex adapter", () => {
    const resolver = createAdapterResolver(mockDeps);
    const adapter = resolver.resolve("codex");
    expect(adapter.name).toBe("codex");
  });

  it("resolves acp adapter", () => {
    const resolver = createAdapterResolver(mockDeps);
    const adapter = resolver.resolve("acp");
    expect(adapter.name).toBe("acp");
  });

  it("uses specified default when name is undefined", () => {
    const resolver = createAdapterResolver(mockDeps, "codex");
    const adapter = resolver.resolve(undefined);
    expect(adapter.name).toBe("codex");
  });

  it("falls back to sdk-url when no default specified", () => {
    const resolver = createAdapterResolver(mockDeps);
    const adapter = resolver.resolve(undefined);
    expect(adapter.name).toBe("sdk-url");
  });

  it("returns same SdkUrlAdapter instance (singleton)", () => {
    const resolver = createAdapterResolver(mockDeps);
    const a1 = resolver.resolve("sdk-url");
    const a2 = resolver.resolve("sdk-url");
    expect(a1).toBe(a2);
  });

  it("returns fresh Codex instances (not singleton)", () => {
    const resolver = createAdapterResolver(mockDeps);
    const a1 = resolver.resolve("codex");
    const a2 = resolver.resolve("codex");
    expect(a1).not.toBe(a2);
  });

  it("eagerly creates sdkUrlAdapter on construction", () => {
    const resolver = createAdapterResolver(mockDeps);
    // SdkUrlAdapter is created eagerly, not lazily
    expect(resolver.sdkUrlAdapter).not.toBeNull();
    expect(resolver.sdkUrlAdapter?.name).toBe("sdk-url");
  });

  it("throws for unknown adapter name", () => {
    const resolver = createAdapterResolver(mockDeps);
    expect(() => resolver.resolve("bogus" as any)).toThrow();
  });

  it("returns available adapter names", () => {
    const resolver = createAdapterResolver(mockDeps);
    expect(resolver.availableAdapters).toEqual(["sdk-url", "codex", "acp"]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/__tests__/adapter-resolver.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```ts
// src/adapters/adapter-resolver.ts
import type { BackendAdapter } from "../core/interfaces/backend-adapter.js";
import type { SdkUrlAdapter } from "./sdk-url/sdk-url-adapter.js";
import {
  type CliAdapterName,
  CLI_ADAPTER_NAMES,
  type CreateAdapterDeps,
  createAdapter,
} from "./create-adapter.js";

export interface AdapterResolver {
  resolve(name?: CliAdapterName): BackendAdapter;
  /** The cached SdkUrlAdapter singleton (always available after construction). */
  readonly sdkUrlAdapter: SdkUrlAdapter;
  readonly defaultName: CliAdapterName;
  readonly availableAdapters: readonly CliAdapterName[];
}

export function createAdapterResolver(
  deps: CreateAdapterDeps,
  defaultName: CliAdapterName = "sdk-url",
): AdapterResolver {
  // SdkUrlAdapter MUST be singleton: its SocketRegistry is the rendezvous
  // point for inverted connections (CLI → BeamCode WebSocket callbacks).
  // Eagerly construct so the WebSocket CLI handler always has access,
  // even when the default adapter is non-inverted (e.g., Codex).
  const cachedSdkUrl = createAdapter("sdk-url", deps) as SdkUrlAdapter;

  return {
    resolve(name?: CliAdapterName): BackendAdapter {
      const resolved = name ?? defaultName;
      if (resolved === "sdk-url") {
        return cachedSdkUrl;
      }
      return createAdapter(resolved, deps);
    },
    get sdkUrlAdapter() {
      return cachedSdkUrl;
    },
    defaultName,
    availableAdapters: CLI_ADAPTER_NAMES,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapters/__tests__/adapter-resolver.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/adapters/adapter-resolver.ts src/adapters/__tests__/adapter-resolver.test.ts
git commit -m "feat: add createAdapterResolver with eager SdkUrlAdapter singleton"
```

---

### Task 2: Add `adapterName` to Session, SessionState, and SdkSessionInfo

**Files:**
- Modify: `src/types/session-state.ts` (SessionState, PersistedSession, SdkSessionInfo)
- Modify: `src/core/session-store.ts` (Session interface, createSession factory, persist/restore)
- Test: verify existing tests still pass

**Why:** Sessions need to know which adapter they use for: display, persistence/restore, and routing relaunch to the correct adapter.

**Step 1: Add `adapterName` to types**

In `src/types/session-state.ts`:

```ts
// Add to SessionState (after `team?` field, ~line 34):
/** Backend adapter name (e.g. "sdk-url", "codex", "acp"). */
adapterName?: string;

// Add to SdkSessionInfo (after `name?`, ~line 97):
adapterName?: string;

// Add to PersistedSession (after `archived?`, ~line 116):
adapterName?: string;
```

**Step 2: Add `adapterName` to Session interface and wire through store**

In `src/core/session-store.ts`:

```ts
// Add to Session interface (after `pendingPassthrough`):
/** Backend adapter name for this session. */
adapterName?: string;

// In createSession(), add to the returned object:
adapterName: undefined,

// In persist(), add to the saved object:
adapterName: session.adapterName,

// In restoreAll(), after creating the session, validate and restore:
if (p.adapterName) {
  // Validate against known adapter names before restoring
  session.adapterName = p.adapterName;
  session.state.adapterName = p.adapterName;
}
```

**Step 3: Run existing tests**

Run: `npx vitest run`
Expected: PASS (additive change, no breaks)

**Step 4: Commit**

```bash
git add src/types/session-state.ts src/core/session-store.ts
git commit -m "feat: add adapterName field to Session, SessionState, and SdkSessionInfo"
```

---

### Task 3: Add `setAdapterName` to SessionBridge

**Files:**
- Modify: `src/core/session-bridge.ts`

**Why:** Instead of reaching into the internal `Session` object and mutating fields directly (which breaks encapsulation and bypasses persistence), expose a proper method.

**Step 1: Add method to SessionBridge**

In `src/core/session-bridge.ts`, add in the "Session management" section (~line 141):

```ts
/** Set the adapter name for a session (persisted for restore). */
setAdapterName(sessionId: string, name: string): void {
  const session = this.getOrCreateSession(sessionId);
  session.adapterName = name;
  session.state.adapterName = name;
  this.persistSession(session);
}
```

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/core/session-bridge.ts
git commit -m "feat: add SessionBridge.setAdapterName() for encapsulated adapter assignment"
```

---

### Task 4: Refactor BackendLifecycleManager to resolve adapter per-session

**Files:**
- Modify: `src/core/backend-lifecycle-manager.ts`
- Modify: `src/core/session-bridge.ts` (constructor wiring)
- Create: `src/core/__tests__/backend-lifecycle-manager-adapter.test.ts`

**Why:** This is the core architectural change — `BackendLifecycleManager` stops holding a single adapter and instead resolves one per `connectBackend()` call using the session's `adapterName`.

**Step 1: Write the test**

```ts
// src/core/__tests__/backend-lifecycle-manager-adapter.test.ts
import { describe, expect, it, vi } from "vitest";
import { BackendLifecycleManager } from "../backend-lifecycle-manager.js";
import type { BackendAdapter, BackendSession } from "../interfaces/backend-adapter.js";
import type { AdapterResolver } from "../../adapters/adapter-resolver.js";

function mockAdapter(name: string): BackendAdapter {
  return {
    name,
    capabilities: { streaming: true, permissions: true, slashCommands: false, availability: "local", teams: false },
    connect: vi.fn().mockResolvedValue({
      sessionId: "test-session",
      send: vi.fn(),
      sendRaw: vi.fn(),
      messages: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as BackendSession),
  };
}

function mockResolver(adapters: Record<string, BackendAdapter>): AdapterResolver {
  const sdkUrl = adapters["sdk-url"] ?? mockAdapter("sdk-url");
  return {
    resolve: vi.fn((name) => {
      const resolved = name ?? "sdk-url";
      const adapter = adapters[resolved];
      if (!adapter) throw new Error(`Unknown adapter: ${resolved}`);
      return adapter;
    }),
    sdkUrlAdapter: sdkUrl as any,
    defaultName: "sdk-url" as any,
    availableAdapters: ["sdk-url", "codex", "acp"] as any,
  };
}

describe("BackendLifecycleManager per-session adapter", () => {
  const baseDeps = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    metrics: null,
    broadcaster: { broadcast: vi.fn(), sendTo: vi.fn() } as any,
    routeUnifiedMessage: vi.fn(),
    emitEvent: vi.fn(),
  };

  it("resolves adapter from registry using session.adapterName", async () => {
    const codex = mockAdapter("codex");
    const resolver = mockResolver({ codex, "sdk-url": mockAdapter("sdk-url") });
    const blm = new BackendLifecycleManager({
      ...baseDeps,
      adapter: null,
      adapterResolver: resolver,
    });

    const session = {
      id: "s1",
      adapterName: "codex",
      backendSession: null,
      backendAbort: null,
      pendingMessages: [],
    } as any;

    await blm.connectBackend(session);
    expect(resolver.resolve).toHaveBeenCalledWith("codex");
    expect(codex.connect).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }));
  });

  it("falls back to global adapter when no adapterName", async () => {
    const globalAdapter = mockAdapter("sdk-url");
    const blm = new BackendLifecycleManager({
      ...baseDeps,
      adapter: globalAdapter,
      adapterResolver: null,
    });

    const session = {
      id: "s2",
      adapterName: undefined,
      backendSession: null,
      backendAbort: null,
      pendingMessages: [],
    } as any;

    await blm.connectBackend(session);
    expect(globalAdapter.connect).toHaveBeenCalled();
  });

  it("hasAdapter is true when registry is set", () => {
    const blm = new BackendLifecycleManager({
      ...baseDeps,
      adapter: null,
      adapterResolver: mockResolver({ "sdk-url": mockAdapter("sdk-url") }),
    });
    expect(blm.hasAdapter).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/__tests__/backend-lifecycle-manager-adapter.test.ts`
Expected: FAIL — `adapterResolver` not in deps type

**Step 3: Update BackendLifecycleManager**

In `src/core/backend-lifecycle-manager.ts`:

```ts
// Add import at top:
import type { AdapterResolver } from "../adapters/adapter-resolver.js";
import { CLI_ADAPTER_NAMES, type CliAdapterName } from "../adapters/create-adapter.js";

// Update BackendLifecycleDeps — add adapterResolver:
export interface BackendLifecycleDeps {
  adapter: BackendAdapter | null;
  adapterResolver: AdapterResolver | null;
  logger: Logger;
  metrics: MetricsCollector | null;
  broadcaster: ConsumerBroadcaster;
  routeUnifiedMessage: (session: Session, msg: UnifiedMessage) => void;
  emitEvent: EmitEvent;
}

// Add field and update constructor:
private adapterResolver: AdapterResolver | null;

constructor(deps: BackendLifecycleDeps) {
  this.adapter = deps.adapter;
  this.adapterResolver = deps.adapterResolver;
  // ... rest unchanged
}

// Add resolver method with runtime validation:
private resolveAdapter(session: Session): BackendAdapter | null {
  if (session.adapterName && this.adapterResolver) {
    // Validate adapter name before resolving (defends against corrupted persisted data)
    if (!CLI_ADAPTER_NAMES.includes(session.adapterName as CliAdapterName)) {
      this.logger.warn(
        `Invalid adapter name "${session.adapterName}" on session ${session.id}, falling back to global`,
      );
      return this.adapter;
    }
    return this.adapterResolver.resolve(session.adapterName as CliAdapterName);
  }
  return this.adapter;
}

// Update hasAdapter:
get hasAdapter(): boolean {
  return this.adapter !== null || this.adapterResolver !== null;
}

// Update connectBackend — replace `this.adapter` references with resolved adapter:
async connectBackend(
  session: Session,
  options?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
): Promise<void> {
  const adapter = this.resolveAdapter(session);
  if (!adapter) {
    throw new Error("No BackendAdapter configured");
  }

  // Close any existing backend session
  if (session.backendSession) {
    session.backendAbort?.abort();
    await session.backendSession.close().catch(() => {});
  }

  const backendSession = await adapter.connect({
    sessionId: session.id,
    resume: options?.resume,
    adapterOptions: options?.adapterOptions,
  });

  session.backendSession = backendSession;
  // ... rest of method unchanged, replace this.adapter.name with adapter.name in logs
```

**Step 4: Wire through SessionBridge constructor**

In `src/core/session-bridge.ts`, update the constructor options and BackendLifecycleManager creation:

```ts
// Add import:
import type { AdapterResolver } from "../adapters/adapter-resolver.js";

// Update constructor options:
constructor(options?: {
  // ... existing fields
  adapter?: BackendAdapter;
  adapterResolver?: AdapterResolver;
}) {
  // ...
  this.backendLifecycle = new BackendLifecycleManager({
    adapter: options?.adapter ?? null,
    adapterResolver: options?.adapterResolver ?? null,
    // ... rest unchanged
  });
}
```

**Step 5: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
git add src/core/backend-lifecycle-manager.ts src/core/session-bridge.ts src/core/__tests__/backend-lifecycle-manager-adapter.test.ts
git commit -m "refactor: BackendLifecycleManager resolves adapter per-session via resolver"
```

---

## Phase 1B: SessionLauncher Interface (Task 5)

### Task 5: Extract SessionLauncher interface and refactor SessionManager

**Files:**
- Create: `src/core/interfaces/session-launcher.ts`
- Modify: `src/adapters/sdk-url/sdk-url-launcher.ts` (implement interface, rename setCLISessionId)
- Modify: `src/core/session-manager.ts` (accept SessionLauncher instead of SdkUrlLauncher, update wireEvents)
- Modify: `src/bin/beamcode.ts` (construct launcher externally)
- Test: verify all existing tests pass unchanged

**Why:** This is the type foundation from the Generic SessionManager Design. By extracting the interface that `SessionManager` actually uses from `SdkUrlLauncher`, we establish a clean boundary that future launchers (Codex, Gemini, opencode) can implement. This MUST be done before Task 6 (createSession) to avoid coupling non-SdkUrl sessions to SdkUrl internals.

**Step 1: Create the SessionLauncher interface**

IMPORTANT: Reuse the existing `LauncherEventMap` from `src/types/events.ts` (which has the correct payload shapes including `process:connected`, `process:resume_failed`, and `error`). Do NOT define a new event map. Reuse `LaunchOptions` from `src/types/session-state.ts`. Define only a new `SessionLaunchResult` type.

```ts
// src/core/interfaces/session-launcher.ts
import type { TypedEventEmitter } from "../typed-emitter.js";
import type { LauncherEventMap } from "../../types/events.js";
import type { SdkSessionInfo, LaunchOptions } from "../../types/session-state.js";

// Re-export for convenience
export type { LauncherEventMap, LaunchOptions };

export interface SessionLaunchResult {
  sessionId: string;
  cwd: string;
  pid?: number;
  state?: string;
  createdAt?: number;
  model?: string;
}

/**
 * Generic interface for session launchers.
 * Each backend (SdkUrl, Codex, Gemini, opencode) provides its own implementation.
 *
 * SdkUrlLauncher is the reference implementation. Forward-connection launchers
 * (Codex, Gemini) will implement this interface when they land.
 */
export interface SessionLauncher extends TypedEventEmitter<LauncherEventMap> {
  /** Create a new session and optionally spawn its process. */
  launch(options?: LaunchOptions): SdkSessionInfo;

  /** Kill and respawn a session's process. */
  relaunch(sessionId: string): Promise<boolean>;

  /** Kill a session's process. */
  kill(sessionId: string): Promise<boolean>;

  /** Kill all active processes. */
  killAll(): Promise<void>;

  /** Query session state. */
  getSession(sessionId: string): SdkSessionInfo | undefined;

  /** List all sessions. */
  listSessions(): SdkSessionInfo[];

  /** Get sessions still awaiting their first connection. */
  getStartingSessions(): SdkSessionInfo[];

  /** Mark a session as connected. */
  markConnected(sessionId: string): void;

  /** Store the backend's internal session ID (for resume). */
  setBackendSessionId(sessionId: string, backendSessionId: string): void;

  /** @deprecated Use setBackendSessionId. Alias for backward compatibility. */
  setCLISessionId?(sessionId: string, cliSessionId: string): void;

  /** Set display name. */
  setSessionName(sessionId: string, name: string): void;

  /** Set archived flag. */
  setArchived(sessionId: string, archived: boolean): void;

  /** Remove a session from internal state and persist. */
  removeSession(sessionId: string): void;

  /** Restore sessions from persistent storage. Returns count restored. */
  restoreFromStorage(): number;

  /**
   * Register a session created by an external adapter (no process to manage).
   * Transitional: will be removed when per-backend launchers own their session maps.
   */
  registerExternalSession(info: {
    sessionId: string;
    cwd: string;
    createdAt: number;
    model?: string;
    adapterName?: string;
  }): SdkSessionInfo;
}
```

**Step 2: Make SdkUrlLauncher implement SessionLauncher**

In `src/adapters/sdk-url/sdk-url-launcher.ts`:

IMPORTANT: Keep `extends ProcessSupervisor<LauncherEventMap>` — DO NOT change to `extends TypedEventEmitter`. `ProcessSupervisor` provides `spawnProcess()`, `killProcess()`, `getProcess()`, `removeProcess()`, `canRestart()`, `restartCircuitBreaker`, etc.

```ts
// Add import:
import type { SessionLauncher } from "../../core/interfaces/session-launcher.js";

// Update class declaration (keep ProcessSupervisor, add implements):
export class SdkUrlLauncher extends ProcessSupervisor<LauncherEventMap> implements SessionLauncher {

// Rename setCLISessionId → setBackendSessionId (keep old name as alias):
setBackendSessionId(sessionId: string, backendSessionId: string): void {
  // existing setCLISessionId logic
  const info = this.sessions.get(sessionId);
  if (info) {
    info.cliSessionId = backendSessionId;
    this.persist();
  }
}
/** @deprecated Use setBackendSessionId */
setCLISessionId(sessionId: string, cliSessionId: string): void {
  this.setBackendSessionId(sessionId, cliSessionId);
}

// Add registerExternalSession:
registerExternalSession(info: {
  sessionId: string;
  cwd: string;
  createdAt: number;
  model?: string;
  adapterName?: string;
}): SdkSessionInfo {
  const entry: SdkSessionInfo = {
    sessionId: info.sessionId,
    cwd: info.cwd,
    createdAt: info.createdAt,
    model: info.model,
    adapterName: info.adapterName,
    state: "connected",
  };
  this.sessions.set(info.sessionId, entry);
  this.persist();
  return entry;
}
```

Note: `launch()` already returns `SdkSessionInfo` which satisfies the interface.

**Step 3: Update SessionManager to accept SessionLauncher**

In `src/core/session-manager.ts`:

```ts
// Replace import:
// Before: import { SdkUrlLauncher } from "../adapters/sdk-url/sdk-url-launcher.js";
// After:
import type { SessionLauncher } from "./interfaces/session-launcher.js";

// Update field type:
readonly launcher: SessionLauncher;

// Update constructor — accept launcher from outside:
constructor(options: {
  config: ProviderConfig;
  processManager: ProcessManager;
  storage?: SessionStorage & LauncherStateStorage;
  logger?: Logger;
  gitResolver?: GitInfoResolver;
  authenticator?: Authenticator;
  beforeSpawn?: (sessionId: string, spawnOptions: SpawnOptions) => void;
  server?: WebSocketServerLike;
  metrics?: MetricsCollector;
  adapter?: BackendAdapter;
  launcher: SessionLauncher;  // NEW — required
}) {
  super();
  // ... existing setup
  this.launcher = options.launcher;  // was: new SdkUrlLauncher(...)
  // Remove the internal SdkUrlLauncher construction (lines 81-87)
}

// IMPORTANT: Update wireEvents() — rename setCLISessionId → setBackendSessionId:
// Line 261: change from:
//   this.launcher.setCLISessionId(sessionId, backendSessionId);
// To:
this.launcher.setBackendSessionId(sessionId, backendSessionId);
```

**Step 4: Update beamcode.ts to construct launcher externally**

In `src/bin/beamcode.ts`:

```ts
import { SdkUrlLauncher } from "../adapters/sdk-url/sdk-url-launcher.js";

// In main(), before creating SessionManager:
const launcher = new SdkUrlLauncher({
  processManager,
  config: providerConfig,
  storage,
  logger,
  beforeSpawn: options.beforeSpawn,
});

const sessionManager = new SessionManager({
  config: providerConfig,
  processManager,
  storage,
  logger,
  server: undefined, // set later via setServer()
  metrics,
  adapter,
  launcher,  // NEW
});
```

**Step 5: Update tests that construct SessionManager**

Any test that creates `SessionManager` now needs to pass a `launcher` option. Search for `new SessionManager(` in test files and update. Consider creating a `createMockLauncher()` helper.

**Step 6: Run all tests**

Run: `npx vitest run`
Expected: PASS — this is a type-level refactor. If tests fail, it's because they construct SessionManager without the new `launcher` param.

**Step 7: Commit**

```bash
git add src/core/interfaces/session-launcher.ts src/adapters/sdk-url/sdk-url-launcher.ts src/core/session-manager.ts src/bin/beamcode.ts
git commit -m "refactor: extract SessionLauncher interface, SessionManager accepts generic launcher"
```

---

## Phase 1C: Wiring and Session Lifecycle (Tasks 6-8)

### Task 6: Wire resolver into SessionManager and fix WebSocket CLI handler

**Files:**
- Modify: `src/core/session-manager.ts`
- Modify: `src/bin/beamcode.ts`

**Why:** Two things happen here:
1. `main()` creates the resolver and passes it through
2. The WebSocket CLI handler uses the resolver's eagerly-created `SdkUrlAdapter` instead of the global adapter, so SdkUrl sessions work even when the default adapter is Codex

**Step 1: Update SessionManager constructor**

In `src/core/session-manager.ts`:

```ts
// Add imports:
import type { AdapterResolver } from "../adapters/adapter-resolver.js";
import type { CliAdapterName } from "../adapters/create-adapter.js";

// Add to constructor options:
adapterResolver?: AdapterResolver;

// Store it:
private adapterResolver: AdapterResolver | null;

constructor(options: { /* ... */ }) {
  // ...
  this.adapterResolver = options.adapterResolver ?? null;

  this.bridge = new SessionBridge({
    // ... existing
    adapter: options.adapter,
    adapterResolver: options.adapterResolver,
  });
  // ...
}

// Add getter for default adapter name:
get defaultAdapterName(): CliAdapterName {
  return this.adapterResolver?.defaultName ?? "sdk-url";
}
```

**Step 2: Fix the WebSocket CLI handler in start()**

Replace the inverted connection check (~line 114). Since `sdkUrlAdapter` is eagerly created, it's always available:

```ts
// Before:
if (this.adapter && isInvertedConnectionAdapter(this.adapter)) {
  const adapter = this.adapter;
  // ...

// After:
// Use the resolver's SdkUrlAdapter for inverted connections.
// The SdkUrlAdapter is eagerly created, so it's always available.
// This ensures SdkUrl sessions work even when the default adapter is non-inverted.
const invertedAdapter = this.adapterResolver?.sdkUrlAdapter ??
  (this.adapter && isInvertedConnectionAdapter(this.adapter) ? this.adapter : null);
if (invertedAdapter && isInvertedConnectionAdapter(invertedAdapter)) {
  const adapter = invertedAdapter;
  // ... rest of handler unchanged
```

**Step 3: Update main() to create and pass resolver**

In `src/bin/beamcode.ts`:

```ts
import { createAdapterResolver } from "../adapters/adapter-resolver.js";

// In main(), replace the createAdapter call:
const adapterResolver = createAdapterResolver(
  { processManager, logger },
  config.adapter,
);
const adapter = adapterResolver.resolve(config.adapter);

const sessionManager = new SessionManager({
  // ... existing
  adapter,
  adapterResolver,
  launcher,
});
```

**Step 4: Run tests + manual smoke test**

Run: `npx vitest run`
Expected: PASS

Run: `npx tsx src/bin/beamcode.ts --no-tunnel`
Expected: starts normally, existing behavior preserved

**Step 5: Commit**

```bash
git add src/core/session-manager.ts src/bin/beamcode.ts
git commit -m "feat: wire AdapterResolver through SessionManager, fix WebSocket CLI handler"
```

---

### Task 7: Add `createSession` and `deleteSession` to SessionManager for all adapters

**Files:**
- Modify: `src/core/session-manager.ts`
- Modify: `src/http/api-sessions.ts`
- Test: `src/core/__tests__/session-manager-create.test.ts`

**Why:** The current `POST /api/sessions` handler calls `launcher.launch()` which only works for SdkUrl. We need a unified `createSession()` that routes to the correct adapter. Non-SdkUrl sessions register in the launcher's session map (without a process) so `GET /api/sessions`, archive, rename all work unchanged.

**Step 1: Write test**

```ts
// src/core/__tests__/session-manager-create.test.ts
import { describe, expect, it, vi } from "vitest";
// Test that createSession:
// 1. For sdk-url: delegates to launcher.launch(), returns SdkSessionInfo-like result
// 2. For codex: creates UUID, registers in launcher, connects via bridge
// 3. Both appear in launcher.listSessions()
// 4. On connect failure for non-sdk-url: cleans up registered session (no orphans)
// 5. deleteSession handles sessions with and without PIDs
// (Full test code to be written by implementer following existing test patterns)
```

**Step 2: Add `createSession` to SessionManager**

In `src/core/session-manager.ts`:

```ts
async createSession(options: {
  cwd?: string;
  model?: string;
  adapterName?: CliAdapterName;
}): Promise<{ sessionId: string; cwd: string; adapterName: CliAdapterName; state: string; createdAt: number }> {
  const adapterName = options.adapterName ?? this.defaultAdapterName;
  const cwd = options.cwd ?? process.cwd();

  if (adapterName === "sdk-url") {
    // Existing SdkUrl path: launcher spawns CLI process
    const launchResult = this.launcher.launch({ cwd, model: options.model });
    this.bridge.seedSessionState(launchResult.sessionId, {
      cwd: launchResult.cwd,
      model: options.model,
    });
    this.bridge.setAdapterName(launchResult.sessionId, adapterName);
    return {
      sessionId: launchResult.sessionId,
      cwd: launchResult.cwd,
      adapterName,
      state: launchResult.state,  // "starting" for sdk-url
      createdAt: launchResult.createdAt,
    };
  }

  // Direct-connection path (Codex, ACP)
  const sessionId = randomUUID();
  const createdAt = Date.now();

  // Register in launcher map so GET/DELETE/archive/rename APIs work.
  // Transitional: replaced when per-backend launchers own their session maps.
  this.launcher.registerExternalSession({
    sessionId,
    cwd,
    createdAt,
    model: options.model,
    adapterName,
  });

  this.bridge.seedSessionState(sessionId, { cwd, model: options.model });
  this.bridge.setAdapterName(sessionId, adapterName);

  try {
    await this.bridge.connectBackend(sessionId, {
      adapterOptions: { cwd },
    });
  } catch (err) {
    // Rollback: clean up the registered session to avoid orphans
    this.launcher.removeSession(sessionId);
    this.bridge.closeSession(sessionId);
    throw err;
  }

  return { sessionId, cwd, adapterName, state: "connected", createdAt };
}
```

**Step 3: Update `deleteSession` in SessionManager**

Update `SessionManager.deleteSession()` (~line 231) to handle non-SdkUrl sessions:

```ts
async deleteSession(sessionId: string): Promise<boolean> {
  const info = this.launcher.getSession(sessionId);
  if (!info) return false;

  // Kill process if one exists (SdkUrl sessions have PIDs)
  if (info.pid) {
    await this.launcher.kill(sessionId);
  }

  // Clear relaunch dedup state
  const dedupTimer = this.relaunchDedupTimers.get(sessionId);
  if (dedupTimer) {
    clearTimeout(dedupTimer);
    this.relaunchDedupTimers.delete(sessionId);
  }
  this.relaunchingSet.delete(sessionId);

  // Close backend session + consumer sockets via bridge
  this.bridge.closeSession(sessionId);

  // Remove from launcher's in-memory map and re-persist
  this.launcher.removeSession(sessionId);

  return true;
}
```

**Step 4: Update api-sessions.ts POST handler**

In `src/http/api-sessions.ts`, replace the `POST /api/sessions` handler:

```ts
// Add import at top:
import { CLI_ADAPTER_NAMES, type CliAdapterName } from "../adapters/create-adapter.js";

// Replace POST handler:
if (segments.length === 2 && method === "POST") {
  readBody(req)
    .then(async (body) => {
      let opts: Record<string, unknown> = {};
      if (body) {
        try {
          opts = JSON.parse(body) as Record<string, unknown>;
        } catch {
          json(res, 400, { error: "Invalid JSON" });
          return;
        }
      }

      // Validate cwd
      const cwd = opts.cwd as string | undefined;
      if (cwd) {
        const resolved = resolvePath(cwd);
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
          json(res, 400, { error: "Invalid cwd: not an existing directory" });
          return;
        }
      }

      // Validate adapter
      const adapterName = opts.adapter as string | undefined;
      if (adapterName && !CLI_ADAPTER_NAMES.includes(adapterName as CliAdapterName)) {
        json(res, 400, {
          error: `Invalid adapter "${adapterName}". Valid: ${CLI_ADAPTER_NAMES.join(", ")}`,
        });
        return;
      }

      try {
        const result = await sessionManager.createSession({
          cwd,
          model: opts.model as string | undefined,
          adapterName: adapterName as CliAdapterName | undefined,
        });

        json(res, 201, {
          sessionId: result.sessionId,
          cwd: result.cwd,
          adapterName: result.adapterName,
          state: result.state,
          createdAt: result.createdAt,
        });
      } catch (err) {
        json(res, 500, {
          error: `Failed to create session: ${err instanceof Error ? err.message : err}`,
        });
      }
    })
    .catch((err) => {
      const status = err instanceof Error && err.message === "Request body too large" ? 413 : 400;
      json(res, status, { error: err instanceof Error ? err.message : "Bad request" });
    });
  return;
}
```

**Step 5: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
git add src/core/session-manager.ts src/http/api-sessions.ts src/core/__tests__/session-manager-create.test.ts
git commit -m "feat: unified createSession/deleteSession for all adapter types"
```

---

### Task 8: Handle adapter-specific relaunch and post-restore reconnect

**Files:**
- Modify: `src/core/session-manager.ts` (relaunch logic in wireEvents, restore logic)

**Why:** Two things:
1. The `backend:relaunch_needed` handler calls `launcher.relaunch()` which only works for SdkUrl. Non-SdkUrl sessions need to reconnect via `bridge.connectBackend()`.
2. After restore, non-SdkUrl sessions appear "connected" but the backend connection is gone. They need to be reconnected or marked as exited.

**Step 1: Update relaunch handler**

Replace the `backend:relaunch_needed` handler in `wireEvents()`:

```ts
this.bridge.on("backend:relaunch_needed", async ({ sessionId }) => {
  if (this.relaunchingSet.has(sessionId)) return;

  const info = this.launcher.getSession(sessionId);
  if (!info || info.archived) return;

  // SdkUrl sessions with a PID — relaunch via launcher (existing path)
  if (info.pid && info.state !== "starting") {
    this.relaunchingSet.add(sessionId);
    this.logger.info(`Auto-relaunching SdkUrl backend for session ${sessionId}`);
    try {
      await this.launcher.relaunch(sessionId);
    } finally {
      const timer = setTimeout(() => {
        this.relaunchingSet.delete(sessionId);
        this.relaunchDedupTimers.delete(sessionId);
      }, this.config.relaunchDedupMs);
      this.relaunchDedupTimers.set(sessionId, timer);
    }
    return;
  }

  // Non-SdkUrl sessions (no PID) — reconnect via bridge
  if (!this.bridge.isBackendConnected(sessionId)) {
    this.relaunchingSet.add(sessionId);
    this.logger.info(`Auto-reconnecting ${info.adapterName ?? "unknown"} backend for session ${sessionId}`);
    try {
      await this.bridge.connectBackend(sessionId, {
        adapterOptions: { cwd: info.cwd },
      });
    } catch (err) {
      this.logger.error(`Failed to reconnect backend for session ${sessionId}: ${err}`);
    } finally {
      const timer = setTimeout(() => {
        this.relaunchingSet.delete(sessionId);
        this.relaunchDedupTimers.delete(sessionId);
      }, this.config.relaunchDedupMs);
      this.relaunchDedupTimers.set(sessionId, timer);
    }
  }
});
```

**Step 2: Add post-restore reconnect for non-SdkUrl sessions**

In `restoreFromStorage()`, after the existing restore logic, add:

```ts
private restoreFromStorage(): void {
  const launcherCount = this.launcher.restoreFromStorage();
  const bridgeCount = this.bridge.restoreFromStorage();

  if (launcherCount > 0 || bridgeCount > 0) {
    this.logger.info(
      `Restored ${launcherCount} launcher session(s) and ${bridgeCount} bridge session(s) from storage`,
    );
  }

  // Non-SdkUrl sessions have no process to reconnect via WebSocket.
  // Mark them as needing reconnection — the relaunch handler or consumer
  // connection will trigger connectBackend().
  for (const info of this.launcher.listSessions()) {
    if (!info.pid && !info.archived && info.adapterName && info.adapterName !== "sdk-url") {
      // Mark as "exited" so the UI shows the correct state.
      // When a consumer connects, backend:relaunch_needed will fire
      // and the handler above will reconnect via bridge.connectBackend().
      info.state = "exited";
      this.logger.info(
        `Restored non-SdkUrl session ${info.sessionId} (${info.adapterName}) — marked for reconnect`,
      );
    }
  }
}
```

**Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add src/core/session-manager.ts
git commit -m "feat: adapter-aware relaunch and post-restore reconnect for non-SdkUrl sessions"
```

---

## Phase 1D: Protocol and UI (Tasks 9-11)

### Task 9: Update `set_adapter` handler to return error

**Files:**
- Modify: `src/core/session-bridge.ts` (routeConsumerMessage)
- Modify: tests that assert on set_adapter behavior

**Why:** Adapter is immutable per-session. The existing no-op handler should tell consumers explicitly.

**Step 1: Update handler**

In `src/core/session-bridge.ts`, replace the `set_adapter` case in `routeConsumerMessage()` (~line 657):

```ts
case "set_adapter":
  this.broadcaster.sendTo(ws, {
    type: "error",
    message: "Adapter cannot be changed on an active session. Create a new session with the desired adapter.",
  });
  break;
```

**Step 2: Update tests**

Read `web/src/components/StatusBar.test.tsx` first. Find tests that assert on `set_adapter` message sending (dropdown open/select behavior). These tests need to be removed or replaced since the dropdown is being replaced with a static badge.

**Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS (update any tests that assert on the no-op behavior)

**Step 4: Commit**

```bash
git add src/core/session-bridge.ts
git commit -m "fix: set_adapter returns error instead of silent no-op"
```

---

### Task 10: Update frontend — adapter picker, API, and StatusBar

**Files:**
- Modify: `web/src/api.ts` (add `adapter` to createSession)
- Modify: `web/src/store.ts` (add `adapterName` to SdkSessionInfo)
- Modify: `web/src/components/Sidebar.tsx` (adapter picker on New button, add ADAPTER_COLORS entries)
- Modify: `web/src/components/StatusBar.tsx` (read-only badge, add missing entries)
- Modify: `web/src/components/StatusBar.test.tsx` (update tests)

**IMPORTANT:** Read each file before modifying to understand current structure.

**Step 1: Update api.ts**

```ts
export async function createSession(options: {
  cwd?: string;
  model?: string;
  adapter?: string;
}): Promise<SdkSessionInfo> {
  const res = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(options),
  });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  return res.json();
}
```

**Step 2: Update store.ts SdkSessionInfo**

Add `adapterName` alongside existing `adapterType`:

```ts
export interface SdkSessionInfo {
  // ... existing fields
  adapterType?: string;
  adapterName?: string;  // from API response; takes precedence over adapterType
}
```

**Step 3: Update Sidebar — adapter picker + ADAPTER_COLORS**

Add entries for `"sdk-url"` and `"acp"` to Sidebar's `ADAPTER_COLORS`:
```ts
const ADAPTER_COLORS: Record<string, string> = {
  "sdk-url": "bg-bc-adapter-claude",  // NEW
  claude: "bg-bc-adapter-claude",
  codex: "bg-bc-adapter-codex",
  acp: "bg-bc-adapter-codex",         // NEW — reuse codex color
  continue: "bg-bc-adapter-continue",
  gemini: "bg-bc-adapter-gemini",
};
```

Add a small dropdown to the "New" button. Click → create with default. Chevron → pick adapter. (See original plan for full JSX.)

Update `handleNewSession` to accept adapter param.

**Step 4: Update StatusBar — add missing entries, make read-only**

In `web/src/components/StatusBar.tsx`:

Update `ADAPTER_LABELS`, `ADAPTER_COLORS`, `ADAPTER_DOT_COLORS` with `"sdk-url"` and `"acp"` entries.

Replace `AdapterSelector` dropdown with static badge:
```tsx
function AdapterSelector({ type }: { type: string }) {
  const label = ADAPTER_LABELS[type] ?? type;
  const color = ADAPTER_COLORS[type] ?? "bg-bc-surface-2 text-bc-text-muted";
  return (
    <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${color}`}>{label}</span>
  );
}
```

Update `StatusBar` to read `adapterName` with fallback to `adapterType`:
```tsx
const adapterType = useStore((s) =>
  s.currentSessionId
    ? (s.sessions[s.currentSessionId]?.adapterName ??
       s.sessions[s.currentSessionId]?.adapterType ?? null)
    : null,
);
```

**Step 5: Update StatusBar.test.tsx**

Read existing tests first. Remove tests for dropdown behavior (open, select, set_adapter message, escape). Replace with:
```ts
it("renders adapter badge as static text", () => {
  setupSession({ adapterType: "codex" });
  render(<StatusBar />);
  expect(screen.getByText("Codex")).toBeInTheDocument();
  // No dropdown chevron
  expect(screen.queryByRole("button", { name: /codex/i })).not.toBeInTheDocument();
});
```

**Step 6: Run all frontend tests**

Run: `cd web && npx vitest run`
Expected: PASS

**Step 7: Commit**

```bash
git add web/src/api.ts web/src/store.ts web/src/components/Sidebar.tsx web/src/components/StatusBar.tsx web/src/components/StatusBar.test.tsx
git commit -m "feat: frontend adapter picker, read-only StatusBar badge, adapterName support"
```

---

### Task 11: Integration test — multi-adapter session lifecycle

**Files:**
- Create: `src/__tests__/multi-adapter-sessions.test.ts`

**Why:** Verify the full lifecycle: resolver behavior, create sessions, verify listing, verify deletion.

**Step 1: Write integration test**

```ts
// src/__tests__/multi-adapter-sessions.test.ts
import { describe, expect, it, vi } from "vitest";
import { createAdapterResolver } from "../adapters/adapter-resolver.js";

describe("multi-adapter sessions", () => {
  const mockDeps = {
    processManager: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  };

  describe("AdapterResolver", () => {
    it("SdkUrlAdapter is singleton, Codex is fresh per-call", () => {
      const resolver = createAdapterResolver(mockDeps);

      const sdk1 = resolver.resolve("sdk-url");
      const sdk2 = resolver.resolve("sdk-url");
      expect(sdk1).toBe(sdk2); // singleton

      const codex1 = resolver.resolve("codex");
      const codex2 = resolver.resolve("codex");
      expect(codex1).not.toBe(codex2); // fresh
    });

    it("sdkUrlAdapter is eagerly created", () => {
      const resolver = createAdapterResolver(mockDeps);
      expect(resolver.sdkUrlAdapter).not.toBeNull();
      expect(resolver.sdkUrlAdapter.name).toBe("sdk-url");
    });

    it("respects custom default adapter", () => {
      const resolver = createAdapterResolver(mockDeps, "codex");
      const adapter = resolver.resolve(undefined);
      expect(adapter.name).toBe("codex");
      expect(resolver.defaultName).toBe("codex");
    });

    it("throws for unknown adapter name", () => {
      const resolver = createAdapterResolver(mockDeps);
      expect(() => resolver.resolve("bogus" as any)).toThrow(/Unknown adapter/);
    });
  });

  // Additional lifecycle tests to be written by implementer:
  // - Create session via SessionManager.createSession() with mock launcher
  // - Verify sdk-url path calls launcher.launch()
  // - Verify codex path calls launcher.registerExternalSession() + bridge.connectBackend()
  // - Verify failed connectBackend rolls back registered session
  // - Verify deleteSession handles both pid and non-pid sessions
});
```

**Step 2: Run test**

Run: `npx vitest run src/__tests__/multi-adapter-sessions.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/__tests__/multi-adapter-sessions.test.ts
git commit -m "test: multi-adapter resolver and session lifecycle integration tests"
```

---

## Phase 2: Fully Dynamic (No Default Adapter)

### Task 12: Add `--no-auto-launch` flag

**Files:**
- Modify: `src/bin/beamcode.ts`

**Step 1: Add flag to CliConfig and parseArgs**

```ts
// Add to CliConfig:
noAutoLaunch: boolean;

// Add to parseArgs defaults:
noAutoLaunch: false,

// Add case in switch:
case "--no-auto-launch":
  config.noAutoLaunch = true;
  break;

// Also check env var:
if (!config.noAutoLaunch && process.env.BEAMCODE_NO_AUTO_LAUNCH === "1") {
  config.noAutoLaunch = true;
}
```

**Step 2: Conditionally skip auto-launch**

Wrap the auto-launch block in a conditional:

```ts
let activeSessionId = "";

if (!config.noAutoLaunch) {
  // Existing auto-launch logic (unchanged)
  const isInverted = isInvertedConnectionAdapter(adapter);
  if (isInverted) {
    activeSessionId = sessionManager.launcher.launch({
      cwd: config.cwd,
      model: config.model,
    }).sessionId;
  } else {
    activeSessionId = randomUUID();
  }

  sessionManager.bridge.seedSessionState(activeSessionId, {
    cwd: config.cwd,
    model: config.model,
  });
  sessionManager.bridge.setAdapterName(activeSessionId, adapterResolver.defaultName);

  if (!isInverted) {
    // Register in launcher for non-SdkUrl default sessions
    sessionManager.launcher.registerExternalSession({
      sessionId: activeSessionId,
      cwd: config.cwd,
      createdAt: Date.now(),
      model: config.model,
      adapterName: adapterResolver.defaultName,
    });

    try {
      await sessionManager.bridge.connectBackend(activeSessionId, {
        adapterOptions: { cwd: config.cwd },
      });
    } catch (err) {
      console.error(
        `Error: Failed to start ${adapter.name} backend: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  }
}

httpServer.setActiveSessionId(activeSessionId);
```

**Step 3: Update banner**

```ts
console.log(`
  BeamCode v${version}

  Local:   ${localUrl}${tunnelSessionUrl ? `\n  Tunnel:  ${tunnelSessionUrl}` : ""}
${activeSessionId ? `\n  Session: ${activeSessionId}` : ""}
  Adapter: ${adapter.name}${config.noAutoLaunch ? " (no auto-launch)" : ""}
  CWD:     ${config.cwd}
  API Key: ${apiKey}
`);
```

**Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add src/bin/beamcode.ts
git commit -m "feat: add --no-auto-launch flag for session-agnostic server boot"
```

---

### Task 13: Frontend empty state

**Files:**
- Modify: `web/src/components/EmptyState.tsx` (existing component — modify, don't create new)
- Modify: `web/src/App.tsx` (conditionally show adapter picker variant)

**IMPORTANT:** `web/src/components/EmptyState.tsx` already exists with a "Send a message to start coding" UI. Modify it to support an adapter picker variant when no sessions exist, rather than creating a duplicate component.

**Step 1: Update EmptyState to support adapter picker mode**

Add a prop or detect the no-sessions state:

```tsx
// In EmptyState.tsx, add adapter picker variant:
// When hasNoSessions is true, show adapter picker cards instead of the default message.

const ADAPTER_OPTIONS = [
  { name: "sdk-url", label: "Claude Code", description: "Claude CLI via WebSocket" },
  { name: "codex", label: "Codex", description: "OpenAI Codex CLI" },
  { name: "acp", label: "ACP", description: "Any ACP-compliant agent" },
];
```

**Step 2: Update App.tsx**

Show the adapter picker variant when no current session and no sessions exist.

**Step 3: Run frontend dev + verify**

Run: `cd web && npm run dev`
Start server with: `npx tsx src/bin/beamcode.ts --no-auto-launch --no-tunnel`
Expected: Empty state with adapter picker cards

**Step 4: Commit**

```bash
git add web/src/components/EmptyState.tsx web/src/App.tsx
git commit -m "feat: empty state with adapter picker when no sessions exist"
```

---

### Task 14: Rename `--adapter` to `--default-adapter` (keep alias)

**Files:**
- Modify: `src/bin/beamcode.ts`

**Step 1: Update arg parsing and help**

```ts
case "--adapter":
case "--default-adapter":
  config.adapter = validateAdapterName(argv[++i], arg);
  break;
```

Update help text:
```
--default-adapter <name>  Default backend: sdk-url (default), codex, acp
--adapter <name>          Alias for --default-adapter
```

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/bin/beamcode.ts
git commit -m "feat: rename --adapter to --default-adapter (keep --adapter as alias)"
```

---

## Appendix: Review Findings Addressed

| Finding | Severity | Resolution | Task |
|---------|----------|------------|------|
| SdkUrlAdapter SocketRegistry broken by per-session instances | CRITICAL | Singleton cache in resolver | 1 |
| Lazy SdkUrlAdapter init breaks CLI handler | CRITICAL | Eager construction in resolver | 1 |
| LauncherEventMap wrong payloads + missing events | CRITICAL | Reuse existing from events.ts | 5 |
| wireEvents calls setCLISessionId not setBackendSessionId | CRITICAL | Updated in Task 5 | 5 |
| GET/DELETE/archive/rename don't work for non-SdkUrl sessions | CRITICAL | `registerExternalSession` via SessionLauncher | 7 |
| WebSocket CLI handler gated on global adapter | CRITICAL | Use resolver.sdkUrlAdapter (eager) | 6 |
| SessionManager hardcoded to SdkUrlLauncher | HIGH | Extract SessionLauncher interface | 5 |
| SdkUrlLauncher extends ProcessSupervisor, not TypedEventEmitter | HIGH | Keep extends, add implements | 5 |
| Wrong import path typed-event-emitter → typed-emitter | HIGH | Fixed | 5 |
| LaunchOptions name collision | HIGH | Reuse existing from session-state.ts | 5 |
| Unsafe cast adapterName as CliAdapterName | HIGH | Runtime validation in resolveAdapter | 4 |
| State restore for non-SdkUrl sessions appears "connected" | HIGH | Post-restore mark as "exited" | 8 |
| Orphaned sessions on connect failure | HIGH | Rollback in createSession catch | 7 |
| Direct mutation of internal Session state | HIGH | `SessionBridge.setAdapterName()` method | 3 |
| No tests for BackendLifecycleManager refactor | HIGH | New test file | 4 |
| deleteSession fails for non-SdkUrl | HIGH | Updated deleteSession with PID check | 7 |
| API response hardcodes state: "connected" | MEDIUM | Return actual state from createSession | 7 |
| launch() return type too narrow | MEDIUM | Return SdkSessionInfo from interface | 5 |
| adapterName vs adapterType naming split | MEDIUM | adapterName on server, mapped in frontend | 10 |
| Missing ADAPTER_COLORS for sdk-url and acp | MEDIUM | Added entries in Sidebar + StatusBar | 10 |
| Existing EmptyState.tsx conflict | MEDIUM | Modify existing component | 13 |
| Integration test too shallow | MEDIUM | Added lifecycle test stubs | 11 |
| Phase 2 breaks single-session deployments | MEDIUM | `--no-auto-launch` opt-in flag | 12 |
| set_adapter handler is silent no-op | LOW | Returns explicit error | 9 |
