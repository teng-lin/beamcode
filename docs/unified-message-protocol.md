# Unified Message Protocol — Discovery Report & Gap Closure Plan

---

# Part 1: Discovery Report

## 1. Protocol Architecture

```
┌──────────────┐   ┌─────────────┐    ┌─────────────┐   ┌──────────┐   ┌─────────┐
│   Claude     │   │   Codex     │    │  OpenCode   │   │   ACP    │   │ Gemini  │
│  (CLI/NDJSON)│   │ (JSON-RPC)  │    │   (SSE)     │   │(JSON-RPC)│   │ (→ACP)  │
└──────┬───────┘   └──────┬──────┘    └──────┬──────┘   └────┬─────┘   └────┬────┘
       │                  │                  │               │              │
       ▼                  ▼                  ▼               ▼              ▼
   message-          codex-message-     opencode-message-  outbound-     (delegates
   translator.ts     translator.ts      translator.ts      translator.ts  to ACP)
       │                  │                  │               │
       └──────────────────┴──────────────────┴───────────────┘
                                             │
                                    ┌────────▼────────┐
                                    │  UnifiedMessage │  ← 19 types, 7 content types
                                    └────────┬────────┘
                                             │
                                    ┌────────▼────────┐
                                    │  Message Router │  ← handles 12 of 19 types (+default)
                                    └────────┬────────┘
                                             │
                                    ┌────────▼────────┐
                                    │ Consumer Mapper │  ← maps 12 types to consumer
                                    └────────┬────────┘
                                             │
                                    ┌────────▼────────┐
                                    │   Frontend UI   │
                                    └─────────────────┘
```

## 2. Current UnifiedMessage Type Coverage

**19 types defined**, **12 have router handlers**, **12 have consumer mappers**, and **1 has a default trace handler**:

| UnifiedMessageType | Router Handler | Consumer Mapper | Broadcast to UI |
|---|:---:|:---:|:---:|
| `session_init` | YES | YES | YES |
| `status_change` | YES | YES | YES |
| `assistant` | YES | YES | YES |
| `result` | YES | YES | YES |
| `stream_event` | YES | YES | YES |
| `permission_request` | YES | YES | YES |
| `control_response` | YES (delegates) | NO | NO |
| `tool_progress` | YES | YES | YES |
| `tool_use_summary` | YES | YES | YES |
| `auth_status` | YES | YES | YES |
| `configuration_change` | YES | YES | YES |
| `session_lifecycle` | YES | YES | YES |
| `user_message` | NO | NO | NO |
| `permission_response` | NO | NO | NO |
| `interrupt` | NO | NO | NO |
| `team_message` | NO — reserved | NO — reserved | NO |
| `team_task_update` | NO — reserved | NO — reserved | NO |
| `team_state_change` | NO — reserved | NO — reserved | NO |
| `unknown` | default (traced) | NO | NO |

`user_message`, `permission_response`, `interrupt` are intentionally bridge-handled (consumer→backend). `team_*` types are reserved for the tool-correlation taxonomy in `team-tool-recognizer.ts` — they are never emitted as routable messages. `unknown` is traced via the router's default case for diagnosability.

## 3. UnifiedContent Type Coverage

**7 types defined:**

| Content Type | Used By | Consumer Mapper |
|---|---|:---:|
| `text` | All adapters | YES |
| `tool_use` | Claude, Codex | YES |
| `tool_result` | Claude, Codex | YES |
| `thinking` | Claude, OpenCode, ACP | YES |
| `refusal` | Codex | YES |
| `code` | (none currently) | YES |
| `image` | ACP inbound | YES |

## 4. Gap Analysis

### ~~GAP 1: Missing `thinking` / `reasoning` Content Type~~ — RESOLVED

`ThinkingContent` added to `UnifiedContent` union. Claude, OpenCode, and ACP adapters now produce `{ type: "thinking" }` content blocks. Consumer mapper handles it.

### ~~GAP 2: No Structured Error Type~~ — RESOLVED

`UnifiedErrorMeta` interface and `UnifiedErrorCode` type added to `unified-message.ts`. All adapters (Claude, Codex, OpenCode, ACP) now produce canonical `error_code` values in result metadata. Canonical codes: `provider_auth | api_error | context_overflow | output_length | aborted | rate_limit | max_turns | max_budget | execution_error | unknown`.

### ~~GAP 3: `configuration_change` — No Router Handler~~ — RESOLVED

Router now has `case "configuration_change"` handler. State reducer handles it. Consumer mapper broadcasts to UI.

### ~~GAP 4: Session Lifecycle Events Dropped~~ — PARTIALLY RESOLVED

`session.compacted` and `message.removed` now produce `session_lifecycle` messages with `subtype` metadata. Router and consumer mapper handle them. Remaining 5 events (`session.created/updated/deleted`, `session.diff`, `message.part.removed`) are intentionally still dropped as metadata-only.

### ~~GAP 5: `available_commands_update` Swallowed~~ — RESOLVED

Now routed as `configuration_change` with `subtype: "available_commands_update"`. Frontend receives it via the `configuration_change` handler.

### ~~GAP 6: Codex Drops Tool Items in Response Payloads~~ — RESOLVED

`enqueueResponseItems()` now delegates to `translateResponseItem()` which handles `function_call` → `tool_progress` and `function_call_output` → `tool_use_summary`.

### ~~GAP 7: Step Boundaries Dropped~~ — RESOLVED

`step-start`/`step-finish` now mapped to `status_change` with step metadata (`step: "start"|"finish"`, `step_id`, `message_id`).

### ~~GAP 8: No `refusal` Content Type~~ — RESOLVED

`RefusalContent` added to `UnifiedContent` union. Codex adapter produces `{ type: "refusal", refusal: ... }`. Consumer mapper handles `case "refusal"`.

### ~~GAP 9: `image`/`code` Content Types Erased~~ — RESOLVED

Consumer mapper now has proper `case "code"` and `case "image"` handlers.

## 5. Cross-Adapter Feature Matrix

| Capability | Claude | Codex | OpenCode | ACP/Gemini | Unified Protocol |
|---|:---:|:---:|:---:|:---:|:---:|
| Text streaming | `stream_event` | `output_text.delta` | `part.updated` | `message_chunk` | `stream_event` (YES) |
| Thinking/reasoning | `thinking` block | — | `reasoning` part | `thought_chunk` | `ThinkingContent` (YES) |
| Tool invocation | `tool_progress` | `item.added` | tool `running` | `tool_call` | `tool_progress` (YES) |
| Tool completion | `tool_use_summary` | `item.done` | tool `completed` | `tool_call_update` | `tool_use_summary` (YES) |
| Tool pending | — | — | tool `pending` | — | `tool_progress` (YES) |
| Permission request | `control_request` | `approval_requested` | `permission.updated` | `request_permission` | `permission_request` (YES) |
| Error subtypes | 5 subtypes | classified | 6 subtypes | `error_code` | `UnifiedErrorCode` (YES) |
| Session compaction | `status:compacting` | — | `session.compacted` | — | `session_lifecycle` (YES) |
| Message removal | — | — | `message.removed` | — | `session_lifecycle` (YES) |
| Step boundaries | — | — | `step-start/finish` | — | `status_change` (YES) |
| Dynamic commands | — | — | — | `commands_update` | `configuration_change` (YES) |
| Mode/config change | — | — | — | `current_mode_update` | `configuration_change` (YES) |
| Refusal | — | `refusal` part | — | — | `RefusalContent` (YES) |
| Token usage | Full | — | Full | — | Partial (not available from Codex/ACP upstream) |
| Image content | — | — | — | YES (inbound) | `ImageContent` (YES) |
| Code content | — | — | — | — | `CodeContent` (YES) |
| Auth flow | `auth_status` | — | — | YES | `auth_status` (YES) |
| Teams | YES | — | — | NO | 3 types (state-only) |
| Session lifecycle | — | `thread/started` | 7 events | — | `session_lifecycle` (partial — 2 of 7) |

## 6. Complete Silent Drop Inventory

**15 remaining silent drop points** (8 resolved since initial audit):

| # | Layer | File | What's Dropped |
|---|---|---|---|
| 1 | Claude adapter | `message-translator.ts` | `keep_alive` messages → `null` |
| 2 | Claude adapter | `message-translator.ts` | `user` echo messages → `null` |
| 3 | Claude adapter | `message-translator.ts` | Unknown CLI types → `null` |
| 4 | Claude adapter | `message-translator.ts` | Unknown content blocks → empty text |
| 5 | Codex adapter | `codex-message-translator.ts` | Unknown event types → `null` |
| ~~6~~ | ~~Codex adapter~~ | ~~`codex-session.ts`~~ | ~~`function_call` + `function_call_output` in responses~~ — **RESOLVED** |
| 7 | OpenCode adapter | `opencode-message-translator.ts` | `server.heartbeat` → `null` |
| 8 | OpenCode adapter | `opencode-message-translator.ts` | `permission.replied` → `null` |
| ~~9~~ | ~~OpenCode adapter~~ | ~~`opencode-message-translator.ts`~~ | ~~`session.compacted` → `null`~~ — **RESOLVED** (now → `session_lifecycle`) |
| 10 | OpenCode adapter | `opencode-message-translator.ts` | `session.created` → `null` |
| 11 | OpenCode adapter | `opencode-message-translator.ts` | `session.updated` → `null` |
| 12 | OpenCode adapter | `opencode-message-translator.ts` | `session.deleted` → `null` |
| 13 | OpenCode adapter | `opencode-message-translator.ts` | `session.diff` → `null` |
| ~~14~~ | ~~OpenCode adapter~~ | ~~`opencode-message-translator.ts`~~ | ~~`message.removed` → `null`~~ — **RESOLVED** (now → `session_lifecycle`) |
| 15 | OpenCode adapter | `opencode-message-translator.ts` | `message.part.removed` → `null` |
| 16 | OpenCode adapter | `opencode-message-translator.ts` | Unknown event types → `null` |
| ~~17~~ | ~~OpenCode adapter~~ | ~~`opencode-message-translator.ts`~~ | ~~`step-start`/`step-finish` → `null`~~ — **RESOLVED** (now → `status_change`) |
| ~~18~~ | ~~OpenCode adapter~~ | ~~`opencode-message-translator.ts`~~ | ~~Tool `pending` state → `null`~~ — **RESOLVED** (now → `tool_progress`) |
| 19 | ACP adapter | `outbound-translator.ts` | Unknown session updates → `unknown` type |
| 20 | ACP adapter | `acp-session.ts` | `fs/*`, `terminal/*` requests → error stub |
| ~~21~~ | ~~Router~~ | ~~`unified-message-router.ts`~~ | ~~`configuration_change` — no case~~ — **RESOLVED** |
| ~~22~~ | ~~Router~~ | ~~`unified-message-router.ts`~~ | ~~`unknown` — no case~~ — **RESOLVED** (now traced via default case) |
| ~~23~~ | ~~Consumer mapper~~ | ~~`consumer-message-mapper.ts`~~ | ~~`code`/`image` content → empty text~~ — **RESOLVED** |

## 7. Metadata Key Inconsistencies

| Concept | Claude/Codex/OpenCode | ACP | Status |
|---|---|---|---|
| Session ID | `session_id` (snake_case) | `session_id` (normalized) | **RESOLVED** — all adapters now emit `session_id` |
| Tool call ID | `tool_use_id` | `tool_use_id` (normalized) | **RESOLVED** — all adapters now emit `tool_use_id` |
| Error flag | `is_error` | `is_error` | Consistent |
| Error detail | `error` (string) | — | OpenCode has `error_name` + `error_message` |
| Error code | `error_code` (canonical) | `error_code` | **RESOLVED** — Codex now classifies errors to canonical `UnifiedErrorCode` |
| Tool status | `status` / `done` | `status` | Codex uses boolean `done`, others use string |
| Thinking flag | — | `thought: true` | OpenCode uses `reasoning: true` |

---

# Part 2: Implementation Plan

## Context

An audit of all 5 backend adapters (Claude, Codex, OpenCode, ACP, Gemini) against the unified message protocol originally revealed **23 silent drop points** where data was discarded without trace. **All planned gaps have been closed** — 15 remaining drop points, mostly intentional (heartbeats, metadata-only lifecycle events).

## Approach

Three independently shippable tiers. Each tier has its own worktree branch. Within each tier, changes are ordered by dependency.

---

## ~~TIER 1 — High Impact, Low Effort~~ — DONE

All three items completed:
- **1.1** `ThinkingContent` added to `UnifiedContent`. Claude, OpenCode, ACP adapters produce it. Consumer mapper handles it.
- **1.2** `configuration_change` has router handler, state reducer case, and consumer mapper.
- **1.3** `code` and `image` content blocks properly mapped in consumer mapper.

---

## ~~TIER 2 — High Impact, Medium Effort~~ — DONE

Both items completed:
- **2.1** `UnifiedErrorMeta` interface and `UnifiedErrorCode` type added. All adapters produce canonical `error_code` values.
- **2.2** `enqueueResponseItems()` → `translateResponseItem()` now handles `function_call` and `function_call_output`.

---

## ~~TIER 3 — Medium Impact~~ — DONE

All four items completed:
- **3.1** `session_lifecycle` message type added. OpenCode `session.compacted` and `message.removed` now produce it. Router + consumer mapper handle it.
- **3.2** `available_commands_update` routed via `configuration_change` with subtype.
- **3.3** OpenCode `step-start`/`step-finish` mapped to `status_change` with step metadata.
- **3.4** `RefusalContent` added to `UnifiedContent`. Codex adapter produces it. Consumer mapper handles it.

---

## Metadata Key Convention

- **All canonical keys** use `snake_case` (matching codebase convention)
- **All adapters** normalize metadata keys at the adapter boundary:
  - ACP: `sessionId` → `session_id`, `toolCallId` → `tool_use_id`
  - Codex: `call_id` → `tool_use_id`
  - OpenCode: `call_id` → `tool_use_id`
- **Consumer mapper** no longer needs multi-key fallbacks — all adapters emit `tool_use_id`

---

## Dependency Graph

All tiers completed:

```
✅ Tier 1.1 (ThinkingContent) ──────┐
✅ Tier 1.2 (configuration_change) ─┤── ✅ Tier 2.1 (error schema)
✅ Tier 1.3 (image/code blocks) ────┘   ✅ Tier 2.2 (Codex tool items)

✅ Tier 1.2 ──── ✅ Tier 3.2 (commands)
                 ✅ Tier 3.1 (lifecycle)
                 ✅ Tier 3.3 (steps)
✅ Tier 1.1 ──── ✅ Tier 3.4 (refusal)
```

---

## Verification

Per tier:
1. `npx tsc --noEmit` — type safety
2. `npx vitest run src/core/types/unified-message.test.ts` — type guard regressions
3. `npx vitest run src/core/consumer-message-mapper.test.ts` — mapper regressions
4. `npx vitest run src/adapters/{affected}/` — adapter-specific tests
5. `npx vitest run` — full suite
6. `npx vitest run src/e2e/` — e2e integration

Each tier gets its own commit(s) on a feature branch created from a worktree.
