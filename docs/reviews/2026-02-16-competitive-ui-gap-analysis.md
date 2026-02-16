# Competitive UI Gap Analysis

**Date**: 2026-02-16
**Scope**: BeamCode web UI vs. AI coding agent frontends and chat UIs
**Method**: Dual-model research (Claude + Gemini) across 20+ competitors, reviewed by 3 agents (UX/Product, Technical Feasibility, Competitive Strategy)

---

## Executive Summary

BeamCode's web UI has strong foundations — streaming chat, session management, permission workflows, tool visualization, context gauge, and mobile responsiveness. However, compared to the 2025-2026 competitive landscape, there are significant gaps in **coding-specific UI** (diffs, file input), **daily workflow quality-of-life** (search, shortcuts, approval fatigue), and **multi-agent orchestration** (the actual moat).

### Strategic Insight

The original roadmap was 80% parity, 20% differentiation. All three reviewers agreed: **BeamCode cannot out-Cursor Cursor**. The revised plan below front-loads quick wins that fix daily pain points, then pivots to multi-agent features that no competitor can replicate.

### Key Corrections from Review

| Original Assumption | Review Finding |
|---------------------|----------------|
| Cost tracking is a gap | TaskPanel already shows per-session cost, model usage, tokens — just needs enhancement |
| PermissionBanner has no diff | Already shows old_string/new_string for Edit tools (truncated, unstyled) |
| Artifacts are Tier 1 | CUT — BeamCode users have their code in VS Code/Neovim; sandboxed HTML adds security risk |
| Multi-model comparison is the killer feature | DEMOTED — AI agents are stateful; comparing multi-turn sessions is fundamentally different from comparing text gen |
| Voice input is Medium priority | CUT — devs don't dictate code; Web Speech API unreliable for technical vocabulary |
| Image input needs backend work | Protocol already supports `images` on `user_message` — just needs Composer UI |

---

## What BeamCode Already Does Well

| Feature | Status | Competitive Position |
|---------|--------|---------------------|
| Universal agent adapter (25+ CLIs) | Unique | **No competitor has this** |
| E2E encryption for remote access | Unique | Ahead of all competitors |
| Tool use visualization (Bash, Edit, Read, Write, Glob, Grep) | Strong | On par with Cline, Cursor |
| Permission allow/deny with previews | Strong | On par — but missing "Allow All" |
| Context usage gauge (color-coded) | Unique | No competitor shows this |
| Subagent message grouping | Strong | Ahead of most |
| Per-session cost + model usage in TaskPanel | Good | Partially implemented |
| Slash command menu with typeahead | Good | On par with Cline, Continue |
| Mobile responsive with safe-area support | Good | On par with LobeChat |

---

## Revised Roadmap

### Phase 1 — Quick Wins (frontend-only, no backend changes)

All items are **S or M effort**, require **zero backend changes**, and fix the most painful parts of daily usage.

#### 1. Keyboard Shortcuts

**Impact: High | Effort: S (~1 day) | Frontend-only**

The Composer handles Enter/Shift+Enter/Esc only. No shortcuts for: new session, switch sessions, toggle sidebar/panel, approve/deny, focus composer.

Add a `useEffect` with `keydown` listener in `App.tsx` + a discoverable shortcuts modal (`?` key).

| Competitor | Has This |
|-----------|----------|
| Cursor | Cmd+K palette, extensive shortcuts |
| Copilot | Cmd+Shift+P, keybindings |
| Cline | Keyboard nav for approvals |
| TypingMind | Comprehensive hotkeys |

#### 2. Session Search in Sidebar

**Impact: High | Effort: S (~0.5 day) | Frontend-only**

Filter `sessionList` by `info.name`. No backend endpoint needed for title-based search.

| Competitor | Has This |
|-----------|----------|
| LibreChat | Full-text search across conversations |
| Open WebUI | Tag/categorize, search history |
| TypingMind | Full-text search with filters |

#### 3. "Allow All" / Session-Level Trust on PermissionBanner

**Impact: High | Effort: S (~0.5 day) | Frontend-only**

When an agent performs sequential file edits, users click Allow 5-10 times. Add an "Allow All" button that loops `permList` and sends all allow responses. Every competitor (Cursor, Copilot, Cline) offers this.

**Files**: `PermissionBanner.tsx`, `ws.ts` (send loop)

#### 4. Partial Code Diff for Edit Tools

**Impact: Critical | Effort: M (~2-3 days) | Frontend-only**

`PermissionBanner` already extracts `old_string`/`new_string` from Edit tool `input`. Create a reusable `DiffView` component with syntax highlighting, use in both `PermissionBanner` (pre-approval) and `ToolBlock` (post-execution, when `name === "Edit"`).

Note: Full file diff requires backend changes (tool results don't include before/after file content). Partial diff from `input.old_string` vs `input.new_string` is available today.

| Competitor | Has This |
|-----------|----------|
| Cursor | Multi-file diff tree, accept/reject per hunk |
| Windsurf | Inline diff with approve/reject |
| Copilot | Side-by-side diff in chat panel |
| Cline | Syntax-highlighted unified diff |

#### 5. Conversation Export (Markdown/JSON)

**Impact: Medium | Effort: S (~1 day) | Frontend-only**

Serialize `sessionData[id].messages` to JSON (trivial) or Markdown (iterate messages, render text as markdown, tool blocks as code fences). Add export button in TaskPanel.

#### 6. Image Drag-and-Drop in Composer

**Impact: High | Effort: M (~2 days) | Frontend-only**

The protocol already supports `images?: { media_type: string; data: string }[]` on `InboundMessage.user_message` (`consumer-types.ts:211`). Only the Composer UI needs building: drag-and-drop zone, FileReader to base64, preview thumbnails.

Non-image file upload requires a backend endpoint — defer that.

#### 7. Cost/Token Tracking Enhancement

**Impact: Medium | Effort: S (~1 day) | Frontend-only**

Data already exists: `ResultData.total_cost_usd`, `ResultData.modelUsage`, `ConsumerSessionState.total_cost_usd`. Expand TaskPanel with per-turn cost breakdown and lightweight SVG bar chart. All data is available.

#### 8. Reconnection UX Banner

**Impact: Medium | Effort: S (~0.5 day) | Frontend-only**

`ws.ts` has exponential backoff reconnection, but UI shows only a tiny dot in TopBar. Add a visible "Reconnecting..." banner with manual retry button and attempt counter.

**Phase 1 total: ~2 weeks, 8 features, zero backend changes.**

---

### Phase 2 — Coding Workflow (some backend changes)

#### 9. Plan/Act Mode Toggle

**Impact: High | Effort: M | Needs new inbound message type**

Maps to Claude Code's existing plan mode. Toggle in TopBar + visual mode indicator. Start as UI-only (store flag in Zustand, display badge), add backend enforcement once Claude Code adapter confirms support.

**Risk**: Different CLIs have different mode concepts. A universal "plan mode" may silently do nothing for non-Claude agents. Ship as visual indicator first.

| Competitor | Has This |
|-----------|----------|
| Cline | Plan/Act toggle with separate model configs |
| Windsurf | Write/Chat/Turbo modes |
| Augment | Quick Ask (read-only) mode |

#### 10. Inline Tool Result Rendering

**Impact: High | Effort: M | Frontend-only**

Every ToolBlock currently renders output as `JSON.stringify(input)`. When Read returns file content, or Grep returns search results, or Bash returns terminal output — all show raw JSON. Render with context-appropriate formatting: file content with line numbers, grep results with match highlighting, bash output with monospace.

This is the most frequently encountered pain point (tool results appear in every conversation).

#### 11. Session Organization (Folders/Tags)

**Impact: Medium | Effort: M | Frontend-only (localStorage)**

Add `folders`, `tags`, `pinned`, `archived` to client-side metadata in Sidebar. Backend persistence can come later.

#### 12. Task/Plan Progress Visualization

**Impact: Medium | Effort: L | Fragile without CLI support**

Parse assistant text for plan/todo patterns. Render as checklist in TaskPanel. Without structured plan data from the CLI, this is heuristic-based and fragile.

**Risk**: Different agent output styles make regex parsing unreliable. Best implemented after a structured plan protocol exists.

---

### Phase 3 — Multi-Agent Moat (BeamCode's real differentiation)

All three reviewers agreed: these should be prioritized higher than they were originally.

#### 13. Multi-Agent Orchestration Dashboard

**Impact: High | Effort: L | Needs ws.ts refactor**

Dashboard view showing all active sessions with status, progress, model, cost, and adapter type. BeamCode's multi-session architecture makes this natural — but `ws.ts` is a module-level singleton that connects to one session at a time.

**Prerequisite**: Refactor `ws.ts` from `let ws: WebSocket | null` singleton to `Map<string, WebSocket>` connection manager. This is the single biggest architectural debt blocking Phase 3.

| Competitor | Has This |
|-----------|----------|
| Cursor 2.0 | Up to 8 agents in parallel |
| Copilot | Agent HQ — central hub |

#### 14. Embedded Terminal Rendering (xterm.js)

**Impact: Medium | Effort: M | Frontend-only**

Add xterm.js in `ToolBlock.tsx` when `name === "Bash"` and content contains ANSI sequences. Data already arrives in tool_result content blocks.

#### 15. Multi-Model Comparison

**Impact: Medium | Effort: XL | Needs ws.ts refactor**

Send same prompt to N agents, render responses in parallel columns. Note: this works well for single-turn queries but breaks down for multi-turn stateful sessions. Consider framing as "start N sessions with same prompt" rather than ongoing parallel comparison.

**Depends on**: ws.ts refactored to multi-connection (#13 prerequisite).

#### 16. Cross-Agent Routing (unique to BeamCode)

**Impact: High | Effort: XL | Novel feature**

User describes a task. BeamCode suggests or auto-routes to the best agent (Aider for git ops, Codex for greenfield, Claude Code for refactoring). No competitor can build this because they're single-agent systems.

#### 17. Agent Performance Benchmarking

**Impact: High | Effort: L | Novel feature**

Track which agent is fastest, cheapest, and most accurate per task type. Cross-agent visibility that no single-agent tool has.

---

## Cut List

Features removed from the roadmap based on review consensus:

| Feature | Why Cut | Reviewer(s) |
|---------|---------|-------------|
| **Artifact/Canvas rendering** | Wrong product category — BeamCode users have code in their IDE. Security risk from sandboxed execution. Cursor doesn't have it either. | UX, Strategy |
| **Voice input** | Developers don't dictate code. Web Speech API unreliable for technical vocab. Near-zero daily usage. | UX, Strategy |
| **Conversation branching/forking** | Requires complex data model changes (flat `messages[]` → tree). Low ROI — users just create new sessions. | UX, Technical |
| **MCP server management UI** | Setup-time operation, not daily workflow. Agents manage their own MCP configs. | UX, Strategy |
| **Persistent agent memory UI** | Creates dual-editing conflict with file-based CLAUDE.md system. Let agents manage their own memory. | UX, Strategy |

---

## Technical Architecture Notes

### The ws.ts Bottleneck

The single most important infrastructure change for Phase 3:

```
// Current (blocks multi-agent features):
let ws: WebSocket | null = null;
let activeSessionId: string | null = null;

// Needed:
const connections = new Map<string, WebSocket>();
```

This refactor unblocks: multi-agent dashboard (#13), multi-model comparison (#15), and the orchestration features that define BeamCode's moat.

### Protocol Gaps

| Feature | What's Missing |
|---------|---------------|
| Full file diff (#4) | `tool_result` for Edit is just "success" text, not before/after file content |
| Plan/Act mode (#9) | No `set_mode` inbound message type |
| Task progress (#12) | No structured plan data from CLI |
| Checkpoint/revert | No server-side git snapshot mechanism — XL effort, defer |
| File upload (non-image) | No upload endpoint — image protocol exists though |

### Frontend-Only Features (ship without backend coordination)

Items 1-8 in Phase 1, plus items 10-11 and 14. These can ship in ~3 weeks total.

---

## Competitive Threat Assessment

| Competitor | Can Replicate Moat? | Timeline | Threat |
|------------|---------------------|----------|--------|
| VS Code Copilot (Agent HQ) | Yes — already announced | 2026 | **CRITICAL** |
| Cursor 2.0 | Yes — resources + Composer | 6-12 months | HIGH |
| Windsurf | Yes — Cascade autonomous mode | 6-12 months | HIGH |
| Continue | Yes — open-source, extensible | 3-6 months | MEDIUM |
| LibreChat | Maybe — multi-model, not multi-agent | 12+ months | LOW |

### What BeamCode Can Do That They Can't

1. **Protocol-agnostic**: VS Code will likely lock to Microsoft models. BeamCode connects to ANY CLI.
2. **Remote access**: VS Code can't run on an iPad. BeamCode can.
3. **Cross-agent routing**: Single-agent tools have no incentive to recommend competitors.
4. **Agent benchmarking**: No cross-agent visibility in single-agent tools.

---

## Sources

### Direct Competitors
- [Open WebUI Features](https://docs.openwebui.com/features/)
- [LibreChat Features](https://www.librechat.ai/docs/features)
- [LobeChat GitHub](https://github.com/lobehub/lobe-chat)
- [TypingMind Feature List](https://docs.typingmind.com/feature-list)
- [Big-AGI GitHub](https://github.com/enricoros/big-AGI)
- [Chatbox GitHub](https://github.com/chatboxai/chatbox)

### IDE-Integrated Competitors
- [Cursor 2.0](https://www.codecademy.com/article/cursor-2-0-new-ai-model-explained)
- [Windsurf Cascade Docs](https://docs.windsurf.com/windsurf/cascade/cascade)
- [Cline Plan/Act Modes](https://deepwiki.com/cline/cline/3.4-plan-and-act-modes)
- [Copilot Agent Mode](https://code.visualstudio.com/blogs/2025/02/24/introducing-copilot-agent-mode)
- [VS Code Unified Agent Experience](https://code.visualstudio.com/blogs/2025/11/03/unified-agent-experience)
- [Aider Watch Mode](https://aider.chat/docs/usage/watch.html)
- [Augment Agent Blog](https://www.augmentcode.com/blog/meet-augment-agent)
- [Amazon Q Developer](https://aws.amazon.com/blogs/aws/amazon-q-developer-elevates-the-ide-experience-with-new-agentic-coding-experience/)
