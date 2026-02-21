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
                       │ (5 switch cases│           │ (12 switch cases │
                       │  + team scan)  │           │  + default trace)│
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

Note: The state reducer runs **before** the router switch on every message. It has explicit switch cases for `session_init`, `status_change`, `result`, `control_response`, and `configuration_change`. All other message types fall through to team tool-use correlation (scanning content blocks for team tool invocations — meaningful only for `assistant` and `tool_use_summary`). Team state changes are broadcast via `emitTeamEvents()` after reduction, not through the router switch.

## 2. Current UnifiedMessage Type Coverage

**19 types defined**, **12 have router switch handlers**, **10 have consumer mappers**, and **1 has a default trace handler**:

| UnifiedMessageType | Router Switch | Consumer Mapper | State Reducer | Broadcast to UI |
|---|:---:|:---:|:---:|:---:|
| `session_init` | YES | — (direct) | YES | YES |
| `status_change` | YES | — (direct) | YES | YES |
| `assistant` | YES | YES | YES (team scan) | YES |
| `result` | YES | YES | YES | YES |
| `stream_event` | YES | YES | — | YES |
| `permission_request` | YES | YES (filtered) | — | YES |
| `control_response` | YES (delegates) | — | YES (stub) | NO |
| `tool_progress` | YES | YES | — | YES |
| `tool_use_summary` | YES | YES | YES (team scan) | YES |
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
- `permission_request` mapper returns `null` for non-`can_use_tool` subtypes — a silent filter point (see Section 5).
- `unknown` falls through to the router's default case and is traced for diagnosability.
- State reducer `control_response` case is a stub — capabilities are applied by the router handler, not the reducer.

## 3. UnifiedContent Type Coverage

**7 types defined:**

| Content Type | Produced By (as content blocks in `assistant` messages) | Consumer Mapper |
|---|---|:---:|
| `text` | All adapters | YES |
| `tool_use` | Claude | YES |
| `tool_result` | Claude | YES |
| `thinking` | Claude, OpenCode, ACP | YES |
| `refusal` | Claude, Codex | YES |
| `code` | Claude (forward-compat) | YES |
| `image` | Claude (forward-compat), ACP inbound | YES |

**Adapter content block handling:**
- **Claude adapter** handles all 7 content types: `text`, `tool_use`, `tool_result`, `thinking`, `image`, `code`, `refusal`. Truly unknown block types (not in the 7-type union) are converted to empty text blocks with `dropped_content_block_types` tracked in metadata.
- **Codex adapter** produces `text` and `refusal` as content blocks in `assistant` messages. Tool calls (`function_call`, `function_call_output`) are separate Codex items translated to standalone `tool_progress`/`tool_use_summary` messages, not content blocks.
- **OpenCode adapter** maps tool parts as separate `tool_progress`/`tool_use_summary` messages rather than content blocks. Text and reasoning parts produce `stream_event` messages with text/thinking content.
- **ACP adapter** produces `text` and `thinking` content blocks from `agent_message_chunk`/`agent_thought_chunk` events. Tool calls are separate session updates translated to `tool_progress`/`tool_use_summary` messages. Image content is supported inbound (user→backend) only.

## 4. Cross-Adapter Feature Matrix

### Streaming & Content

| Capability | Claude | Codex | OpenCode | ACP/Gemini | Unified Protocol |
|---|:---:|:---:|:---:|:---:|:---:|
| Text streaming | `stream_event` | `response.output_text.delta` + `item/agentMessage/delta` | `message.part.updated` + `message.part.delta` | `agent_message_chunk` | `stream_event` (YES) |
| Thinking/reasoning | `thinking` block | — | `reasoning` part | `agent_thought_chunk` | `ThinkingContent` (YES) |
| Refusal | `refusal` block | `refusal` part | — | — | `RefusalContent` (YES) |
| Image content | (forward-compat) | — | — | YES (inbound user→backend) | `ImageContent` (YES) |
| Code content | (forward-compat) | — | — | — | `CodeContent` (YES) |

### Tool Execution

| Capability | Claude | Codex | OpenCode | ACP/Gemini | Unified Protocol |
|---|:---:|:---:|:---:|:---:|:---:|
| Tool invocation | `tool_progress` | `response.output_item.added` (function_call) | tool part `running` | `tool_call` | `tool_progress` (YES) |
| Tool completion | `tool_use_summary` | `response.output_item.done` (function_call_output) | tool part `completed` | `tool_call_update` (completed) | `tool_use_summary` (YES) |
| Tool pending | — | — | tool part `pending` | — | `tool_progress` (YES) |
| Tool error | — | — | tool part `error` | `tool_call_update` (failed) | `tool_use_summary` (YES) |

### Permissions & Control

| Capability | Claude | Codex | OpenCode | ACP/Gemini | Unified Protocol |
|---|:---:|:---:|:---:|:---:|:---:|
| Permission request | `control_request` | `approval_requested` + `item/commandExecution/requestApproval` + `item/fileChange/requestApproval` | `permission.updated` | `session/request_permission` | `permission_request` (YES) |
| Interrupt/cancel | `control_request` (interrupt) | `turn/interrupt` (modern) / `turn.cancel` (legacy) | HTTP POST abort | `session/cancel` | `interrupt` (YES) |

### Error Handling

| Capability | Claude | Codex | OpenCode | ACP/Gemini | Unified Protocol |
|---|:---:|:---:|:---:|:---:|:---:|
| Error subtypes | 3 codes: `max_turns`, `max_budget`, `execution_error` | 4 codes: `rate_limit`, `output_length`, `aborted`, `execution_error` | 6 codes: `provider_auth`, `output_length`, `aborted`, `context_overflow`, `api_error`, `unknown` | Pluggable classifier; Gemini: `provider_auth`, `rate_limit`, `context_overflow`, `api_error` | `UnifiedErrorCode` (YES) |

### Session Lifecycle & Configuration

| Capability | Claude | Codex | OpenCode | ACP/Gemini | Unified Protocol |
|---|:---:|:---:|:---:|:---:|:---:|
| Session init | `system/init` | `initialize` response | `server.connected` | `initialize` result | `session_init` (YES) |
| Session compaction | `is_compacting` flag in status | `/compact` slash cmd (outbound only) | `session.compacted` | — | `status_change` (Claude) / `session_lifecycle` (OpenCode) |
| Message removal | — | — | `message.removed` | — | `session_lifecycle` (YES) |
| Step boundaries | — | — | `step-start`/`step-finish` | — | `status_change` (YES) |
| Plan display | — | — | — | `plan` session update | `status_change` (YES) |
| Dynamic commands | slash_commands in init (static) | — | — | `available_commands_update` | `configuration_change` (YES) |
| Mode/config change | — | — | — | `current_mode_update` | `configuration_change` (YES) |
| Model switching | `set_model` (outbound) | — | model in prompt params | `session/set_model` | `configuration_change` (YES) |
| Slash commands | YES (bridge-level) | YES (4 custom: `/compact`, `/new`, `/review`, `/rename`) | NO | YES (via `available_commands_update`) | Adapter-specific |

### Observability & Auth

| Capability | Claude | Codex | OpenCode | ACP/Gemini | Unified Protocol |
|---|:---:|:---:|:---:|:---:|:---:|
| Token usage | Full (per-turn + per-model + cache) | — | Full (input, output, reasoning, cache + cost) | Passthrough (forwarded from prompt result) | Partial (shape varies by adapter) |
| Auth flow | `auth_status` messages | — | HTTP Basic (transport-level, no events) | `auth_status` on provider_auth errors + `authMethods` in init | `auth_status` (YES) |
| Teams | YES (`teams: true`) | — | — | — | 3 types (state-only, Claude-only) |

## 5. Complete Silent Drop Inventory

**14 remaining silent drop points** (11 resolved since initial audit):

| # | Layer | File | What's Dropped | Intentional? |
|---|---|---|---|:---:|
| 1 | Claude adapter | `message-translator.ts` | `keep_alive` messages → `null` | YES |
| 2 | Claude adapter | `message-translator.ts` | `user` echo messages → `null` | YES |
| 3 | Claude adapter | `message-translator.ts` | Unknown CLI types → `null` | YES |
| 4 | Claude adapter | `message-translator.ts` | Unknown content block types (outside the 7-type union) → empty text (tracked in `dropped_content_block_types` metadata) | YES |
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
| ~~24~~ | ~~Claude adapter~~ | ~~`message-translator.ts`~~ | ~~`image`/`code`/`refusal` content blocks → empty text~~ — **RESOLVED** (now passed through) | |
| 25 | Consumer mapper | `consumer-message-mapper.ts` | `permission_request` with subtype ≠ `can_use_tool` → `null` (not broadcast) | YES |

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
| Cost/usage | `usage` object | — | `cost` + `tokens` | passthrough (`inputTokens` + `outputTokens` if present) | **INCONSISTENT** — Claude/OpenCode/ACP provide usage in different shapes; Codex doesn't provide it |

## 7. Remaining Open Issues

### ISSUE 1: ~~Claude Adapter Drops Rich Content Blocks~~ — RESOLVED

~~**Severity:** Medium~~
~~**File:** `src/adapters/claude/message-translator.ts`~~

The Claude adapter now handles all 7 content types (`text`, `tool_use`, `tool_result`, `thinking`, `image`, `code`, `refusal`). Only truly unknown block types outside this union are converted to empty text blocks with `dropped_content_block_types` tracking.

### ISSUE 2: Metadata Shape Divergence Across Adapters

**Severity:** Medium

Several metadata keys differ across adapters (see Section 6):
- **Model ID**: Claude uses `model`, OpenCode uses `model_id` + `provider_id`, Codex doesn't emit it
- **Tool status**: Codex uses boolean `done`, others use string `status`
- **Cost/usage**: Claude (`usage` object), OpenCode (`cost` + `tokens`), and ACP (passthrough `inputTokens`/`outputTokens`) provide usage in different shapes; Codex doesn't provide it
- **Error detail**: OpenCode splits into `error_name` + `error_message`; others use `error` string

The consumer mapper has fallback chains (`tool_use_id ?? part_id ?? "unknown"`, `tool_name ?? tool ?? kind ?? "tool"`) to handle these, but this makes the contract implicit rather than explicit.

### ISSUE 3: Status Inference is Claude-Specific

**Severity:** Low
**File:** `src/core/unified-message-router.ts`

The router infers "running" status from `stream_event` messages when `event.type === "message_start"` — a Claude-specific convention. OpenCode and ACP adapters don't send `message_start` events in this format, so the "running" status may not be inferred for those backends. They typically emit explicit `status_change` messages instead.

### ~~ISSUE 4: Test Coverage Gaps for Content Types~~ — RESOLVED

The consumer mapper test (`consumer-message-mapper.test.ts`) now tests all 7 content types including `code`, `image`, `thinking`, and `refusal` blocks. Characterization and integration tests also cover the full pipeline for these content types.
