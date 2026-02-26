# Message Flow Panel — Design Doc

**Date:** 2026-02-25
**Status:** Approved, ready for implementation
**Review:** Passed Momus dual review (Claude + Gemini), issues fixed

## Summary

A developer-facing drawer panel in the BeamCode web UI that visualizes WebSocket message passing through the system in real time. Targeted at developers debugging adapter behavior, inspecting tool call chains, and verifying protocol correctness.

## Aesthetic Direction: "Signal Wire"

Oscilloscope / circuit trace aesthetic. Near-black background with subtle dot-grid texture. Monospace type throughout. Each message type assigned a saturated signal color. Glowing SVG connector lines draw between paired messages on hover.

- **Font:** JetBrains Mono (content), Departure Mono or similar (header/labels)
- **Background:** `#0A0B0D` with dot-grid overlay
- **Connector lines:** cubic bezier SVG, animated with `stroke-dashoffset` draw on hover

## Layout

Two-lane layout with a vertical time axis in the center:

```
┌─────────────────────────────────────────────────────────────┐
│  ◈ MESSAGE FLOW   ● LIVE   [All Types ▾]   [↓]   [⌫]       │
├───────────────────────┬────────────┬────────────────────────┤
│  OUTBOUND             │            │             INBOUND    │
│  bridge → consumer    │   TIME ↓   │  consumer → bridge     │
├───────────────────────┼────────────┼────────────────────────┤
│  [pill] ─────────────→│ 00:01.234  │                        │
│                       │ 00:01.301  │←──────────── [pill]    │
│  [pill] ─────────────→│ 00:01.305  │                        │
└───────────────────────┴────────────┴────────────────────────┘
```

- **OUTBOUND** (left lane): messages flowing bridge → consumer, received via `socket.onmessage`
- **INBOUND** (right lane): messages flowing consumer → bridge, sent via `ws.ts:send()`

## Message Pill Anatomy

```
┌──────────────────────────────────────┐
│▌ tool_use          00:01.234   ↗ [▾] │
│  name: Bash                          │
└──────────────────────────────────────┘
```

- 3px left-edge color bar (type color)
- Type label (bold monospace)
- Timestamp: `elapsed ms` since first message in session (see Data Model)
- Direction arrow: ↗ outbound / ↙ inbound
- Expand chevron `[▾]` → full JSON view
- Hover: background lifts, connector activates

## Message Type Color System

Note: `tool_use`, `tool_result`, and `thinking` are **content block subtypes** nested inside
`assistant` messages — they do not appear as top-level `ConsumerMessage.type` values.
Top-level pills use `assistant` as the message type; content block subtypes are shown
in the expanded JSON view and in the pairing logic (which walks `content[]`).

### Outbound top-level types (bridge → consumer)

| Type | Color | Hex |
|------|-------|-----|
| `assistant` | Amber | `#F59E0B` |
| `stream_event` | Cyan | `#22D3EE` |
| `tool_progress` | Teal | `#14B8A6` |
| `tool_use_summary` | Sage | `#6EE7B7` |
| `status_change` | Violet | `#A78BFA` |
| `permission_request` | Coral | `#F97316` |
| `result` | Lime | `#84CC16` |
| `cli_connected` | Steel | `#94A3B8` |
| `cli_disconnected` | Muted red | `#F87171` |
| `error` | Red | `#EF4444` |
| `user_message` (echoed) | White | `#F8FAFC` |
| `message_queued` | Purple | `#C084FC` |
| `message_history` | Zinc | `#A1A1AA` |

### Inbound top-level types (consumer → bridge, sent via `send()`)

| Type | Color | Hex |
|------|-------|-----|
| `user_message` | White | `#F8FAFC` |
| `permission_response` | Coral lighter | `#FED7AA` |
| `interrupt` | Red | `#EF4444` |
| `slash_command` | Sky | `#38BDF8` |
| `queue_message` | Purple | `#C084FC` |
| `update_queued_message` | Purple lighter | `#E9D5FF` |
| `cancel_queued_message` | Muted red | `#F87171` |
| `set_model` | Zinc | `#A1A1AA` |
| `set_permission_mode` | Zinc | `#A1A1AA` |

## Pairing Logic

Related messages are highlighted on hover with a glowing connector line and latency badge.

| Outbound | Paired Inbound | Match Key | Notes |
|----------|---------------|-----------|-------|
| `permission_request` | `permission_response` | `request.id` / `request_id` | 1:1 by ID |
| `assistant` (with `tool_use` block) | `tool_use_summary` or next `assistant` response | `content[].id` | Walk `content[]` for tool_use blocks |
| `tool_progress` | — | `tool_use_id` | Groups with originating `assistant` pill |
| `message_queued` | `update_queued_message` / `cancel_queued_message` / `queued_message_sent` | Session singleton | Only one queued message per session at a time; pair by temporal adjacency after `message_queued` outbound |

**Note on `message_queued` pairing:** `message_queued` (outbound) carries `consumer_id` but
the inbound messages (`update_queued_message`, `cancel_queued_message`) do not carry a
matching field. Use session-singleton semantics: all inbound queue messages after a
`message_queued` event (until `queued_message_sent` or `queued_message_cancelled`) are
considered paired to that `message_queued` pill.

**Hover behavior:**
1. Hovered pill + paired counterpart → full opacity; all others → 30% opacity
2. Curved SVG connector draws between them (cubic bezier, `stroke-dashoffset` animation, ~200ms)
3. Latency badge on connector midpoint: `+47ms` (difference in `wallTime` fields)

For `tool_progress` groups: hover the parent `assistant` pill → all related `tool_progress`
pills glow in teal, connector runs to each. Mini badge shows: `3 progress events (1.2s)`.

## Controls

| Control | Behavior |
|---------|----------|
| `● LIVE` | Pulses when messages are flowing; click to **pause** — freezes display, keeps buffering to `pendingWhilePaused[]`, shows `● PAUSED +12` badge |
| `[All Types ▾]` | Multiselect filter by message type; filtered-out types show as faint tick marks on the time axis |
| `[↓ auto-scroll]` | Toggle — when off, new messages append without scrolling the view |
| `[⌫ clear]` | Clears `flowMessages` ring buffer in the hook; no store mutation |

**Keyboard shortcuts:**
- `⌥M` — toggle panel open/closed; registered in `App.tsx` via `useEffect` + `document.addEventListener` (same pattern as other global shortcuts in `App.tsx`)
- `Escape` — close panel; registered inside `MessageFlowPanel.tsx` via `useEffect` + `document.addEventListener` (same pattern as `LogDrawer.tsx:22-29`)

**StatusBar entry point:** Add a `MessageFlowButton` to `web/src/components/StatusBar.tsx`,
positioned after the existing logs button, following the same rendering pattern.

## Implementation

### 1. Intercept Mechanism in `ws.ts`

Add a module-level listener registry **after** the existing module-level state (after line 17):

```ts
// ── Message flow tap (dev panel) ──────────────────────────────────────────
type FlowInboundListener = (sessionId: string, msg: ConsumerMessage) => void;
type FlowOutboundListener = (sessionId: string, msg: InboundMessage) => void;
const flowInboundListeners = new Set<FlowInboundListener>();
const flowOutboundListeners = new Set<FlowOutboundListener>();

export function addFlowInboundListener(cb: FlowInboundListener): () => void {
  flowInboundListeners.add(cb);
  return () => flowInboundListeners.delete(cb);
}

export function addFlowOutboundListener(cb: FlowOutboundListener): () => void {
  flowOutboundListeners.add(cb);
  return () => flowOutboundListeners.delete(cb);
}
```

In `handleMessage`, after `const msg = parsed as ConsumerMessage;` (line 115), add:
```ts
for (const cb of flowInboundListeners) cb(sessionId, msg);
```

In `send()` (line 529), before `socket.send(...)`, add:
```ts
for (const cb of flowOutboundListeners) cb(targetId, message);
```

**Done when:** `addFlowInboundListener` and `addFlowOutboundListener` are exported and calling them with a callback fires it once per matching message in `ws.test.ts`.

### 2. Store Additions in `store.ts`

Add to the flat `AppState` interface (alongside `logDrawerOpen`):

```ts
messageFlowOpen: boolean;
setMessageFlowOpen: (open: boolean) => void;
```

Implement in the `create()` call following the same pattern as `logDrawerOpen`. No localStorage persistence needed (reset on page load is fine for a dev panel).

The ring buffer (`flowMessages`) lives entirely in `useMessageFlow`'s `useRef` — not in the store. This keeps the store free of dev-only state and avoids unnecessary global re-renders.

**Done when:** `useStore.getState().messageFlowOpen` is `false` by default and `setMessageFlowOpen(true)` toggles it, verified by a store test following the pattern in `store.test.ts`.

### 3. `useMessageFlow` Hook

File: `web/src/hooks/useMessageFlow.ts`

```ts
const MAX_FLOW_MESSAGES = 500; // hard cap on ring buffer

interface UseMessageFlowResult {
  messages: FlowMessage[];
  paused: boolean;
  pendingCount: number;
  setPaused: (v: boolean) => void;
  clear: () => void;
}
```

- On mount: call `addFlowInboundListener` and `addFlowOutboundListener`, store cleanup in a `useEffect` return
- Each incoming message: `crypto.randomUUID()` for `id`, `Date.now()` for `wallTime`, `Date.now() - sessionStartRef.current` for `timestamp` (where `sessionStartRef` is set to `Date.now()` on the first message received)
- Ring buffer: if `messages.length >= MAX_FLOW_MESSAGES`, evict `messages[0]` before appending
- When paused: new messages go to a `pendingRef` array instead; on resume, flush pending into ring buffer (capped)
- Pairing index: `Map<string, string>` (id → paired FlowMessage id), built incrementally as messages arrive

**Done when:** Unit test in `useMessageFlow.test.ts` asserts:
1. Ring buffer evicts at 501 messages: `expect(result.current.messages).toHaveLength(500)`
2. Pause stops messages from appearing in `messages`; resume flushes them
3. `permission_request` message sets `pairedId` on the corresponding `permission_response`

### 4. `ConnectorOverlay.tsx`

File: `web/src/components/ConnectorOverlay.tsx`

SVG coordinate strategy:
- `MessageFlowPanel` root div has `position: relative`
- `ConnectorOverlay` is `position: absolute; inset: 0; pointer-events: none; overflow: visible`
- Each `MessagePill` has a `data-flow-id={msg.id}` attribute on its root element
- On hover, the overlay calls `document.querySelector([data-flow-id="${pairedId}"])` and `getBoundingClientRect()` on both pills, then subtracts the panel container's `getBoundingClientRect()` to get local coordinates
- SVG `<path>` uses cubic bezier: control points at `(panelMidX, pillA.centerY)` and `(panelMidX, pillB.centerY)`
- Animated with `stroke-dasharray` + `stroke-dashoffset` CSS transition, ~200ms ease-out

**Done when:** Hovering a `permission_request` pill draws a visible line to its paired `permission_response` pill, verified manually in the browser (no unit test for coordinate math).

### 5. `MessageFlowPanel.tsx`

File: `web/src/components/MessageFlowPanel.tsx`

- Reads `messageFlowOpen` and `currentSessionId` from store
- Returns `null` when `!messageFlowOpen || !currentSessionId` (same pattern as `LogDrawer.tsx:31`)
- Renders: top controls bar, two-column layout (left: outbound pills, center: time axis, right: inbound pills), `ConnectorOverlay` as absolute child
- Escape-to-close via `useEffect` + `document.addEventListener` (copy pattern from `LogDrawer.tsx:22-29`)

Layout classnames follow the project's Tailwind v4 conventions (see other components for reference).

**Done when:** Panel renders correctly when `messageFlowOpen = true`, pills appear in the correct lane, and Escape closes the panel. Verified by component test in `MessageFlowPanel.test.tsx`.

### 6. `MessagePill.tsx`

File: `web/src/components/MessagePill.tsx`

Props:
```ts
interface MessagePillProps {
  message: FlowMessage;
  dimmed: boolean;           // true when another pill is hovered
  onHoverStart: () => void;  // notify parent to activate connector
  onHoverEnd: () => void;
}
```

- Color bar: 3px left border using inline style with the type's hex color
- Preview: first 60 chars of `JSON.stringify(message.payload)`
- Expand: controlled by local `useState<boolean>`, shows full `<pre>` JSON on expand
- `data-flow-id={message.id}` on root element (required by ConnectorOverlay)

**Done when:** Snapshot test in `MessagePill.test.tsx` renders without error for each direction (`"out"`, `"in"`) and all representative message types.

### 7. App.tsx Wiring

In `web/src/App.tsx`, add alongside the existing `LogDrawer`:

1. Import `MessageFlowPanel` and `setMessageFlowOpen` from store
2. Add `⌥M` global shortcut in the top-level `useEffect` keyboard handler (or create one if absent):
   ```ts
   if (e.altKey && e.key === "m") {
     useStore.getState().setMessageFlowOpen(!useStore.getState().messageFlowOpen);
   }
   ```
3. Render `<MessageFlowPanel />` as a sibling to `<LogDrawer />` in the JSX

**Done when:** Pressing `⌥M` toggles the panel open/closed without errors.

### 8. StatusBar Entry Point

In `web/src/components/StatusBar.tsx`, add a `MessageFlowButton` component following the
same pattern as the existing logs button. Position it adjacent to the logs button.

**Done when:** Button is visible in the StatusBar and clicking it toggles `messageFlowOpen`.

## Data Model

```ts
export const MAX_FLOW_MESSAGES = 500;

export interface FlowMessage {
  id: string;            // crypto.randomUUID() at capture time
  direction: "out" | "in";
  type: string;          // msg.type from ConsumerMessage or InboundMessage
  payload: unknown;      // full original message object
  timestamp: number;     // Date.now() - sessionStartMs (ms since first message)
  wallTime: number;      // Date.now() at capture (used for latency badge)
  pairedId?: string;     // id of the single paired FlowMessage (1:1 pairs)
  groupIds?: string[];   // ids of related FlowMessages (1:N groups, e.g. tool_progress)
}
```

`timestamp` is relative to the first message received in the current session (captured in
`useMessageFlow` as `sessionStartRef = Date.now()` on first message). This is what drives
the time axis labels. `wallTime` is absolute and used only for computing latency badges.

## File Plan

```
web/src/components/
  MessageFlowPanel.tsx        ← panel shell, two-lane layout, controls, Escape shortcut
  MessageFlowPanel.test.tsx   ← renders correctly, Escape closes
  MessagePill.tsx             ← pill: color bar, type, timestamp, preview, expand, data-flow-id
  MessagePill.test.tsx        ← snapshot for each direction + representative types
  ConnectorOverlay.tsx        ← position:absolute SVG layer, getBoundingClientRect on hover

web/src/hooks/
  useMessageFlow.ts           ← ring buffer (MAX_FLOW_MESSAGES), listeners, pause, pairing index
  useMessageFlow.test.ts      ← ring cap, pause/resume, pairing logic

web/src/ws.ts                 ← add addFlowInboundListener + addFlowOutboundListener exports
web/src/store.ts              ← add messageFlowOpen + setMessageFlowOpen to AppState
web/src/App.tsx               ← ⌥M shortcut + <MessageFlowPanel /> render
web/src/components/StatusBar.tsx ← MessageFlowButton
```
