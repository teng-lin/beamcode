---
title: "feat: Phase 1 UI Gap Closures"
type: feat
date: 2026-02-16
deepened: 2026-02-16
branch: feat/ui-gaps
worktree: .worktrees/ui-gaps
source: docs/reviews/2026-02-16-ui-gap-analysis.md
---

# Phase 1 UI Gap Closures

## Enhancement Summary

**Deepened on:** 2026-02-16
**Review agents used:** kieran-typescript-reviewer, julik-frontend-races-reviewer, security-sentinel, performance-oracle, pattern-recognition-specialist, code-simplicity-reviewer, architecture-strategist
**Research sources:** Context7 (Zustand docs), web search (React 19 + WebSocket patterns)

### Key Improvements
1. **Race condition mitigations**: 8 races identified — 3-state `identityStatus` for identity/permission timing, ephemeral state clearing on WS disconnect, permission mode server-confirmed pattern
2. **Security hardening**: Deny-by-default observer check (`role !== "participant"` not `role === "observer"`), tool result XSS prevention via sanitization, permission mode participant-only guard
3. **Performance optimizations**: `Map<toolUseId, toolName>` for O(1) tool lookup in CW-7, split Zustand selectors in TaskPanel, `useShallow` for MCP and presence arrays

### Critical Findings
- **ConsumerRole type mismatch**: Backend sends `"participant" | "observer"` only — frontend type has 4 roles (`owner | operator | participant | observer`). Observer checks must use deny-by-default: `role !== "participant"`
- **CW-7 tool_use lookup is O(n²)**: Cross-message scan for matching tool_use blocks needs a `Map` built during message ingestion
- **PR 3 should be split**: Archive management and tool result rendering are independent; ship as separate PRs for easier review

## Overview

Close 10 high-value UI gaps identified in the gap analysis. The backend already sends most of the required data — the primary work is frontend rendering, store wiring, and WebSocket handler additions.

Organized into 3 PRs by data availability and risk:

| PR | Items | Theme | Effort |
|----|-------|-------|--------|
| PR 1 | P0-2, P2-2, P1-8, P2-5 | Render already-available data | S |
| PR 2 | P0-5, P2-6, P1-5 | Add WS handlers + store fields + render | M |
| PR 3 | P1-4, CW-7, P2-8 | API additions + complex rendering | M-L |

## Problem Statement

The frontend leaves 5 major capability domains invisible to users. Phase 1 targets 10 items that are all S-M effort and deliver immediate visibility into session state, latency, permissions, presence, MCP servers, and archive management.

## Data Availability Audit

Before implementing, these data contracts were verified against `shared/consumer-types.ts`:

| Field | In Type? | In ws.ts handler? | Notes |
|-------|----------|-------------------|-------|
| `SdkSessionInfo.state` | Yes (store.ts:17) | N/A (from REST API) | P0-2 ready |
| `ResultData.duration_api_ms` | Yes (consumer-types.ts:48) | Yes (result handler) | P2-2 ready |
| `session_name_update` | Yes (consumer-types.ts:213) | Yes (ws.ts:177) | P1-8 ready |
| `ConsumerSessionState.mcp_servers` | Yes (consumer-types.ts:154) | Yes (session_update) | P2-5 ready |
| `identity` message (role) | Yes (consumer-types.ts:214) | **NO handler** | P0-5 needs ws.ts + store |
| `presence_update` message | Yes (consumer-types.ts:216) | **NO handler** | P2-6 needs ws.ts + store |
| `ConsumerSessionState.permissionMode` | Yes (consumer-types.ts:153) | Yes (session_update) | P1-5 display ready |
| `set_permission_mode` inbound | Yes (consumer-types.ts:253) | N/A (outbound) | P1-5 toggle ready |
| `git_ahead` / `git_behind` | **NOT in type** | Unknown | P2-8 needs verification |
| `archived` on SdkSessionInfo | Yes (store.ts:23) | N/A (from REST API) | P1-4 needs HTTP endpoint |

---

## PR 1: Render Available Data

**Theme**: Pure rendering — data is already in the store, just not displayed.

### Task 1.1: P0-2 — Session State Badge

**Effort**: S | **Impact**: High | **Files**: `Sidebar.tsx`, `Sidebar.test.tsx`

The Sidebar already has a `StatusDot` component (Sidebar.tsx:20-36) mapping states to styles, and `resolveStatus()` (Sidebar.tsx:48) combining `SdkSessionInfo.state` with `sessionStatus`. The current rendering only shows a colored dot.

**Changes**:
- Enhance `StatusDot` to show a text label on hover (tooltip): "Starting", "Running", "Exited (code 1)"
- Add exit code display for "exited" state from `SdkSessionInfo.state`
- Ensure all 4 states render distinct colors:
  - `starting` — yellow pulsing dot
  - `connected` / `running` — green dot
  - `exited` — red dot (with exit code in tooltip)
  - `archived` — gray dot

**Edge cases**:
- State stuck on "starting" if spawn fails — timeout handling is backend-side, frontend just renders what it receives
- `null` or missing state — fall back to gray dot

**Tests**:
- Renders correct color for each of 4 states
- Shows exit code in tooltip when state is "exited"
- Falls back to gray for unknown state

> **Performance note** (performance-oracle): StatusDot is already memoized via `SessionItem` memo wrapper. No additional optimization needed for this task.

---

### Task 1.2: P2-2 — Latency Breakdown in ResultBanner

**Effort**: XS | **Impact**: Medium | **Files**: `ResultBanner.tsx`, `ResultBanner.test.tsx`

`ResultData.duration_api_ms` (consumer-types.ts:48) is already delivered with every `result` message but not rendered. Currently only `duration_ms` is shown.

**Changes**:
- After the existing duration display, add API vs client breakdown:
  ```
  2.3s (API 1.9s)
  ```
- Only show breakdown when `duration_api_ms` is present and > 0
- Highlight turns > 5s with `text-bc-warning` class

**Edge cases**:
- `duration_api_ms` > `duration_ms` (clock skew) — clamp client time to 0, show API time only
- `duration_api_ms` is 0 or absent — show only total duration (current behavior)

**Tests**:
- Renders API breakdown when `duration_api_ms` present
- Omits breakdown when `duration_api_ms` is 0 or absent
- Highlights slow turns (> 5s)
- Handles clock skew gracefully

> **Performance note** (performance-oracle): ResultBanner computation is LOW priority — it only runs on `result` messages (once per turn). No memoization needed.

---

### Task 1.3: P1-8 — Verify Session Naming

**Effort**: XS | **Impact**: Medium | **Files**: Verification only; possibly `Sidebar.tsx`

The `session_name_update` handler already exists (ws.ts:177-179) and updates `SdkSessionInfo.name`. The Sidebar displays `info.name` (Sidebar.tsx:66). Session naming is generated backend-side.

**Changes**:
- Verify the existing flow works end-to-end (send a message, confirm name appears in Sidebar)
- If names are already appearing: **no code changes needed**, close this item
- If names are NOT appearing: debug the `session_name_update` → store → Sidebar path
- Add name truncation in Sidebar if names exceed the 260px sidebar width (ellipsis with `truncate` class, which may already be applied)

**Tests**:
- Sidebar renders session name from `SdkSessionInfo.name`
- Long names truncate with ellipsis

---

### Task 1.4: P2-5 — MCP Server Status in TaskPanel

**Effort**: S | **Impact**: Medium | **Files**: `TaskPanel.tsx`, `TaskPanel.test.tsx`

`mcp_servers` is in `ConsumerSessionState` (consumer-types.ts:154) and flows into the store via `session_update`. Currently not rendered.

**Changes**:
- Add a new "MCP Servers" section in TaskPanel, below the existing model usage section
- Only render when `mcp_servers` array is non-empty
- Each server: name + status badge
  - `"connected"` — green dot + "Connected"
  - `"failed"` — red dot + "Failed"
  - Any other value — yellow dot + capitalize the status string
- Collapsible section header: "MCP Servers (N)"

**Edge cases**:
- Empty array or undefined — section not rendered
- Unknown status strings — yellow dot fallback
- Long server names — truncate with `truncate` class

**Tests**:
- Section hidden when no MCP servers
- Renders each server with correct status color
- Handles unknown status values with yellow fallback
- Section shows correct count in header

> **Performance note** (performance-oracle): MCP server array uses shallow comparison by default in Zustand. Use `useShallow` when selecting `state?.mcp_servers` to prevent re-renders when array reference changes but contents are identical:
> ```typescript
> const mcpServers = useStore(useShallow(s => {
>   const sd = s.sessions[activeSessionId];
>   return sd?.state?.mcp_servers ?? [];
> }));
> ```

---

## PR 2: WS Handler + Store Additions

**Theme**: Add missing WebSocket message handlers, new store fields, then render.

### Task 2.1: P0-5 — Observer Role Enforcement

**Effort**: M | **Impact**: Critical | **Files**: `ws.ts`, `store.ts`, `Composer.tsx`, `PermissionBanner.tsx`, `TopBar.tsx`, tests

The `identity` message (consumer-types.ts:214) carries `{ userId, displayName, role }` but ws.ts has no handler for it. The role is not stored anywhere.

**Step 1 — Store + WS handler**:
- Add to `SessionData` in store.ts:
  ```typescript
  identity: { userId: string; displayName: string; role: ConsumerRole } | null;
  ```
- Initialize as `null` in `emptySessionData()`
- Add `setIdentity(sessionId, identity)` action using `patchSession`
- Add `identity` case in ws.ts `handleMessage()`:
  ```typescript
  case "identity":
    useStore.getState().setIdentity(sessionId, {
      userId: msg.userId,
      displayName: msg.displayName,
      role: msg.role,
    });
    break;
  ```

**Step 2 — UI enforcement**:

> **Security insight** (security-sentinel): Use deny-by-default: check `role !== "participant"` instead of `role === "observer"`. Backend only sends `"participant" | "observer"` but the frontend ConsumerRole type has 4 roles. Deny-by-default is safer if new roles are added.

- `Composer.tsx`: When `identity?.role !== "participant"`, disable textarea and submit button. Show placeholder: "Observer mode — read-only". When identity is `null` (not yet received), keep controls enabled for backward compatibility.
- `PermissionBanner.tsx`: When not participant, hide Allow/Deny buttons entirely
- `TopBar.tsx`: When not participant, hide model picker dropdown (show model name as static text)
- Add a dismissible banner at top of ChatView: "You are observing this session (read-only)" with `role="status"` for accessibility

**Step 3 — Observer role badge**:
- Small badge next to connection status in TopBar: "Observer" in muted style
- Only shown when role is `"observer"`

**Edge cases**:
- `identity` message arrives after `permission_request` — permissions already in queue should be rendered without buttons

> **Race condition** (julik-frontend-races-reviewer, CRITICAL): Identity may arrive AFTER `permission_request`. Add a 3-state `identityStatus` field: `"unknown" | "pending" | "received"`. Set to `"pending"` on WS connect, `"received"` on identity message. When `identityStatus === "pending"`, show permission requests without buttons (conservative). When `"unknown"` (legacy/no identity support), show buttons normally.

- Role changes mid-session (unlikely but possible) — re-evaluate all conditional renders
- `identity` never arrives — all controls remain enabled (backward compatibility)

> **Race condition** (julik-frontend-races-reviewer, CRITICAL): On WebSocket reconnect, clear ephemeral state in `onclose` handler: identity, presence, pendingPermissions. Otherwise stale identity from previous connection persists.

**Tests**:
- Store: `setIdentity` stores identity correctly
- WS: `identity` message dispatches to store
- Composer: textarea disabled when observer
- PermissionBanner: buttons hidden when observer
- TopBar: model picker hidden when observer
- Banner appears for observers with correct ARIA role
- Controls remain enabled when identity is null (no identity message received)

---

### Task 2.2: P2-6 — Active Users & Presence

**Effort**: S | **Impact**: Medium | **Files**: `ws.ts`, `store.ts`, `TaskPanel.tsx`, tests

The `presence_update` message (consumer-types.ts:216-218) delivers `consumers: Array<{ userId, displayName, role }>` but ws.ts has no handler.

**Step 1 — Store + WS handler**:
- Add to `SessionData` in store.ts:
  ```typescript
  presence: Array<{ userId: string; displayName: string; role: ConsumerRole }>;
  ```
- Initialize as `[]` in `emptySessionData()`
- Add `setPresence(sessionId, consumers)` action
- Add `presence_update` case in ws.ts `handleMessage()`:
  ```typescript
  case "presence_update":
    useStore.getState().setPresence(sessionId, msg.consumers);
    break;
  ```

**Step 2 — Render in TaskPanel**:
- Add "Connected Users" section below team members (or in place of team when no team)
- Each user: display name + role badge (owner/operator/participant/observer)
- Role badge colors: owner = amber, operator = blue, participant = green, observer = gray
- Count in section header: "Connected Users (3)"
- Only render when `presence.length > 0`

**Edge cases**:
- Single user (just themselves) — still show the section (confirms you're connected)
- User sees themselves in the list — no special treatment
- `presence_update` with empty array — hide section

> **Performance note** (performance-oracle): Presence updates can trigger full TaskPanel re-render. Use split selectors — subscribe only to `presence` array, not entire `sessionData`. Use `useShallow` for array comparison:
> ```typescript
> const presence = useStore(useShallow(s => {
>   const sd = s.sessions[activeSessionId];
>   return sd?.presence ?? [];
> }));
> ```

**Tests**:
- WS: `presence_update` dispatches to store
- TaskPanel: renders user list with correct roles
- Section hidden when presence is empty
- Role badges render correct colors

---

### Task 2.3: P1-5 — Permission Mode Display & Toggle

**Effort**: S (display) + M (auto-allow) | **Impact**: High | **Files**: `TopBar.tsx`, `ws.ts`, `store.ts`, tests

`permissionMode` is in `ConsumerSessionState` (consumer-types.ts:153) and flows via `session_update`. The `set_permission_mode` inbound message exists (consumer-types.ts:253).

**Phase A — Display + Manual Toggle (ship in this PR)**:
- Add a permission mode badge in TopBar, after the model badge:
  - `"default"` or undefined — show nothing (clean default)
  - `"plan"` — show "Plan" badge in blue
  - `"bypassPermissions"` — show "Auto-Allow" badge in green with unlocked icon
  - Other values — show the raw value
- Clicking the badge opens a dropdown with available modes
- Selecting a mode sends `{ type: "set_permission_mode", mode: selectedMode }` via `send()`
- When observer (from P0-5 identity), hide the dropdown — show badge as static text

**Phase B — Auto-Allow Logic (defer to follow-up PR)**:
The auto-allow behavior (frontend auto-responds to permission_request) is complex with race conditions on reconnect. Ship the display and manual toggle first. Auto-allow can be a separate feature that intercepts permissions in ws.ts.

**TopBar space management**:
- Permission badge only shows for non-default modes, so most sessions won't have it
- Use responsive `hidden md:inline-flex` to hide on mobile if TopBar gets crowded
- Priority order for TopBar overflow: connection dot > model > permission mode > git branch > team

**Edge cases**:
- `permissionMode` is undefined — treat as "default", show nothing
- `send()` fails (WebSocket not open) — show error toast, don't update UI optimistically
- Observer role — badge visible but not clickable

> **Security note** (security-sentinel, HIGH): Any participant can send `set_permission_mode` with `"bypassPermissions"`. The backend should validate this is restricted to the session owner. Frontend should reflect server-confirmed mode only — don't optimistically update; wait for the `session_update` echo.
>
> **Race condition** (julik-frontend-races-reviewer, HIGH): Rapid mode toggling can cause UI flicker. Use a `pendingPermissionMode` state with a short timeout — show pending state until server confirms via `session_update`, or revert after 3s timeout.

**Tests**:
- Badge renders correct text for each mode
- Clicking sends `set_permission_mode` message
- Badge hidden for default/undefined mode
- Badge not clickable for observers
- Dropdown closes on selection and on Escape

---

## PR 3: API + Complex Rendering

> **Architecture note** (architecture-strategist): Consider splitting PR 3 into separate PRs — Archive Management (Task 3.1) and Tool Result Rendering (Task 3.2) are fully independent. Smaller PRs are easier to review and have lower merge conflict risk. Git ahead/behind (Task 3.3) may be blocked anyway.

**Theme**: Features needing backend API endpoints or substantial rendering work.

### Task 3.1: P1-4 — Session Archive Management

**Effort**: M | **Impact**: High | **Files**: `api.ts`, `Sidebar.tsx`, `store.ts`, `ws.ts`, tests

The backend has `archive_session` / `unarchive_session` operational commands and storage layer support. The `archived` field exists on `SdkSessionInfo` (store.ts:23). No HTTP API endpoint exists yet.

**Prerequisite**: Verify or add backend REST endpoint. Expected:
- `PUT /api/sessions/:id/archive` — sets archived = true
- `PUT /api/sessions/:id/unarchive` — sets archived = false

If no REST endpoint exists, send as operational command via WebSocket:
```typescript
send({ type: "operational_command", command: "archive_session", sessionId })
```

**Step 1 — API layer**:
- Add to `api.ts`:
  ```typescript
  export async function archiveSession(sessionId: string): Promise<void>
  export async function unarchiveSession(sessionId: string): Promise<void>
  ```

**Step 2 — Store**:
- Add `archiveSession(sessionId)` and `unarchiveSession(sessionId)` actions
- These call the API, then update `sessions[id].archived` in store
- On failure: show error, don't update store (no optimistic update for destructive-ish actions)

**Step 3 — Sidebar UI**:
- Split session list into two sections:
  1. Active sessions (filtered: `!info.archived`) — current behavior
  2. "Archived (N)" collapsible section at bottom (filtered: `info.archived`)
- Archive button on session hover (next to delete button): archive icon
- Unarchive button on archived session hover
- Archived sessions styled with `opacity-60` and archive icon
- Collapsible section uses `aria-expanded` and `role="group"`
- Session search filters both active and archived sections

**Step 4 — Disconnect archived sessions**:
- When archiving: if the session has an active WebSocket, disconnect it
- When unarchiving: do not auto-connect (user clicks the session to reconnect)

**Edge cases**:
- Archive the currently active session — switch to next active session or show empty state
- All sessions archived — show empty state with "No active sessions" and the archived section
- API failure — show error toast, session stays in original section
- Search query matches archived session — show in archived section (don't hide)

**Tests**:
- API: `archiveSession` sends correct request
- Store: updates `archived` flag on success, doesn't update on failure
- Sidebar: splits sessions into active and archived sections
- Sidebar: archive button triggers archive flow
- Sidebar: archived section collapsible with correct count
- Sidebar: archiving active session switches to next session

---

### Task 3.2: CW-7 — Inline Tool Result Rendering

**Effort**: M | **Impact**: High | **Files**: `AssistantMessage.tsx`, new `ToolResultBlock.tsx`, tests

Currently, tool results in `AssistantMessage.tsx` render as generic JSON inside `<details>`. This is the most frequently seen rendering in every conversation.

**Step 1 — Extract ToolResultBlock component**:
- Create `web/src/components/ToolResultBlock.tsx`
- Props: `{ toolName: string; content: string | ConsumerContentBlock[]; isError?: boolean; toolUseId: string }`
- Route to tool-specific renderers based on `toolName`

**Step 2 — Tool-specific renderers** (inside ToolResultBlock):

| Tool | Rendering |
|------|-----------|
| `Bash` | Monospace `<pre>` block with `whitespace-pre-wrap`, dark background. Truncate at 50 lines with "Show more" toggle. |
| `Read` | File content with line numbers (monospace, alternating row backgrounds). Truncate at 30 lines. |
| `Grep` | Monospace with match term highlighted in `text-bc-warning`. Show file paths as headers. |
| `Glob` | File list with monospace paths. Group by directory if > 10 files. |
| `Edit` | Reuse existing `DiffView` component with `old_string` / `new_string` from the corresponding `tool_use` block. |
| `Write` | File path header + content preview (first 10 lines) with line numbers. |
| `WebFetch` | Rendered markdown content (reuse existing prose styling). |
| `WebSearch` | List of results with title + URL links. |
| Default (MCP + others) | Formatted JSON with syntax highlighting via `<pre>` + manual colorization. Collapsible if > 20 lines. |

**Step 3 — Wire into AssistantMessage**:
- In `AssistantMessage.tsx`, replace the generic `<details>` JSON rendering for `tool_result` blocks with `<ToolResultBlock>`
- Look up the corresponding `tool_use` block by `tool_use_id` to get `toolName`

> **Performance note** (performance-oracle, CRITICAL): The current `tool_result` → `tool_use` lookup scans all messages linearly — O(n) per result, O(n²) total for a conversation with many tool calls. Build a `Map<string, string>` (toolUseId → toolName) during message ingestion in the store. Populate it when processing `assistant` messages containing `tool_use` blocks:
> ```typescript
> // In store.ts, add to SessionData:
> toolMeta: Map<string, { toolName: string }>;
>
> // In ws.ts assistant handler, populate:
> for (const block of msg.message.content) {
>   if (block.type === "tool_use") {
>     toolMeta.set(block.id, { toolName: block.name });
>   }
> }
> ```
> Then `ToolResultBlock` does a single `Map.get(toolUseId)` — O(1).

> **Architecture note** (architecture-strategist): There are currently 3 places that route on tool name: `PermissionBanner.toolPreview()`, `ToolBlock.toolPreview()`, and the planned `ToolResultBlock`. Extract a shared `toolMeta` utility (e.g., `web/src/lib/tool-meta.ts`) with a single `getToolDisplayInfo(toolName)` function that returns icon, label, and renderer hint.

**Step 4 — Error results**:
- When `is_error` is true, wrap in a red-tinted container with error icon
- Show the error text prominently, not buried in JSON

> **Security note** (security-sentinel, HIGH): Tool result content may contain user-controlled strings (file paths, shell output). When rendering as HTML (especially for `WebFetch` markdown), sanitize to prevent XSS. Use `textContent` for plain text rendering; for markdown, use a sanitizing renderer or `dangerouslySetInnerHTML` only with a sanitizer like DOMPurify.

**Edge cases**:
- `content` is an array of `ConsumerContentBlock[]` (nested) vs plain string — handle both
- Very large tool results (e.g., Read of a 1000-line file) — always truncate with expand toggle
- Tool name from MCP server (e.g., `mcp__server__tool`) — falls through to default renderer
- Missing corresponding `tool_use` block — render without tool name context

**Tests**:
- Routes to correct renderer based on tool name
- Bash: renders monospace, truncates long output
- Read: shows line numbers
- Grep: highlights match terms
- Edit: renders DiffView
- Error results: shows red container with error icon
- Default: renders formatted JSON for unknown tools
- Handles string and array content types

---

### Task 3.3: P2-8 — Git Ahead/Behind Indicator

**Effort**: S-M | **Impact**: Medium | **Files**: `consumer-types.ts`, `TopBar.tsx`, tests

**BLOCKED**: The `git_ahead` and `git_behind` fields are NOT in `ConsumerSessionState` type definition. The gap analysis claims they're sent, but this is unverified.

**Verification step** (do first):
1. Connect to a session with a git repo that has commits ahead/behind
2. Log the raw `session_update` WebSocket payload
3. Check if `git_ahead` / `git_behind` appear as untyped extra fields

**If fields ARE sent (untyped)**:
- Add to `ConsumerSessionState` in `shared/consumer-types.ts`:
  ```typescript
  git_ahead?: number;
  git_behind?: number;
  is_worktree?: boolean;
  repo_root?: string;
  ```
- In TopBar, next to git branch badge, render:
  - `"main ^2 v0"` format (up/down arrows for ahead/behind)
  - Green `text-bc-success` for ahead count, yellow `text-bc-warning` for behind
  - Only show when git_branch is present AND (ahead > 0 OR behind > 0)
- Use responsive `hidden lg:inline-flex` to hide on smaller screens

**If fields are NOT sent**:
- Move P2-8 to Phase 2 (requires backend changes)
- Close this task as "blocked — backend fields not available"

**Tests** (if unblocked):
- Renders ahead/behind counts next to branch
- Hidden when both are 0
- Hidden when no git branch
- Correct colors for ahead vs behind

---

## Technical Considerations

### TopBar Space Management

Current TopBar items (left to right): sidebar toggle, connection dot+label, model badge, git branch, team badge, spacer, pending permissions count, task panel toggle.

PR 2 adds: observer badge (conditional), permission mode badge (conditional).
PR 3 adds: git ahead/behind (conditional).

**Overflow strategy**:
- Items hidden on mobile (`< md`) in priority order (lowest priority hidden first): git ahead/behind > team badge > permission mode > git branch > model > connection dot
- Use `hidden md:inline-flex` pattern already established in the codebase
- Most new badges are conditional (only show when relevant), so typical sessions won't overflow

### Store Pattern

All new fields follow the existing `patchSession(state, sessionId, patch)` pattern. New actions are thin wrappers:

```typescript
setIdentity: (sessionId, identity) => set(s => patchSession(s, sessionId, { identity })),
setPresence: (sessionId, consumers) => set(s => patchSession(s, sessionId, { presence: consumers })),
```

### WebSocket Handler Pattern

New cases in the `handleMessage()` switch follow the existing pattern:

```typescript
case "identity": {
  const { userId, displayName, role } = msg as Extract<ConsumerMessage, { type: "identity" }>;
  useStore.getState().setIdentity(sessionId, { userId, displayName, role });
  break;
}
```

> **Race condition mitigation** (julik-frontend-races-reviewer): In the `onclose` handler (ws.ts:227-233), clear ephemeral per-connection state:
> ```typescript
> ws.onclose = () => {
>   // ... existing logic ...
>   // Clear ephemeral state that is per-connection
>   const store = useStore.getState();
>   store.patchSession(sessionId, {
>     identity: null,
>     identityStatus: "unknown",
>     presence: [],
>     pendingPermissions: [],
>   });
> };
> ```

### Accessibility

- Observer banner: `role="status"` so screen readers announce mode
- Archive section: `aria-expanded` on collapse toggle, `role="group"` on section
- Permission mode toggle: `<button>` with `aria-pressed` or `aria-expanded` for dropdown
- Latency "slow" indicator: text label supplements color ("Slow" text, not just yellow)
- All new interactive elements keyboard-navigable (Tab, Enter, Escape)

---

## Acceptance Criteria

### PR 1 (Render Available Data)
- [ ] Session state badge shows correct color and tooltip for all 4 states
- [ ] ResultBanner shows API vs total latency breakdown
- [ ] Session names appear in Sidebar (verify existing flow)
- [ ] MCP servers render in TaskPanel with status badges
- [ ] All new rendering has tests

### PR 2 (WS Handlers + Store)
- [ ] Observer role stored from `identity` message
- [ ] Observer cannot interact with Composer, permissions, or model picker
- [ ] Observer banner shown with correct ARIA attributes
- [ ] Presence list renders in TaskPanel
- [ ] Permission mode badge displays current mode
- [ ] Permission mode toggle sends `set_permission_mode` message
- [ ] All new store fields and WS handlers have tests

### PR 3 (API + Complex Rendering)
- [ ] Sessions can be archived/unarchived from Sidebar
- [ ] Archived section collapsible with count
- [ ] Tool results render with tool-specific formatting (Bash, Read, Grep, Edit, etc.)
- [ ] Error results visually distinct from success results
- [ ] Git ahead/behind renders (if data available) or task closed as blocked
- [ ] All new components and API calls have tests

## Dependencies & Risks

| Risk | Mitigation |
|------|-----------|
| `git_ahead`/`git_behind` not sent by backend | Verify first; move to Phase 2 if absent |
| Archive REST endpoint doesn't exist | Fall back to WebSocket operational command |
| TopBar overflow on narrow screens | Responsive hiding with priority order |
| `identity` message timing (arrives after `permission_request`) | Render permissions without buttons when role is null and identity hasn't arrived yet — conservative approach |
| Auto-allow permission mode race on reconnect | Defer auto-allow to follow-up; ship display + manual toggle only |

## Implementation Order

```
PR 1 (parallel tasks, no dependencies between them):
  Task 1.1: P0-2 Session State Badge
  Task 1.2: P2-2 Latency Breakdown
  Task 1.3: P1-8 Session Naming (verification)
  Task 1.4: P2-5 MCP Server Status

PR 2 (Task 2.1 first — other tasks depend on identity/store pattern):
  Task 2.1: P0-5 Observer Role → sets store pattern for 2.2
  Task 2.2: P2-6 Active Users & Presence
  Task 2.3: P1-5 Permission Mode Display

PR 3 (independent tasks):
  Task 3.1: P1-4 Archive Management
  Task 3.2: CW-7 Inline Tool Results
  Task 3.3: P2-8 Git Ahead/Behind (verify first)
```

## References

- Gap analysis: `docs/reviews/2026-02-16-ui-gap-analysis.md`
- Consumer types: `shared/consumer-types.ts`
- Store: `web/src/store.ts`
- WebSocket handler: `web/src/ws.ts`
- Existing quick-wins plan (CW-1 through CW-8): `docs/plans/2026-02-16-frontend-quick-wins.md`
- Test factories: `web/src/test/factories.ts`
