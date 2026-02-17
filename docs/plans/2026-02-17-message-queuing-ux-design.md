# Message Queuing UX Design

## Problem

When a user sends a message while the backend is busy (`running`), the message is queued but the UI gives no clear feedback. The message appears as if it's being processed immediately. Only one message can be queued, and input is blocked with no explanation. In multi-participant sessions, other users have no visibility into queued messages.

## Design

### Message States

```
[typing] → [queued/pending] → [sending] → [sent/normal]
```

Single-queue per session. One pending message at a time. Input is blocked while a message is queued.

### Visual Treatment

**Queued message:**
- Rendered inline in the conversation feed at the point it was typed
- 50% opacity with a small pulsing dot indicator
- Label below: "Queued — will send when current task completes"
- Author name shown (visible to all participants)

**Sending transition (FLIP animation):**
1. Record queued message's current position
2. Remove queued element; let the real `user_message` from backend render at the bottom
3. Apply CSS transform to move the new element back to the old position
4. Animate transform to `(0, 0)` with opacity 50% → 100%

### Keyboard-Driven Editing

No hover buttons. The composer is the editing surface.

1. User presses **Up arrow** while a message is queued
2. Queued content loads into the composer; composer enables
3. Queued bubble in the feed shows "editing..." indicator
4. **Enter** with content → re-queues the updated message
5. **Enter** with empty content → cancels the queue, removes message from feed

### Composer States

| State | Input | Placeholder |
|-------|-------|-------------|
| Normal (no queue) | Enabled | "Send a message..." |
| Queued (message waiting) | Disabled | "Message queued — press ↑ to edit" |
| Editing queue | Enabled | Normal behavior |
| Blocked (another user queued) | Disabled | "[User] has a message queued" |

### Multi-Participant Visibility

All queue actions go through the backend and are broadcast to every consumer (participants and observers).

- All consumers see the queued message with pending styling
- Edits and cancellations are broadcast in real-time
- While the sender is actively editing (between pressing ↑ and Enter), others see the last committed version
- Only the sender can edit or cancel their queued message
- Other participants' composers are blocked while a message is queued

## Protocol Changes

### New Inbound Messages (frontend → backend)

```typescript
| { type: "queue_message"; content: string; images?: Image[] }
| { type: "update_queued_message"; content: string; images?: Image[] }
| { type: "cancel_queued_message" }
```

### New Outbound Messages (backend → all consumers)

```typescript
| { type: "message_queued"; consumer_id: string; display_name: string; content: string; images?: Image[]; queued_at: number }
| { type: "queued_message_updated"; content: string; images?: Image[] }
| { type: "queued_message_cancelled" }
| { type: "queued_message_sent" }
```

## State Management

### Backend (`session-bridge.ts`)

Session gains a `queuedMessage` slot:

```typescript
queuedMessage: {
  consumerId: string;
  displayName: string;
  content: string;
  images?: Image[];
  queuedAt: number;
} | null;
```

Flow:
1. Receive `queue_message` while session is `running`
2. Store in session's `queuedMessage` slot
3. Broadcast `message_queued` to all consumers
4. On edit/cancel: update slot, broadcast change
5. When current task completes (session → `idle`): process queued message as normal `user_message`, broadcast the real message, clear the slot

### Frontend (`store.ts`)

Per-session additions:

```typescript
queuedMessage: {
  consumerId: string;
  displayName: string;
  content: string;
  images?: Image[];
  queuedAt: number;
} | null;

isEditingQueue: boolean;
```

The queued message is NOT in the `messages[]` array. It's rendered as a separate `QueuedMessage` component in the feed.

## Component Changes

| Component | Change |
|-----------|--------|
| `QueuedMessage.tsx` | **New** — dimmed bubble with pulsing dot, FLIP animation ref |
| `MessageFeed.tsx` | Render `QueuedMessage` after current messages, before streaming indicator |
| `Composer.tsx` | Add ↑ arrow handler, manage disabled/editing states, check session status before sending |
| `store.ts` | Add `queuedMessage`, `isEditingQueue` state and actions |
| `ws.ts` | Handle new outbound message types, add send helpers for queue actions |
| `session-bridge.ts` | Add `queuedMessage` slot, handle new inbound types, auto-send on idle |
| `consumer-types.ts` | Add new message type definitions |

## Edge Cases

**WebSocket disconnect while message is queued:**
- Backend holds the queued message; it persists through consumer reconnects
- Frontend shows warning icon instead of pulsing dot: "Queued — reconnecting..."

**User interrupts current task (Escape):**
- Current task interrupted, backend transitions to `idle`
- Queued message sends automatically (expected: "stop that, do this instead")

**Session navigation:**
- Queued message is per-session, stays with its session
- Switching back shows it still pending

**FLIP animation timing:**
- Use `requestAnimationFrame` to ensure the echoed `user_message` doesn't render before the animation completes
- Suppress echo rendering briefly, let animation finish, then swap in the real message

**Images in queued messages:**
- Images queue alongside text, shown as dimmed thumbnails
- Editing via ↑ loads text only; images stay attached unless the whole message is cancelled

## CSS Additions

```css
.queued-message { opacity: 0.5; transition: opacity 300ms ease; }
.queued-dot { /* pulsing animation */ }
.queued-message--sending { /* FLIP transition class */ }
```
