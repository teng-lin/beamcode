# Unified Message Protocol — Discovery Report & Gap Closure Plan

*Last updated: 2026-02-21*

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
                                ┌────────────┼────────────────┐
                                ▼                             ▼
                       ┌────────────────┐           ┌──────────────────┐
                       │  State Reducer │           │  Message Router  │
                       │ (team state +  │           │ (12 switch cases │
                       │  config state) │           │  + default trace)│
                       └────────────────┘           └────────┬─────────┘
                                                             │
                                                    ┌────────▼────────┐
                                                    │ Consumer Mapper │  ← maps 10 types to consumer
                                                    └────────┬────────┘
                                                             │
                                                    ┌────────▼────────┐
                                                    │   Frontend UI   │
                                                    └─────────────────┘
```

Note: The state reducer runs **before** the router switch on every message. It handles `configuration_change`, `session_lifecycle`, and team tool-use correlation (scanning content blocks for team tool invocations). Team state changes are broadcast via `emitTeamEvents()` after reduction, not through the router switch.

## 2. Current UnifiedMessage Type Coverage

**19 types defined**, **12 have router switch handlers**, **10 have consumer mappers**, and **1 has a default trace handler**:

| UnifiedMessageType | Router Switch | Consumer Mapper | State Reducer | Broadcast to UI |
|---|:---:|:---:|:---:|:---:|
| `session_init` | YES | — (direct) | — | YES |
| `status_change` | YES | — (direct) | — | YES |
| `assistant` | YES | YES | — | YES |
| `result` | YES | YES | — | YES |
| `stream_event` | YES | YES | — | YES |
| `permission_request` | YES | YES (filtered) | — | YES |
| `control_response` | YES (delegates) | — | — | NO |
| `tool_progress` | YES | YES | — | YES |
| `tool_use_summary` | YES | YES | — | YES |
| `auth_status` | YES | YES | — | YES |
| `configuration_change` | YES | YES | YES | YES |
| `session_lifecycle` | YES | YES | — | YES |
| `user_message` | NO | NO | — | NO |
| `permission_response` | NO | NO | — | NO |
| `interrupt` | NO | NO | — | NO |
| `team_message` | NO — taxonomy only | NO | YES (via correlation) | YES (via team diff) |
| `team_task_update` | NO — taxonomy only | NO | YES (via correlation) | YES (via team diff) |
| `team_state_change` | NO — taxonomy only | NO | YES (via correlation) | YES (via team diff) |
| `unknown` | default (traced) | NO | — | NO |

**Notes:**
- `user_message`, `permission_response`, `interrupt` are intentionally consumer→backend only (outbound translation, never routed inbound).
- `team_*` types are a classification taxonomy used by `team-tool-recognizer.ts` to tag tool_use content blocks. They are **never emitted as standalone routable messages**. Team state is derived by the state reducer scanning `assistant`/`tool_use_summary` messages for team-related tool invocations, then broadcasting diffs as `session_update` events.
- `permission_request` mapper returns `null` for non-`can_use_tool` subtypes — a silent filter point (see Section 6).
- `unknown` falls through to the router's default case and is traced for diagnosability.

## 3. UnifiedContent Type Coverage

**7 types defined:**

| Content Type | Produced By (as content blocks) | Consumer Mapper |
|---|---|:---:|
| `text` | All adapters | YES |
| `tool_use` | Claude, Codex | YES |
| `tool_result` | Claude, Codex | YES |
| `thinking` | Claude, OpenCode, ACP | YES |
| `refusal` | Codex | YES |
| `code` | (none currently — mapper ready) | YES |
| `image` | ACP inbound | YES |

**Adapter content block limitations:**
- **Claude adapter** only passes through `text`, `tool_use`, `tool_result`, and `thinking`. Other block types (`image`, `code`, `refusal`) are converted to empty text blocks with `dropped_content_block_types` tracked in metadata.
- **OpenCode adapter** maps tool parts as separate `tool_progress`/`tool_use_summary` messages rather than content blocks. Text and reasoning parts produce `stream_event` messages with text/thinking content.
- **Codex adapter** handles `text`, `refusal`, `function_call`→`tool_progress`, `function_call_output`→`tool_use_summary`.

## 4. Cross-Adapter Feature Matrix

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

## 5. Complete Silent Drop Inventory

**15 remaining silent drop points** (10 resolved since initial audit):

| # | Layer | File | What's Dropped | Intentional? |
|---|---|---|---|:---:|
| 1 | Claude adapter | `message-translator.ts` | `keep_alive` messages → `null` | YES |
| 2 | Claude adapter | `message-translator.ts` | `user` echo messages → `null` | YES |
| 3 | Claude adapter | `message-translator.ts` | Unknown CLI types → `null` | YES |
| 4 | Claude adapter | `message-translator.ts` | Non-text/tool_use/tool_result/thinking content blocks → empty text (tracked in `dropped_content_block_types` metadata) | PARTIAL |
| 5 | Codex adapter | `codex-message-translator.ts` | Unknown event types → `null` | YES |
| 5b | Codex adapter | `codex-message-translator.ts` | Unknown item types in `translateItemAdded`/`translateItemDone` → `null` | YES |
| ~~6~~ | ~~Codex adapter~~ | ~~`codex-session.ts`~~ | ~~`function_call` + `function_call_output` in responses~~ — **RESOLVED** | |
| 7 | OpenCode adapter | `opencode-message-translator.ts` | `server.heartbeat` → `null` | YES |
| 8 | OpenCode adapter | `opencode-message-translator.ts` | `permission.replied` → `null` | YES |
| ~~9~~ | ~~OpenCode adapter~~ | ~~`opencode-message-translator.ts`~~ | ~~`session.compacted` → `null`~~ — **RESOLVED** (now → `session_lifecycle`) | |
| 10 | OpenCode adapter | `opencode-message-translator.ts` | `session.created` → `null` | YES |
| 11 | OpenCode adapter | `opencode-message-translator.ts` | `session.updated` → `null` | YES |
| 12 | OpenCode adapter | `opencode-message-translator.ts` | `session.deleted` → `null` | YES |
| 13 | OpenCode adapter | `opencode-message-translator.ts` | `session.diff` → `null` | YES |
| ~~14~~ | ~~OpenCode adapter~~ | ~~`opencode-message-translator.ts`~~ | ~~`message.removed` → `null`~~ — **RESOLVED** (now → `session_lifecycle`) | |
| 15 | OpenCode adapter | `opencode-message-translator.ts` | `message.part.removed` → `null` | YES |
| 15b | OpenCode adapter | `opencode-message-translator.ts` | Non-text field deltas (`translateDelta` returns `null` if `field !== "text"`) | YES |
| 16 | OpenCode adapter | `opencode-message-translator.ts` | Unknown event types → `null` | YES |
| ~~17~~ | ~~OpenCode adapter~~ | ~~`opencode-message-translator.ts`~~ | ~~`step-start`/`step-finish` → `null`~~ — **RESOLVED** (now → `status_change`) | |
| ~~18~~ | ~~OpenCode adapter~~ | ~~`opencode-message-translator.ts`~~ | ~~Tool `pending` state → `null`~~ — **RESOLVED** (now → `tool_progress`) | |
| 19 | ACP adapter | `outbound-translator.ts` | Unknown session updates → `unknown` type (passthrough, not truly silent) | YES |
| 20 | ACP adapter | `acp-session.ts` | `fs/*`, `terminal/*` requests → error stub response | YES |
| ~~21~~ | ~~Router~~ | ~~`unified-message-router.ts`~~ | ~~`configuration_change` — no case~~ — **RESOLVED** | |
| ~~22~~ | ~~Router~~ | ~~`unified-message-router.ts`~~ | ~~`unknown` — no case~~ — **RESOLVED** (now traced via default case) | |
| ~~23~~ | ~~Consumer mapper~~ | ~~`consumer-message-mapper.ts`~~ | ~~`code`/`image` content → empty text~~ — **RESOLVED** | |
| 24 | Consumer mapper | `consumer-message-mapper.ts` | `permission_request` with subtype ≠ `can_use_tool` → `null` (not broadcast) | YES |

## 6. Metadata Key Inconsistencies

| Concept | Claude | Codex | OpenCode | ACP | Status |
|---|---|---|---|---|---|
| Session ID | `session_id` | `session_id` | `session_id` | `session_id` | **RESOLVED** |
| Tool call ID | `tool_use_id` | `tool_use_id` | `tool_use_id` | `tool_use_id` | **RESOLVED** |
| Error flag | `is_error` | `is_error` | `is_error` | `is_error` | Consistent |
| Error detail | `error` (string) | `error` (string) | `error_name` + `error_message` | — | **INCONSISTENT** — OpenCode uses split keys |
| Error code | `error_code` | `error_code` | `error_code` | `error_code` | **RESOLVED** |
| Model ID | `model` | (not emitted) | `model_id` + `provider_id` | varies | **INCONSISTENT** — no canonical `model` key across adapters |
| Tool status | `status` (string) | `done` (boolean) + `status` | `status` (string) | `status` (string) | **INCONSISTENT** — Codex uses boolean `done` |
| Thinking | content block | — | content block | content block | Consistent (via `ThinkingContent`) |
| Cost/usage | `usage` object | — | `cost` + `tokens` | — | **INCONSISTENT** — only Claude/OpenCode provide usage; different shapes |

## 8. Remaining Open Issues

### ISSUE 1: Claude Adapter Drops Rich Content Blocks

**Severity:** Medium
**File:** `src/adapters/claude/message-translator.ts`

The Claude adapter only passes through `text`, `tool_use`, `tool_result`, and `thinking` content blocks in assistant messages. All other block types (`image`, `code`, `refusal`) are silently converted to empty text blocks. The dropped types are tracked in `dropped_content_block_types` metadata, but the original data is lost before it reaches the consumer mapper (which does handle all 7 types).

**Impact:** If Claude CLI adds image/code output blocks in the future, they will be dropped at the adapter layer even though the consumer mapper is ready.

### ISSUE 2: Metadata Shape Divergence Across Adapters

**Severity:** Medium

Several metadata keys differ across adapters (see Section 7):
- **Model ID**: Claude uses `model`, OpenCode uses `model_id` + `provider_id`, Codex doesn't emit it
- **Tool status**: Codex uses boolean `done`, others use string `status`
- **Cost/usage**: Claude and OpenCode provide usage data in different shapes; Codex and ACP don't provide it
- **Error detail**: OpenCode splits into `error_name` + `error_message`; others use `error` string

The consumer mapper has fallback chains (`tool_use_id ?? part_id ?? "unknown"`, `tool_name ?? tool ?? kind ?? "tool"`) to handle these, but this makes the contract implicit rather than explicit.

### ISSUE 3: Status Inference is Claude-Specific

**Severity:** Low
**File:** `src/core/unified-message-router.ts`

The router infers "running" status from `stream_event` messages when `event.type === "message_start"` — a Claude-specific convention. OpenCode and ACP adapters don't send `message_start` events in this format, so the "running" status may not be inferred for those backends. They typically emit explicit `status_change` messages instead.

### ISSUE 4: Test Coverage Gaps for Content Types

**Severity:** Low

The consumer mapper test (`consumer-message-mapper.test.ts`) does not test `code`, `image`, `thinking`, or `refusal` content blocks within assistant messages. These content types are tested in the type guard tests and some adapter tests, but not in the mapper's own test suite.

