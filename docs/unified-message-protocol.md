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
                                    │  UnifiedMessage  │  ← 18 types, 5 content types
                                    └────────┬────────┘
                                             │
                                    ┌────────▼────────┐
                                    │  Message Router  │  ← handles 9 of 18 types
                                    └────────┬────────┘
                                             │
                                    ┌────────▼────────┐
                                    │ Consumer Mapper  │  ← maps 9 types to consumer
                                    └────────┬────────┘
                                             │
                                    ┌────────▼────────┐
                                    │   Frontend UI    │
                                    └─────────────────┘
```

## 2. Current UnifiedMessage Type Coverage

**18 types defined**, but only **9 have router handlers** and **9 have consumer mappers**:

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
| `user_message` | NO | NO | NO |
| `permission_response` | NO | NO | NO |
| `interrupt` | NO | NO | NO |
| `configuration_change` | **NO** | NO | **NO** |
| `team_message` | NO | NO | NO |
| `team_task_update` | NO | NO | NO |
| `team_state_change` | NO | NO | NO |
| `unknown` | NO | NO | NO |

`user_message`, `permission_response`, `interrupt` are intentionally bridge-handled (consumer→backend). `team_*` types update state via reducer. But `configuration_change` and `unknown` silently vanish.

## 3. UnifiedContent Type Coverage

**5 types defined:**

| Content Type | Used By | Consumer Mapper |
|---|---|:---:|
| `text` | All adapters | YES |
| `tool_use` | Claude, Codex, Agent SDK | YES |
| `tool_result` | Claude, Codex, Agent SDK | YES |
| `code` | (none currently) | **NO — erased to empty text** |
| `image` | ACP inbound | **NO — erased to empty text** |

Consumer mapper `default` case at `consumer-message-mapper.ts:45-46` converts `code`/`image` to `{ type: "text", text: "" }`.

## 4. Gap Analysis

### GAP 1: Missing `thinking` / `reasoning` Content Type

**Severity: HIGH** — Affects 4 of 6 adapters

| Adapter | Source | Current Handling | Loss |
|---|---|---|---|
| **Claude** | `thinking` content block | Downconverted to `{ type: "text" }` | Semantic type lost |
| **OpenCode** | `reasoning` part | `stream_event` with `reasoning: true` metadata | Not in content system |
| **ACP/Gemini** | `agent_thought_chunk` | `stream_event` with `thought: true` metadata | Metadata workaround |
| **Agent SDK** | `thinking` block (if present) | Falls to default → empty text | **Completely erased** |

Consumer types already define `{ type: "thinking"; thinking: string; budget_tokens?: number }` at `consumer-messages.ts:23`. Frontend already renders it. Gap is purely in translation layers.

### GAP 2: No Structured Error Type

**Severity: HIGH** — Affects all 6 adapters

| Adapter | Error Subtypes | Current Handling |
|---|---|---|
| **Claude** | `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries` | Flat `subtype` string in `result` metadata |
| **Codex** | Error object with status | `is_error: true` in `result` |
| **OpenCode** | `provider_auth`, `output_length`, `aborted`, `context_overflow`, `api_error`, `unknown` | Flattened to `is_error: true` |
| **ACP/Gemini** | Generic error | `is_error: true` in `result` |
| **Agent SDK** | Generic `is_error` | No subtypes |

Consumer cannot distinguish rate limits from auth failures from context overflow.

### GAP 3: `configuration_change` — No Router Handler

**Severity: MEDIUM** — Affects ACP, Gemini, OpenCode

Type exists, adapters produce it, router switch at `unified-message-router.ts:87-118` has no case. ACP `current_mode_update` and inbound `set_model`/`set_permission_mode` all fall through silently after state reduction.

### GAP 4: Session Lifecycle Events Dropped

**Severity: MEDIUM** — Affects OpenCode, ACP

| Event | Signal | Status |
|---|---|---|
| `session.compacted` | Context window compacted | **Dropped** |
| `session.created` | New session | **Dropped** |
| `session.updated` | Session metadata changed | **Dropped** |
| `session.deleted` | Session removed | **Dropped** |
| `session.diff` | Differential state update | **Dropped** |
| `message.removed` | Message deleted/rolled back | **Dropped** |
| `message.part.removed` | Part removed | **Dropped** |

Consumer never knows context was compacted; UI shows stale messages the backend discarded.

### GAP 5: `available_commands_update` Swallowed

**Severity: MEDIUM** — Affects ACP, Gemini

ACP agents dynamically update commands. Mapped to `unknown` in `outbound-translator.ts`, router ignores it. Frontend can't show dynamic agent commands.

### GAP 6: Agent SDK Feature-Sparse

**Severity: MEDIUM** — Agent SDK only

| Feature | Claude | Codex | OpenCode | ACP | Agent SDK |
|---|:---:|:---:|:---:|:---:|:---:|
| Streaming deltas | — | YES | YES | YES | **NO** |
| Tool progress | YES | YES | YES | YES | **NO** |
| Thinking/reasoning | YES | — | YES | YES | **NO** |
| Error subtypes | YES | YES | YES | — | **NO** |
| Token usage | YES | — | YES | — | **NO** |
| Session lifecycle | — | — | YES | — | **NO** |

### GAP 7: Codex Drops Tool Items in Response Payloads

**Severity: MEDIUM** — Codex only

`codex-session.ts` `enqueueResponseItems()`: `if (item.type !== "message") continue` — `function_call` and `function_call_output` items completely lost when Codex uses non-streaming response path.

### GAP 8: Step Boundaries Dropped

**Severity: LOW** — OpenCode only

`step-start`/`step-finish` parts return `null`. Consumer can't show step-by-step execution progress.

### GAP 9: No `refusal` Content Type

**Severity: LOW** — Codex only

`refusal` content parts prefixed as `[Refusal] <text>` and treated as plain text. Semantic signal lost.

### GAP 10: `image`/`code` Content Types Erased

**Severity: LOW** — Defined but broken

Both exist in `UnifiedContent` union but consumer mapper default case converts them to `{ type: "text", text: "" }`.

## 5. Cross-Adapter Feature Matrix

| Capability | Claude | Codex | OpenCode | ACP/Gemini | Agent SDK | Unified Protocol |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Text streaming | `stream_event` | `output_text.delta` | `part.updated` | `message_chunk` | NO | `stream_event` (YES) |
| Thinking/reasoning | `thinking` block | — | `reasoning` part | `thought_chunk` | — | **MISSING** |
| Tool invocation | `tool_progress` | `item.added` | tool `running` | `tool_call` | — | `tool_progress` (YES) |
| Tool completion | `tool_use_summary` | `item.done` | tool `completed` | `tool_call_update` | — | `tool_use_summary` (YES) |
| Tool pending | — | — | tool `pending` | — | — | **DROPPED** |
| Permission request | `control_request` | `approval_requested` | `permission.updated` | `request_permission` | Promise callback | `permission_request` (YES) |
| Error subtypes | 5 subtypes | error object | 6 subtypes | generic | generic | **FLATTENED** |
| Session compaction | `status:compacting` | — | `session.compacted` | — | — | Partial |
| Message removal | — | — | `message.removed` | — | — | **MISSING** |
| Step boundaries | — | — | `step-start/finish` | — | — | **MISSING** |
| Dynamic commands | — | — | — | `commands_update` | — | **SWALLOWED** |
| Mode/config change | — | — | — | `current_mode_update` | — | **NOT BROADCAST** |
| Refusal | — | `refusal` part | — | — | — | **FLATTENED** |
| Token usage | Full | — | Full | — | cost_usd only | Partial |
| Image content | — | — | — | YES (inbound) | — | Defined, **ERASED** |
| Code content | — | — | — | — | — | Defined, **ERASED** |
| Auth flow | `auth_status` | — | — | — | — | Claude-only |
| Teams | YES | — | — | NO | — | 3 types (state-only) |
| Session lifecycle | — | `thread/started` | 7 events | — | — | **MISSING** |

## 6. Complete Silent Drop Inventory

**25 distinct silent drop points across the stack:**

| # | Layer | File | What's Dropped |
|---|---|---|---|
| 1 | Claude adapter | `message-translator.ts:50` | `keep_alive` messages → `null` |
| 2 | Claude adapter | `message-translator.ts:50` | `user` echo messages → `null` |
| 3 | Claude adapter | `message-translator.ts:52` | Unknown CLI types → `null` |
| 4 | Claude adapter | `message-translator.ts:119` | Unknown content blocks → empty text |
| 5 | Codex adapter | `codex-message-translator.ts:107` | Unknown event types → `null` |
| 6 | Codex adapter | `codex-session.ts:665` | `function_call` + `function_call_output` in responses |
| 7 | OpenCode adapter | `opencode-message-translator.ts:46` | `server.heartbeat` → `null` |
| 8 | OpenCode adapter | `opencode-message-translator.ts:47` | `permission.replied` → `null` |
| 9 | OpenCode adapter | `opencode-message-translator.ts:48` | `session.compacted` → `null` |
| 10 | OpenCode adapter | `opencode-message-translator.ts:49` | `session.created` → `null` |
| 11 | OpenCode adapter | `opencode-message-translator.ts:50` | `session.updated` → `null` |
| 12 | OpenCode adapter | `opencode-message-translator.ts:51` | `session.deleted` → `null` |
| 13 | OpenCode adapter | `opencode-message-translator.ts:52` | `session.diff` → `null` |
| 14 | OpenCode adapter | `opencode-message-translator.ts:53` | `message.removed` → `null` |
| 15 | OpenCode adapter | `opencode-message-translator.ts:54` | `message.part.removed` → `null` |
| 16 | OpenCode adapter | `opencode-message-translator.ts:57` | Unknown event types → `null` |
| 17 | OpenCode adapter | `opencode-message-translator.ts:134` | `step-start`/`step-finish` → `null` |
| 18 | OpenCode adapter | `opencode-message-translator.ts:189` | Tool `pending` state → `null` |
| 19 | ACP adapter | `outbound-translator.ts:60` | Unknown session updates → `unknown` type |
| 20 | ACP adapter | `acp-session.ts:246` | `fs/*`, `terminal/*` requests → error stub |
| 21 | Router | `unified-message-router.ts:118` | `configuration_change` — no case |
| 24 | Router | `unified-message-router.ts:118` | `unknown` — no case |
| 25 | Consumer mapper | `consumer-message-mapper.ts:46` | `code`/`image` content → empty text |

## 7. Metadata Key Inconsistencies

| Concept | Claude/Codex/OpenCode/SDK | ACP | Issue |
|---|---|---|---|
| Session ID | `session_id` (snake_case) | `sessionId` (camelCase) | Inconsistent |
| Tool call ID | `tool_use_id` / `call_id` | `toolCallId` | 3 different keys |
| Error flag | `is_error` | `is_error` | Consistent |
| Error detail | `error` (string) | — | OpenCode has `error_name` + `error_message` |
| Tool status | `status` / `done` | `status` | Codex uses boolean `done`, others use string |
| Thinking flag | — | `thought: true` | OpenCode uses `reasoning: true` |

---

# Part 2: Implementation Plan

## Context

An audit of all 6 backend adapters (Claude, Codex, OpenCode, ACP, Gemini, Agent SDK) against the unified message protocol revealed **25 silent drop points** where data is discarded without trace. Key findings:

- **Thinking/reasoning** content from 4 adapters is downconverted or erased, despite the consumer already supporting `{ type: "thinking" }` blocks
- **`configuration_change`** messages are produced by adapters but the router has no handler — they vanish
- **`image`/`code`** content types are defined in `UnifiedContent` but the consumer mapper erases them to empty text
- **Error semantics** differ wildly across adapters (OpenCode has 6 subtypes, Claude has 5, Codex has objects) — all flattened
- **Codex** drops `function_call`/`function_call_output` items in non-streaming response payloads
- **Agent SDK** has no streaming, no tool progress, no thinking support
- **OpenCode** lifecycle events (compaction, message removal) and step boundaries all silently dropped
- **ACP** `available_commands_update` mapped to `unknown` and swallowed

## Approach

Three independently shippable tiers. Each tier has its own worktree branch. Within each tier, changes are ordered by dependency.

---

## TIER 1 — High Impact, Low Effort

### 1.1 Add `ThinkingContent` to `UnifiedContent`

The consumer types already define `{ type: "thinking"; thinking: string; budget_tokens?: number }` at `consumer-messages.ts:23` and `shared/consumer-types.ts:16`. The frontend already renders it. The gap is purely in the unified layer and adapter translators.

**Files to modify:**

| File | Change |
|------|--------|
| `src/core/types/unified-message.ts` | Add `ThinkingContent` interface, add to `UnifiedContent` union, add `isThinkingContent` type guard |
| `src/adapters/claude/message-translator.ts` | `case "thinking"` → produce `ThinkingContent` instead of `{ type: "text", text: block.thinking }` |
| `src/adapters/opencode/opencode-message-translator.ts` | `"reasoning"` parts → produce `ThinkingContent` in content array (keep `reasoning: true` metadata for compat) |
| `src/adapters/acp/outbound-translator.ts` | `agent_thought_chunk` → produce `ThinkingContent` in content array (keep `thought: true` metadata for compat) |
| `src/core/consumer-message-mapper.ts` | Add `case "thinking"` in `mapAssistantMessage` → `{ type: "thinking", thinking: block.thinking, budget_tokens: block.budget_tokens }` |

**Dependency order:** `unified-message.ts` → adapters (parallel) → `consumer-message-mapper.ts`

### 1.2 Add `configuration_change` Router Handler

The type exists, adapters produce it, but `unified-message-router.ts:87-118` has no switch case. ACP mode changes and command updates are invisible to the frontend.

**Files to modify:**

| File | Change |
|------|--------|
| `src/types/consumer-messages.ts` | Add `configuration_change` variant to `ConsumerMessage` union |
| `shared/consumer-types.ts` | Mirror the same variant |
| `src/core/consumer-message-mapper.ts` | Add `mapConfigurationChange()` function |
| `src/core/session-state-reducer.ts` | Add `case "configuration_change"` to update `model`/`permissionMode` from metadata |
| `src/core/unified-message-router.ts` | Add `case "configuration_change"` that broadcasts + persists |

**Dependency order:** consumer types → mapper → reducer → router

### 1.3 Fix Consumer Mapper for `image`/`code` Content Blocks

Both types exist in `UnifiedContent` but `consumer-message-mapper.ts:45-46` default case erases them to `{ type: "text", text: "" }`.

**Files to modify:**

| File | Change |
|------|--------|
| `src/types/consumer-messages.ts` | Add `code` and `image` variants to `ConsumerContentBlock` |
| `shared/consumer-types.ts` | Mirror the same variants |
| `src/core/consumer-message-mapper.ts` | Add `case "code"` and `case "image"` in `mapAssistantMessage` |

**Dependency order:** consumer types → mapper

---

## TIER 2 — High Impact, Medium Effort

### 2.1 Standardize Error Metadata Schema

Define a canonical `UnifiedErrorMeta` interface. Normalize each adapter's error path to produce consistent `error_code`, `error_message`, `error_source` keys.

**Files to modify:**

| File | Change |
|------|--------|
| `src/core/types/unified-message.ts` | Add `UnifiedErrorMeta` interface (documentation + type) |
| `src/adapters/opencode/opencode-message-translator.ts` | Map 6 error names → canonical `error_code` values |
| `src/adapters/codex/codex-message-translator.ts` | Map `response.failed` → `error_code: "execution_error"` |
| `src/adapters/codex/codex-session.ts` | Map `codex/event/error` → canonical error codes |
| `src/adapters/claude/message-translator.ts` | Map 5 `error_*` subtypes → canonical `error_code` values |
| `src/core/consumer-message-mapper.ts` | Update `mapResultMessage` to surface `error_code`/`error_message` |
| `src/types/consumer-messages.ts` | Add optional `error_code`/`error_message` fields to `ResultData` |
| `shared/consumer-types.ts` | Mirror the same fields |

**Canonical error codes:**
```
provider_auth | api_error | context_overflow | output_length |
aborted | rate_limit | max_turns | max_budget | execution_error | unknown
```

### 2.2 Handle Codex Tool Items in Response Payloads

`codex-session.ts` `enqueueResponseItems()` at line 665: `if (item.type !== "message") continue` drops `function_call` and `function_call_output` items.

**Files to modify:**

| File | Change |
|------|--------|
| `src/adapters/codex/codex-session.ts` | Extend loop to handle `function_call` → `tool_progress` and `function_call_output` → `tool_use_summary` |

---

## TIER 3 — Medium Impact

### 3.1 Add `session_lifecycle` Message Type

Map OpenCode's `session.compacted` and `message.removed` events (most valuable of the 7 dropped lifecycle events). Other lifecycle events (`session.created/updated/deleted`, `session.diff`, `message.part.removed`) remain dropped as they're metadata-only.

**Files to modify:**

| File | Change |
|------|--------|
| `src/core/types/unified-message.ts` | Add `"session_lifecycle"` to `UnifiedMessageType` + `VALID_MESSAGE_TYPES` |
| `src/adapters/opencode/opencode-message-translator.ts` | `session.compacted` and `message.removed` → `session_lifecycle` instead of `null` |
| `src/core/unified-message-router.ts` | Add `case "session_lifecycle"` handler |
| `src/core/consumer-message-mapper.ts` | Add `mapSessionLifecycle()` |
| `src/types/consumer-messages.ts` + `shared/consumer-types.ts` | Add `session_lifecycle` consumer type |

### 3.2 Route `available_commands_update` via `configuration_change`

**Files to modify:**

| File | Change |
|------|--------|
| `src/adapters/acp/outbound-translator.ts` | Change from `type: "unknown"` to `type: "configuration_change"` with `subtype: "available_commands_update"` |

Depends on Tier 1.2 (configuration_change router case).

### 3.3 Map OpenCode Step Boundaries

**Files to modify:**

| File | Change |
|------|--------|
| `src/adapters/opencode/opencode-message-translator.ts` | `step-start`/`step-finish` → `status_change` with step metadata |

Uses existing `status_change` router handler — no router changes needed.

### 3.4 Add `RefusalContent` Type

**Files to modify:**

| File | Change |
|------|--------|
| `src/core/types/unified-message.ts` | Add `RefusalContent` to `UnifiedContent` union |
| `src/adapters/codex/codex-message-translator.ts` | Produce `RefusalContent` instead of `[Refusal]` text prefix |
| `src/core/consumer-message-mapper.ts` | Map refusal → text with `[Refusal]` prefix for backward compat |

---

## Metadata Key Convention

- **All new canonical keys** use `snake_case` (matching majority of codebase)
- **Existing keys are NOT renamed** (backwards compatibility)
- **ACP adapter**: normalize new keys at boundary (e.g. `sessionId` → `session_id` for new fields only)

---

## Dependency Graph

```
Tier 1.1 (ThinkingContent) ──────┐
Tier 1.2 (configuration_change) ─┤── Tier 2.1 (error schema)
Tier 1.3 (image/code blocks) ────┘   Tier 2.2 (Codex tool items) [standalone]
                                      Tier 2.3 (Agent SDK) [depends on 1.1]
                                          │
Tier 1.2 ──── Tier 3.2 (commands)         │
              Tier 3.1 (lifecycle) ────────┤
              Tier 3.3 (steps) [standalone]│
Tier 1.1 ──── Tier 3.4 (refusal)          │
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
