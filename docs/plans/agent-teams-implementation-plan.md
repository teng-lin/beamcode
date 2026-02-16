# Agent Teams Support — Implementation Plan

> Status: Revised (v2)
> Branch: feature/agent-teams
> Date: 2026-02-15
> Phase: 5 (builds on Phase 0-4 infrastructure)
> Review: 3-agent team review completed — all CRITICAL/HIGH findings addressed

## Problem Statement

Claude Code v2.1.32+ introduced **agent teams** (a.k.a. "swarms") — a filesystem-based
multi-agent coordination protocol where multiple Claude Code sessions collaborate via
shared task boards and inbox-based messaging. BeamCode's adapter layer currently has a
placeholder `agents: string[]` field but no support for observing, routing, or rendering
team coordination events.

## Research Sources

- [Official Docs](https://code.claude.com/docs/en/agent-teams) (High confidence)
- [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) — v2.1.32-v2.1.41
- [System Prompts (Piebald-AI)](https://github.com/Piebald-AI/claude-code-system-prompts/) — TeammateTool, SendMessageTool, TaskCreate
- [AlexOp blog](https://alexop.dev/posts/from-tasks-to-swarms-agent-teams-in-claude-code/)
- [Swarm orchestration gist](https://gist.github.com/kieranklaassen/4f2aba89594a4aea4ad64d753984b2ea)

## How Agent Teams Work (Protocol Summary)

### Filesystem Layout

```
~/.claude/
  teams/{team-name}/
    config.json              # { members: [{ name, agentId, agentType, color, model }] }
    inboxes/
      team-lead.json         # [{ from, text, timestamp, read }]
      worker-1.json
  tasks/{team-name}/
    1.json                   # { id, subject, description, status, owner, blockedBy, blocks }
    2.json
```

### 7 Primitives

| Tool Call               | Effect                                      |
|-------------------------|---------------------------------------------|
| `TeamCreate`            | Creates `teams/{name}/config.json` + `tasks/{name}/` |
| `Task(team_name, name)` | Spawns teammate, adds to config.json members |
| `TaskCreate`            | Creates `tasks/{name}/{id}.json` (pending)  |
| `TaskUpdate`            | Claims/completes task, sets dependencies    |
| `TaskList` / `TaskGet`  | Reads task directory                        |
| `SendMessage`           | Writes to `inboxes/{recipient}.json`        |
| `TeamDelete`            | Removes team + task directories             |

### SendMessage Types

| Type                      | Direction          | Purpose                    |
|---------------------------|--------------------|----------------------------|
| `message`                 | 1:1 DM             | Report, ask, coordinate    |
| `broadcast`               | 1:all              | Critical announcements     |
| `shutdown_request`        | Lead → teammate    | Graceful shutdown          |
| `shutdown_response`       | Teammate → lead    | Approve/reject shutdown    |
| `plan_approval_request`   | Teammate → lead    | Submit plan for approval   |
| `plan_approval_response`  | Lead → teammate    | Approve/reject plan        |

### Lifecycle

```
SETUP:     TeamCreate → TaskCreate × N → Task(team_name) × N
EXECUTION: Loop { TaskList → claim → work → complete → report → idle }
TEARDOWN:  shutdown_request × N → shutdown_response × N → TeamDelete
```

### Key Architecture Insight

Teams are NOT a new protocol — they flow as regular `tool_use` / `tool_result` content
blocks in the existing SDK stream. BeamCode already translates these. The work is
**recognizing** team tool names and **extracting** team state from them.

BeamCode observes the protocol stream and derives team state from it, but does not
initiate team operations or access the filesystem.

---

## Design Decisions

### D1: Observation-Only — No Filesystem Access

**Decision**: BeamCode observes team events from the SDK message stream only.
It does NOT directly read `~/.claude/teams/` or `~/.claude/tasks/` on disk.

**Rationale**:
- BeamCode is a protocol adapter — it should work from the wire, not the filesystem.
- The SDK stream already contains `tool_use` (with inputs) and `tool_result` (with outputs)
  for every team operation.
- Filesystem access would couple BeamCode to Claude Code's internal layout, which is
  undocumented and may change.
- Remote relay scenarios can't access the host filesystem anyway.

**Implication**: Derived TeamState may lag if context compression discards team messages.
Mitigated by persisting TeamState to session storage (see D6).

### D2: New UnifiedMessageType Values

**Decision**: Add three new message types to the `UnifiedMessageType` union:

| Type                | Emitted When                                           |
|---------------------|--------------------------------------------------------|
| `team_message`      | SendMessage tool_use detected (DM, broadcast, shutdown) |
| `team_task_update`  | TaskCreate/TaskUpdate/TaskGet tool_use detected        |
| `team_state_change` | TeamCreate/TeamDelete/Task(team_name) detected         |

**Consumer deduplication**: The original `assistant` message containing `tool_use` blocks
is emitted unchanged. Supplementary `team_*` messages carry the same data in `metadata`
with `metadata.teamToolUseId` referencing the originating `tool_use.id` block. Consumers
can filter on either — the `assistant` message for raw rendering, or `team_*` messages
for semantic rendering.

### D3: Team State in SessionState — With Backward Compatibility

**Decision**: Add a structured `team?` field AND keep `agents: string[]` as a
deprecated computed field.

```typescript
team?: TeamState;

// Keep for backward compatibility — populated from team.members by the state reducer.
// Consumers should migrate to team?.members.
agents: string[];
```

**Rationale**: 27 references to `agents` exist across the codebase (6 production, 13 test,
4 test init, 4 translators). A hard removal would break consumers. The `agents` field is
populated as `team?.members.map(m => m.name) ?? []` by the state reducer, preserving
backward compatibility. Removal deferred to next major version.

### D4: Extension Interface — Observation-Only

**Decision**: Add a new optional extension interface following the existing pattern
(`Interruptible`, `Configurable`, `PermissionHandler`). **Observation-only** — no send
methods.

```typescript
interface TeamObserver {
  readonly teamName: string;
  readonly teamEvents: AsyncIterable<TeamEvent>;
}
```

**Rationale**: Existing extensions follow observation + response pattern, never initiation.
`PermissionHandler` has `permissionRequests` (observe) and `respondToPermission` (respond
to something that happened), but never initiates a new permission request.

If consumers need to send team messages, they use `session.send()` with a `user_message`
UnifiedMessage — the normal inbound path.

### D5: BackendCapabilities Flag

**Decision**: Add `teams: boolean` to `BackendCapabilities`.

| Adapter  | teams |
|----------|-------|
| SdkUrl   | true  |
| AgentSdk | true  |
| ACP      | false |
| Codex    | false |

### D6: TeamState Persistence (Context Compression Mitigation)

**Decision**: Persist derived TeamState to session storage on each update. On
reconnection or context compression, restore from persisted state rather than
re-deriving from the message stream.

**Rationale**: Context compression may discard team coordination messages. Without
persistence, BeamCode would lose track of team roster and task board state. This
aligns with the existing `PersistedSession` pattern which already stores `state`,
`messageHistory`, and `pendingPermissions`.

**Implementation**: Extend `PersistedSession` to include `teamState?: TeamState`.
The state reducer writes to storage after each team state mutation. On session
hydration, `teamState` is restored into `SessionState.team`.

### D7: Role Detection

**Decision**: The observed session's team role is determined by which tool_use is
seen first:
- If `TeamCreate` tool_use is observed → `role: "lead"`
- Otherwise → `role: "teammate"` (default)

**Rationale**: BeamCode observes a single CLI session via `--sdk-url`. If that session
creates the team, it is the lead. Teammate sessions don't call `TeamCreate`.

For BeamCode's primary use case (observing a local CLI session), the observed session
is almost always the lead. This assumption is documented and revisitable if BeamCode
adds support for observing teammate sessions directly.

---

## Implementation Phases

### Phase 5.1: Type Definitions (~280 LOC)

**Files to modify:**
- `src/core/types/unified-message.ts` — add 3 message types + validation + type guards
- `src/core/interfaces/backend-adapter.ts` — add `teams` capability
- `src/core/interfaces/extensions.ts` — add `TeamObserver` extension
- `src/types/session-state.ts` — add `team?` field (keep `agents` for compat)

**New files:**
- `src/core/types/team-types.ts` — TeamMember, TeamTask, TeamEvent, TeamState types

#### team-types.ts

```typescript
// --- Team Member ---
export interface TeamMember {
  name: string;
  agentId: string;
  agentType: string;
  status: "active" | "idle" | "shutdown";
  model?: string;
  color?: string;
}

// --- Team Task ---
export interface TeamTask {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  owner?: string;
  activeForm?: string;
  blockedBy: string[];
  blocks: string[];
}

// --- Team State (embedded in SessionState) ---
export interface TeamState {
  name: string;
  role: "lead" | "teammate";
  members: TeamMember[];
  tasks: TeamTask[];
}

// --- Team Events (emitted via extension interface) ---
export type TeamEvent =
  | TeamMessageEvent
  | TeamIdleEvent
  | TeamShutdownRequestEvent
  | TeamShutdownResponseEvent
  | TeamPlanApprovalRequestEvent
  | TeamPlanApprovalResponseEvent
  | TeamMemberEvent
  | TeamTaskEvent;

export interface TeamMessageEvent {
  type: "message";
  from: string;
  to?: string;        // undefined = broadcast
  content: string;
  summary?: string;
}

export interface TeamIdleEvent {
  type: "idle";
  from: string;
  completedTaskId?: string;
}

export interface TeamShutdownRequestEvent {
  type: "shutdown_request";
  from: string;
  to: string;
  requestId: string;
  reason?: string;
}

export interface TeamShutdownResponseEvent {
  type: "shutdown_response";
  from: string;
  requestId: string;
  approved: boolean;
  reason?: string;
}

export interface TeamPlanApprovalRequestEvent {
  type: "plan_approval_request";
  from: string;
  to: string;
  requestId: string;
  plan: string;
}

export interface TeamPlanApprovalResponseEvent {
  type: "plan_approval_response";
  from: string;
  to: string;
  requestId: string;
  approved: boolean;
  feedback?: string;
}

export interface TeamMemberEvent {
  type: "member_joined" | "member_left" | "member_idle" | "member_active";
  member: TeamMember;
}

export interface TeamTaskEvent {
  type: "task_created" | "task_claimed" | "task_completed" | "task_updated";
  task: TeamTask;
}

// --- Type guards ---
export function isTeamMember(value: unknown): value is TeamMember;
export function isTeamTask(value: unknown): value is TeamTask;
export function isTeamState(value: unknown): value is TeamState;
```

#### Changes to unified-message.ts

```typescript
// Add to UnifiedMessageType:
| "team_message"
| "team_task_update"
| "team_state_change"

// Add to VALID_MESSAGE_TYPES set:
"team_message", "team_task_update", "team_state_change"

// Add type guards:
export function isTeamMessage(msg: UnifiedMessage): boolean {
  return msg.type === "team_message";
}
export function isTeamTaskUpdate(msg: UnifiedMessage): boolean {
  return msg.type === "team_task_update";
}
export function isTeamStateChange(msg: UnifiedMessage): boolean {
  return msg.type === "team_state_change";
}
```

#### Changes to backend-adapter.ts

```typescript
export interface BackendCapabilities {
  streaming: boolean;
  permissions: boolean;
  slashCommands: boolean;
  availability: "local" | "remote" | "both";
  teams: boolean;  // NEW
}
```

#### Changes to extensions.ts

```typescript
// --- Team extensions (Phase 5) ---

import type { TeamEvent } from "../types/team-types.js";

/** The session can observe team coordination events. */
export interface TeamObserver {
  readonly teamName: string;
  readonly teamEvents: AsyncIterable<TeamEvent>;
}
```

#### Changes to session-state.ts

```typescript
import type { TeamState } from "../core/types/team-types.js";

export interface SessionState extends DevToolSessionState {
  // ... existing fields ...
  agents: string[];              // KEEP — deprecated, populated from team.members
  team?: TeamState;              // NEW — structured team state
  // ... rest unchanged ...
}
```

**Tests:**
- Type guard tests for new message types (`isTeamMessage`, etc.)
- Type guard tests for TeamMember, TeamTask, TeamState
- TeamState construction and validation
- Backward compat: `agents` field still present and populated

---

### Phase 5.2: Team Tool Recognizer (~180 LOC)

**New file:**
- `src/core/team-tool-recognizer.ts`

A pure function that inspects `tool_use` content blocks and identifies team operations:

```typescript
/** Team tools that are always recognized (no ambiguity). */
const UNAMBIGUOUS_TEAM_TOOLS = new Set([
  "TeamCreate", "TeamDelete",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
  "SendMessage",
]);

export interface RecognizedTeamToolUse {
  toolName: string;
  toolUseId: string;
  category: "team_state_change" | "team_task_update" | "team_message";
  input: Record<string, unknown>;
}

/**
 * Inspects a UnifiedMessage for team-related tool_use blocks.
 * Returns recognized team operations, or empty array if none found.
 *
 * For the `Task` tool: only recognized as team-related when BOTH
 * `team_name` AND `name` parameters are present in input (compound
 * discriminator — teammates always have both, subagents have neither).
 */
export function recognizeTeamToolUses(msg: UnifiedMessage): RecognizedTeamToolUse[];

/**
 * Checks if a tool_use content block looks like a team-related Task spawn.
 * Requires both `team_name` and `name` in input to distinguish from subagents.
 */
function isTeamTaskSpawn(input: Record<string, unknown>): boolean {
  return typeof input.team_name === "string" && typeof input.name === "string";
}
```

Categorization logic:
- `TeamCreate`, `TeamDelete` → `team_state_change`
- `Task` (when `isTeamTaskSpawn(input)` is true) → `team_state_change`
- `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet` → `team_task_update`
- `SendMessage` → `team_message`

**Logging**: When a tool name matches `Team*` or `Task*` pattern but is NOT in the
recognized set, log a debug warning to aid future protocol change detection.

**Input validation**: Each recognized tool's input is validated for required fields
before returning. Invalid inputs are skipped with a warning log.

| Tool | Required Input Fields |
|------|----------------------|
| `TeamCreate` | `team_name` |
| `TeamDelete` | (none) |
| `Task` (team) | `team_name`, `name` |
| `TaskCreate` | `subject` |
| `TaskUpdate` | `taskId` |
| `TaskList` | (none) |
| `TaskGet` | `taskId` |
| `SendMessage` | `type` |

**Tests:**
- Recognizes each of the 7 team tools + Task(team) variant
- Ignores regular `Task` calls with only `description` (no `team_name`)
- Ignores regular `Task` calls with `team_name` but no `name`
- Ignores non-team tool_use blocks (Read, Write, Bash, etc.)
- Handles multiple tool_use blocks in a single message
- Returns correct category for each tool
- Logs warning for unknown `Team*`/`Task*` tools
- Skips tool_use with missing required fields (with warning)

---

### Phase 5.3: Correlation Buffer (~120 LOC)

**New file:**
- `src/core/team-tool-correlation.ts`

The correlation buffer solves a fundamental timing issue: `tool_use` arrives in one
message (with inputs like `{ subject: "Fix bug" }`) and `tool_result` arrives in a
later message (with outputs like `{ taskId: "3" }`). The state reducer needs both
to build accurate TeamState.

```typescript
export interface PendingToolUse {
  recognized: RecognizedTeamToolUse;
  receivedAt: number;
}

export interface CorrelatedToolUse {
  recognized: RecognizedTeamToolUse;
  result?: ToolResultContent;
}

/**
 * Buffers pending tool_use blocks and correlates them with incoming tool_results.
 *
 * Lifecycle:
 * 1. onToolUse(recognized) — buffers the tool_use
 * 2. onToolResult(toolResultContent) — correlates and returns the pair
 * 3. flush(maxAgeMs) — discards stale entries older than maxAgeMs
 */
export class TeamToolCorrelationBuffer {
  private pending = new Map<string, PendingToolUse>();

  /** Buffer a recognized team tool_use for later correlation. */
  onToolUse(recognized: RecognizedTeamToolUse): void;

  /**
   * Attempt to correlate a tool_result with a buffered tool_use.
   * Returns the correlated pair if found, or undefined if no match.
   * If tool_result.is_error is true, clears the entry and returns
   * the pair with a flag — the state reducer should skip state mutation.
   */
  onToolResult(result: ToolResultContent): CorrelatedToolUse | undefined;

  /** Discard entries older than maxAgeMs. Returns count of discarded entries. */
  flush(maxAgeMs: number): number;

  /** Number of pending (uncorrelated) entries. */
  get pendingCount(): number;
}
```

**Design notes:**
- Buffer is keyed by `toolUseId` (from `tool_use.id` and `tool_result.tool_use_id`)
- Default TTL: 30 seconds (team operations complete quickly)
- `flush()` called after each message batch in the state reducer integration
- No out-of-order handling needed: `tool_result` always arrives after `tool_use`
  in the SDK stream (confirmed by existing message-translator.ts flow)
- On `tool_result.is_error === true`: correlated pair returned with `result.is_error`
  flag so reducer can skip state mutation

**Tests:**
- Buffer → correlate → pair returned correctly
- Buffer → timeout → flush discards entry
- Buffer → error result → pair returned with is_error flag
- Duplicate tool_use ID → overwrites (last write wins)
- Correlate without buffer → returns undefined (no crash)
- pendingCount tracks correctly

---

### Phase 5.4: Team State Reducer (~350 LOC)

**New file:**
- `src/core/team-state-reducer.ts`

A pure function that builds/updates `TeamState` from correlated team tool pairs.
All operations are **idempotent** — applying the same update twice produces the
same state (critical for reconnection replay scenarios).

```typescript
/**
 * Reduces a correlated team tool pair into an updated TeamState.
 *
 * Returns the new TeamState, or undefined if the team was dissolved (TeamDelete).
 * Returns the input state unchanged if the tool doesn't produce a state change
 * (e.g., TaskList, SendMessage/message).
 *
 * All mutations are idempotent — duplicate tool_use applications are safe.
 */
export function reduceTeamState(
  state: TeamState | undefined,
  correlated: CorrelatedToolUse,
): TeamState | undefined;
```

State transitions:

| Tool Use | State Change | Idempotency Guard |
|----------|-------------|-------------------|
| `TeamCreate` | Initialize TeamState: `{ name, role: "lead", members: [], tasks: [] }` | Skip if `state !== undefined` (team already exists) |
| `TeamDelete` | Return `undefined` (team dissolved) | Always applies |
| `Task(team_name)` | Add member: `{ name, agentId, agentType, status: "active" }` | Skip if `members.find(m => m.name === name)` exists |
| `TaskCreate` | Add task: `{ id (from result), subject, status: "pending" }` | Skip if `tasks.find(t => t.id === id)` exists |
| `TaskUpdate` | Update task status/owner/blockedBy/blocks | No-op if task not found |
| `TaskGet` | No state change (read-only) | N/A |
| `TaskList` | No state change (read-only) | N/A |
| `SendMessage(message)` | No state change (events only) | N/A |
| `SendMessage(broadcast)` | No state change (events only) | N/A |
| `SendMessage(shutdown_request)` | No state change (request pending) | N/A |
| `SendMessage(shutdown_response, approve=true)` | Set member `status: "shutdown"` | No-op if member not found |
| `SendMessage(shutdown_response, approve=false)` | No state change | N/A |
| `SendMessage(plan_approval_request)` | No state change (events only) | N/A |
| `SendMessage(plan_approval_response)` | No state change (events only) | N/A |
| Any tool with `result.is_error === true` | No state change | N/A |

**Idle detection**: Idle is a **synthetic event**, not a SendMessage type. The state
reducer integration layer (Phase 5.6) emits a `TeamIdleEvent` when:
1. A `TaskUpdate(status: "completed")` is observed for a member
2. AND no subsequent `TaskUpdate(status: "in_progress")` follows for that member
   within the same message batch

**TeamDelete handling**: Returns `undefined`. The integration layer (Phase 5.6)
must explicitly remove the `team` field from SessionState:
```typescript
if (newTeamState === undefined) {
  const { team, ...rest } = state;
  return { ...rest, agents: [] };
}
```

**Tests:**
- Full lifecycle: create → add members → create tasks → claim → complete → shutdown → delete
- Idempotency: applying same TeamCreate/TaskCreate/member-add twice → no duplicates
- TaskUpdate on unknown task → no-op (no crash)
- SendMessage(shutdown_response, approve=true) on unknown member → no-op
- SendMessage(message/broadcast) → state unchanged
- TeamDelete → returns undefined
- tool_result with is_error → state unchanged
- TaskUpdate with addBlockedBy/addBlocks → dependency arrays updated
- TaskUpdate(status: "deleted") → task removed from array
- Role detection: TeamCreate → role: "lead"; no TeamCreate → role: "teammate"
- Concurrent TaskUpdate on same task → last write wins
- Task dependency cycles (A blocks B, B blocks A) → accepted (no cycle detection)

---

### Phase 5.5: Message Translator Integration (~200 LOC)

**Files to modify:**
- `src/adapters/sdk-url/message-translator.ts`
- `src/adapters/agent-sdk/sdk-message-translator.ts`

For each adapter's outbound translator (CLI → UnifiedMessage):

1. After translating an `assistant` message, scan its `content` blocks for team tool uses
2. If found, emit **additional** `team_*` UnifiedMessages alongside the original `assistant` message
3. The original `assistant` message is unchanged — team messages are supplementary
4. Each supplementary message carries `metadata.teamToolUseId` referencing the original `tool_use.id`

```typescript
function translateOutbound(cliMsg: CLIMessage): UnifiedMessage[] {
  const primary = translateToUnifiedMessage(cliMsg);  // existing logic
  const teamUses = recognizeTeamToolUses(primary);

  if (teamUses.length === 0) return [primary];

  const teamMessages = teamUses.map(use => createUnifiedMessage({
    type: use.category,
    role: "system",
    metadata: {
      toolName: use.toolName,
      teamToolUseId: use.toolUseId,
      input: use.input,
    },
  }));

  return [primary, ...teamMessages];
}
```

For `tool_result` messages: check if the `tool_use_id` matches a buffered team tool_use
in the correlation buffer. If so, emit a supplementary `team_*` message with the result.

**Tests:**
- SdkUrl translator emits team_message alongside assistant message
- AgentSdk translator does the same
- Regular (non-team) assistant messages unchanged (no supplementary messages)
- `metadata.teamToolUseId` correctly references the tool_use.id
- tool_result for team tools emits supplementary team message
- tool_result for non-team tools unchanged

---

### Phase 5.6: State Reducer Integration (~200 LOC)

**Files to modify:**
- `src/adapters/sdk-url/state-reducer.ts`
- `src/core/session-bridge.ts`

Wire the team state reducer and correlation buffer into the existing pipeline:

```typescript
// In session-bridge.ts (or state reducer)
private teamCorrelation = new TeamToolCorrelationBuffer();

// On team_state_change or team_task_update:
case "team_state_change":
case "team_task_update": {
  const teamUses = recognizeTeamToolUses(msg);
  for (const use of teamUses) {
    this.teamCorrelation.onToolUse(use);
  }
  // State update deferred until tool_result arrives
  return state;
}

// On tool_result content blocks (in any message):
for (const block of msg.content) {
  if (isToolResultContent(block)) {
    const correlated = this.teamCorrelation.onToolResult(block);
    if (correlated) {
      const newTeamState = reduceTeamState(state.team, correlated);
      if (newTeamState === undefined) {
        // TeamDelete — remove team field entirely
        const { team, ...rest } = state;
        state = { ...rest, agents: [] };
      } else {
        state = {
          ...state,
          team: newTeamState,
          agents: newTeamState.members.map(m => m.name),  // backward compat
        };
      }
    }
  }
}

// Periodic flush (after each message batch)
this.teamCorrelation.flush(30_000);
```

**TeamState persistence**: After each team state mutation, persist to session storage:

```typescript
if (state.team !== prevState.team) {
  await this.storage.updateTeamState(session.id, state.team);
}
```

**Session hydration**: On session restore, load persisted TeamState:

```typescript
const persisted = await this.storage.load(sessionId);
if (persisted?.teamState) {
  state.team = persisted.teamState;
  state.agents = persisted.teamState.members.map(m => m.name);
}
```

**Backward compat for `agents` field**: The state reducer for `session_init` messages
already populates `agents` from CLI data. This continues to work. When `team` is also
present, the `agents` field is overwritten with `team.members.map(m => m.name)`.

**Tests:**
- SessionState.team updates correctly through full lifecycle
- State persists across multiple messages
- team field is undefined when no team is active
- TeamDelete removes team and resets agents to []
- agents field populated from team.members (backward compat)
- Correlation buffer integrates correctly (buffer → result → state update)
- Session hydration restores persisted TeamState
- Flush discards stale entries after 30s

---

### Phase 5.7: Consumer Events & TypedEventEmitter (~120 LOC)

**Files to modify:**
- `src/core/session-bridge.ts` (emit team events)

New events following the existing `namespace:action` pattern:

```typescript
// Add to SessionBridgeEventMap
"team:created": { sessionId: string; teamName: string };
"team:deleted": { sessionId: string; teamName: string };
"team:member:joined": { sessionId: string; member: TeamMember };
"team:member:idle": { sessionId: string; member: TeamMember };
"team:member:shutdown": { sessionId: string; member: TeamMember };
"team:task:created": { sessionId: string; task: TeamTask };
"team:task:claimed": { sessionId: string; task: TeamTask };
"team:task:completed": { sessionId: string; task: TeamTask };
"team:message:received": { sessionId: string; from: string; to?: string; content: string; summary?: string };
"team:shutdown:response": { sessionId: string; member: string; approved: boolean };
"team:plan:requested": { sessionId: string; from: string; requestId: string };
"team:plan:resolved": { sessionId: string; from: string; approved: boolean };
```

Events are emitted from the state reducer integration layer when team state changes
are detected (after correlation completes).

**Idle events**: Emitted when a member completes a task but doesn't claim a new one
within the same message batch. The session-bridge tracks "last completed task per
member" and emits `team:member:idle` on the next message that doesn't contain a
TaskUpdate(in_progress) from that member.

**Tests:**
- Events fire at correct moments in the lifecycle
- Event payloads match expected shapes
- No events fire for non-team sessions
- `team:member:idle` fires after task completion without new claim
- Event names follow existing `namespace:action` pattern

---

### Phase 5.8: BackendCapabilities & Adapter Updates (~50 LOC)

**Files to modify:**
- `src/adapters/sdk-url/sdk-url-adapter.ts` — set `teams: true`
- `src/adapters/agent-sdk/agent-sdk-adapter.ts` — set `teams: true`
- `src/adapters/acp/acp-adapter.ts` — set `teams: false`
- `src/adapters/codex/codex-adapter.ts` — set `teams: false`

**Tests:**
- Capability declarations are correct
- Consumer can check `adapter.capabilities.teams` before subscribing

---

## Consumer Contract

Guarantees for consumers of team state:

| Guarantee | Level |
|-----------|-------|
| `team` field is `undefined` until `TeamCreate` is observed | Guaranteed |
| `team` field is `undefined` after `TeamDelete` is observed | Guaranteed |
| `team.members` grows monotonically (members are added, never removed until shutdown) | Guaranteed |
| `team.tasks` entries are never removed (only status changes) | Guaranteed except `deleted` status |
| `team.tasks[].id` is unique within a team's lifetime | Guaranteed (by Claude Code) |
| `team.members[].name` is unique within a team | Guaranteed (by Claude Code) |
| `agents` field is always in sync with `team.members.map(m => m.name)` | Guaranteed |
| Team events are emitted in causal order | Best-effort (may lag after context compression) |
| TeamState survives session reconnection | Guaranteed (persisted to storage) |

---

## File Summary

| File | Action | LOC Est. |
|------|--------|----------|
| `src/core/types/team-types.ts` | NEW | ~150 |
| `src/core/types/unified-message.ts` | MODIFY | ~25 |
| `src/core/interfaces/backend-adapter.ts` | MODIFY | ~5 |
| `src/core/interfaces/extensions.ts` | MODIFY | ~15 |
| `src/types/session-state.ts` | MODIFY | ~10 |
| `src/core/team-tool-recognizer.ts` | NEW | ~100 |
| `src/core/team-tool-correlation.ts` | NEW | ~100 |
| `src/core/team-state-reducer.ts` | NEW | ~350 |
| `src/adapters/sdk-url/message-translator.ts` | MODIFY | ~60 |
| `src/adapters/agent-sdk/sdk-message-translator.ts` | MODIFY | ~60 |
| `src/adapters/sdk-url/state-reducer.ts` | MODIFY | ~40 |
| `src/core/session-bridge.ts` | MODIFY | ~80 |
| `src/adapters/*/adapter.ts` (×4) | MODIFY | ~20 |
| **Tests** | | |
| `test/core/team-types.test.ts` | NEW | ~100 |
| `test/core/team-tool-recognizer.test.ts` | NEW | ~180 |
| `test/core/team-tool-correlation.test.ts` | NEW | ~120 |
| `test/core/team-state-reducer.test.ts` | NEW | ~350 |
| `test/adapters/sdk-url/team-translation.test.ts` | NEW | ~150 |
| `test/adapters/agent-sdk/team-translation.test.ts` | NEW | ~100 |
| `test/core/team-events.test.ts` | NEW | ~120 |
| `test/core/team-integration.test.ts` | NEW | ~100 |
| **Total** | | **~2,135** |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Team tool names change in future Claude Code versions | Recognizer fails silently | Unknown tool_use blocks pass through as regular `assistant` messages — no breakage, just missing semantic events. Debug logging warns on unknown `Team*`/`Task*` patterns. |
| `Task` tool call ambiguity (team vs subagent) | False positives/negatives | Compound discriminator: require BOTH `team_name` AND `name` in input. Regular subagents never have both. |
| tool_result arrives in separate message from tool_use | State reducer can't correlate immediately | Correlation buffer with 30s TTL, keyed by toolUseId. Flush stale entries periodically. |
| Context compression discards team messages | Derived TeamState diverges | TeamState persisted to session storage after each mutation. Restored on hydration. |
| `agents` field removal breaks consumers | Runtime errors | Field kept with backward-compat population from `team.members`. Removal deferred to next major version. |
| Claude Code drops the experimental flag and changes protocol | Adapter breaks | Feature behind our own `teams` capability flag. Monitor changelogs. |
| Reconnection replays duplicate tool_use | Duplicate tasks/members in state | All reducer operations are idempotent (existence checks before insert). |

---

## Out of Scope

- **Consumer UI rendering** — this plan covers the adapter/bridge layer only
- **Filesystem watching** — BeamCode does not read `~/.claude/teams/` directly
- **Team creation from BeamCode** — BeamCode observes, it does not orchestrate
- **ACP/Codex team support** — these protocols don't have team concepts
- **Nested team support** — Claude Code itself doesn't support this
- **Task dependency cycle detection** — accepted as-is (Claude Code's responsibility)

## Dependencies

- Phase 0-1 complete (UnifiedMessage, BackendAdapter interfaces) ✅
- Phase 3 complete (message translators exist for tool_use/tool_result) ✅
- Phase 4 complete (AgentSdk adapter exists) ✅

## Success Criteria

1. A consumer connected to a Claude Code session running an agent team can see:
   - Team roster with member names, types, and status (active/idle/shutdown)
   - Task board with real-time status updates
   - Inter-agent message timeline
   - Team lifecycle events (create → work → shutdown)
2. All existing tests continue to pass (no regressions)
3. Non-team sessions are completely unaffected
4. `agents: string[]` backward compatibility preserved
5. TeamState survives context compression (persisted to storage)
6. 80%+ line coverage on new code (measured by `vitest --coverage`)
