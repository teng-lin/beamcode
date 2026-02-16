# Agent Teams Plan — Consolidated Review

> Date: 2026-02-15
> Reviewers: architect, protocol-reviewer, devil-advocate (3-agent team)
> Plan: docs/plans/agent-teams-implementation-plan.md

## Consolidated Issues (Deduplicated)

### CRITICAL (4 issues — must resolve before implementation)

#### CR1: tool_use/tool_result Correlation Gap
**Flagged by**: protocol-reviewer (C1), devil-advocate (C2), architect (H3)
**Consensus**: All three reviewers independently identified this as the biggest gap.

**Problem**: Team state updates require correlating `tool_use` (contains inputs like
task subject) with `tool_result` (contains outputs like assigned task ID). These arrive
in separate messages. The plan acknowledges this (line 424-426) but provides NO
implementation:
- No buffering mechanism defined
- No timeout for orphaned tool_use blocks
- No out-of-order handling
- No specification of which component owns the buffer

**Resolution**: Add Phase 5.3a defining:
- Pending tool_use buffer (Map<toolUseId, RecognizedTeamToolUse>) with 30s TTL
- Correlation logic in state reducer: defer reduction until both pieces arrive
- Buffer lives in the state reducer integration layer (Phase 5.5)
- On timeout: emit warning, discard pending entry
- On tool_result with is_error=true: no state change, clear buffer entry

---

#### CR2: Task Tool Disambiguation Is Fragile
**Flagged by**: protocol-reviewer (C2), devil-advocate (H3)

**Problem**: The plan checks for `team_name` in `Task` tool input to distinguish team
spawns from regular subagents. But:
1. No guarantee Claude Code always includes `team_name` in the wire format
2. False positives possible if regular Task metadata contains a `team_name` key
3. The tool NAME is the same ("Task") for both use cases

**Resolution**: Use compound discriminator:
- Check for BOTH `team_name` AND `name` parameters (teammates always have both)
- Additionally check if `state.team !== undefined` (team must exist first)
- Add negative test: regular Task with only `description` must NOT be recognized

---

#### CR3: `agents` Field Backward Compatibility Breakage
**Flagged by**: devil-advocate (C1)

**Problem**: The plan removes `agents: string[]` from SessionState. Devil-advocate found
**23 references** across the codebase:
- 13 in test files
- 6 in production code (state-reducer.ts, message-translator.ts, session-bridge.ts, etc.)
- 4 in test initialization objects

All usages treat `agents` as required, not optional.

**Resolution**: Keep `agents` as a deprecated computed getter:
```typescript
// In SessionState
team?: TeamState;

/** @deprecated Use team?.members instead */
get agents(): string[] {
  return this.team?.members.map(m => m.name) ?? [];
}
```
Or simpler: keep `agents: string[]` as a plain field, populate from `team.members`
in the state reducer. Remove in a future major version.

---

#### CR4: Context Compression Data Loss
**Flagged by**: devil-advocate (C3)

**Problem**: When Claude Code's automatic context compression fires, team coordination
messages may be compressed out. BeamCode's derived TeamState would then diverge from
the actual team state on disk.

The plan's "observation-only" approach (D1) means BeamCode cannot fall back to reading
`~/.claude/teams/` to recover.

**Resolution**: Options (choose one):
1. **Persist derived TeamState** — write TeamState to session storage on each update.
   On reconnection/compression, restore from persisted state rather than re-deriving.
2. **Accept eventual consistency** — document that TeamState may lag after compression.
   Consumers should treat it as best-effort.
3. **Snapshot on compaction** — listen for `is_compacting: true` state change and
   snapshot the current TeamState.

Recommend option 1 (persist) — it aligns with existing `PersistedSession` pattern.

---

### HIGH (5 issues — address before implementing affected phases)

#### HI1: Extension Interface Pattern Violation
**Flagged by**: architect (C1), devil-advocate (M1)

**Problem**: `TeamCoordinator` includes control methods (`sendToTeammate()`,
`broadcast()`, `requestShutdown()`) which violate BeamCode's observation-only
architecture. Existing extensions (like `PermissionHandler`) only expose
observation + response, never initiation.

Devil-advocate goes further: this is YAGNI — the interface contradicts the plan's
own design decision D1.

**Resolution**: Strip to observation-only:
```typescript
interface TeamCoordinator {
  readonly teamName: string;
  readonly teamEvents: AsyncIterable<TeamEvent>;
}
```
If consumers need to send team messages, they use `session.send()` with a
`user_message` UnifiedMessage — the normal inbound path.

---

#### HI2: SendMessage Type Coverage Incomplete
**Flagged by**: protocol-reviewer (C3), devil-advocate (H4)

**Problem**: Plan lists 5 SendMessage types but misses:
- `plan_approval_request` (teammate → lead) — only the response direction is covered
- `idle_notification` — how idle events flow through the protocol is unspecified

**Resolution**:
- Add `TeamPlanApprovalRequestEvent` to team-types.ts
- Clarify idle: it's a **synthetic event** generated by the state reducer when
  TaskUpdate(status=completed) is detected AND no subsequent TaskUpdate(status=in_progress)
  follows within the same message batch. NOT a SendMessage type.

---

#### HI3: TeamState Reducer Not Idempotent
**Flagged by**: protocol-reviewer (H1)

**Problem**: Applying the same tool_use twice (e.g., during reconnection replay) will
create duplicate tasks/members.

**Resolution**: All reducer operations must check for existence:
- TaskCreate: skip if `tasks.find(t => t.id === id)` exists
- Task(team_name): skip if `members.find(m => m.name === name)` exists
- TaskUpdate: no-op if task doesn't exist

---

#### HI4: Agent Role Detection Missing
**Flagged by**: protocol-reviewer (H2)

**Problem**: TeamState has `role: "lead" | "teammate"` but the plan never explains how
this is determined. A teammate session running the state reducer would incorrectly
report `role: "lead"`.

**Resolution**: Detect from context:
- If `TeamCreate` tool_use is observed → this session is the lead
- If the session starts with team environment variables
  (`CLAUDE_CODE_TEAM_NAME`, etc.) → this session is a teammate
- For BeamCode's use case (observing via --sdk-url): the session being observed is
  almost always the lead. Document this assumption.

---

#### HI5: LOC Estimates Optimistic
**Flagged by**: devil-advocate (H1)

**Problem**: State reducer estimated at ~200 LOC but needs to handle 7 tools,
correlation buffering, dependency graphs, status state machines. Existing
state-reducer.ts is 170 LOC for only 4 message types.

**Resolution**: Revise total estimate from ~1,470 to ~1,800-2,000 LOC.
Key underestimates:
- team-state-reducer.ts: 200 → 350 LOC
- Correlation buffer: 0 → 100 LOC (new component)
- Type guards and validation: 0 → 80 LOC

---

### MEDIUM (7 issues — fix during implementation)

| ID | Issue | Source | Resolution |
|----|-------|--------|------------|
| M1 | TeamDelete state clearing — returning undefined doesn't remove `team` key | protocol-reviewer | Explicit `delete state.team` or destructure |
| M2 | Message duplication — consumers get both `assistant` and `team_*` messages | devil-advocate | Add `metadata.isTeamToolUse: true` flag to assistant message so consumers can deduplicate |
| M3 | No type guards for new message types | architect | Add `isTeamMessage()`, `isTeamTaskUpdate()`, `isTeamStateChange()` guards |
| M4 | No migration path for existing sessions | devil-advocate | Populate `team` from `agents[]` if non-empty during state hydration |
| M5 | Input validation missing in recognizer | architect | Add Zod schemas or manual guards for each tool's required fields |
| M6 | Event naming consistency unverified | architect | Audit existing event naming in typed-emitter.ts before adding new events |
| M7 | Consumer contract undocumented | devil-advocate | Add consumer contract section specifying guarantees (team presence, ID uniqueness, etc.) |

### LOW (5 issues — stretch goals)

| ID | Issue | Source |
|----|-------|--------|
| L1 | Unknown tool pattern logging (`Team*`, `Task*`) | protocol-reviewer |
| L2 | Malformed tool input error handling | protocol-reviewer |
| L3 | Test coverage metric clarification (80% of what?) | architect |
| L4 | Phase 3/4 dependency completion not verified | architect |
| L5 | Broadcast cost not quantified for relay bandwidth | devil-advocate |

---

## Positive Findings (Unanimous)

All three reviewers agreed on these strengths:
1. **Observation-only approach is architecturally correct** — no filesystem coupling
2. **Pure reducer pattern aligns with existing codebase** (sdk-url/state-reducer.ts)
3. **UnifiedMessageType extension is clean and backward-compatible**
4. **Phase ordering is logical** — types → recognizer → reducer → translator → integration
5. **Test coverage target (80%+) is appropriate**
6. **Forward-compatible design** — unknown tools pass through gracefully

---

## Recommended Action Plan

### Before Implementation (Blockers)

1. Resolve CR1: Design correlation buffer (new Phase 5.3a)
2. Resolve CR2: Strengthen Task tool discriminator
3. Resolve CR3: Keep `agents` field with deprecation shim
4. Resolve CR4: Choose persistence strategy for TeamState
5. Resolve HI1: Strip TeamCoordinator to observation-only
6. Resolve HI2: Add plan_approval_request, clarify idle as synthetic
7. Resolve HI3: Make reducer idempotent
8. Resolve HI4: Define role detection logic
9. Revise LOC estimate to ~1,800-2,000 (HI5)

### During Implementation

10. Fix M1-M7 as encountered in each phase

### After Implementation

11. Address L1-L5 as stretch goals
