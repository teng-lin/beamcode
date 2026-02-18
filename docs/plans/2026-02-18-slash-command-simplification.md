# Slash Command Simplification

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fragile multi-category slash command routing with a simple, uniform "CLI-first" model — and fix git branch tracking for cwd changes.

**Architecture:** Every slash command is forwarded to the CLI. A small set of commands (`/help`, `/clear`) that are purely UI concerns remain frontend-only. The "relay" category and its emulation layer are removed. The `EMULATABLE_COMMANDS` map is removed. Echo interception (`pendingPassthrough`) becomes the default for all CLI-forwarded commands, not just a special subset. Git branch tracking gets `effectiveCwd` derived from Bash tool_use blocks.

**Tech Stack:** TypeScript, Vitest

---

## Problem Analysis

The current system has 6 overlapping command categories (consumer, relay, passthrough, native, skill, unknown) with subtle routing logic spread across 3 classes. This caused two bugs:

1. **`/model arg` silently dropped** — relay commands with arguments were emulated (ignoring args) instead of forwarded to CLI.
2. **Git branch stuck on `main`** — `refreshGitInfo` uses `session.state.cwd` which never updates when the agent `cd`s to a worktree.

The root cause is over-engineering: the "relay" emulation layer tries to locally replicate CLI state but can't handle writes. The passthrough interception is a special case that should be the default.

## Design: New Model

**Two execution paths only:**

| Path | Commands | Behavior |
|------|----------|----------|
| **Frontend-only** | `/help`, `/clear` | Handled in Composer.tsx (no backend) |
| **CLI-forwarded** | Everything else | Forwarded as user message, echo intercepted as `slash_command_result` |

**Removed concepts:**
- `EMULATABLE_COMMANDS` map (all state reading goes through CLI)
- `category: "relay"` distinction
- `isNativeCommand()` — unnecessary; everything not frontend-only is forwarded
- `canHandle()` — irrelevant; CLI decides what it can handle
- PTY fallback — dead code path since we always forward to CLI

**Retained:**
- `SlashCommandRegistry` — still needed for `/help` augmentation and frontend menu data
- `SlashCommandHandler` — simplified to: forward + intercept, or error
- `SlashCommandExecutor` — reduced to: execute `/help` locally, everything else throws
- `pendingPassthrough` — becomes default behavior for all forwarded commands
- `CommandSource` — still needed for skills/cli distinction in the registry

---

## Task 1: Simplify SlashCommandExecutor

Remove `EMULATABLE_COMMANDS` (except `/help`), `isNativeCommand`, `canHandle`, and PTY fallback. The executor only needs to handle `/help` locally. Everything else is forwarded.

**Files:**
- Modify: `src/core/slash-command-executor.ts`
- Modify: `src/core/slash-command-executor.test.ts`

### Step 1: Rewrite the executor

Replace `SlashCommandExecutor` with a stripped-down version:

```typescript
// Remove: EMULATABLE_COMMANDS (except /help emulator for augmentHelp)
// Remove: isNativeCommand(), canHandle(), PTY queue, PTY fallback
// Remove: /model, /status, /config emulators
// Keep: isSkillCommand(), isPassthroughCommand(), registryMatch()
// Add: shouldForwardToCLI() — single method that returns true for everything except /help and /clear
```

The new executor shape:

```typescript
export class SlashCommandExecutor {
  // Remove: commandRunner, config, ptyQueues

  /** True if this command should go to the CLI (everything except /help, /clear). */
  shouldForwardToCLI(command: string, session: { state: SessionState; registry: SlashCommandRegistry | null }): boolean {
    const name = commandName(command);
    return name !== "/help" && name !== "/clear";
  }

  /** Execute /help locally. Everything else should be forwarded, not executed here. */
  async executeLocal(state: SessionState, command: string, registry?: SlashCommandRegistry | null): Promise<SlashCommandResult> {
    const name = commandName(command);
    if (name === "/help") {
      return { content: this.buildHelp(state, registry ?? null), source: "emulated", durationMs: 0 };
    }
    throw new Error(`Command "${name}" must be forwarded to CLI`);
  }

  dispose(): void {} // No-op, no resources to clean up
}
```

### Step 2: Update executor tests

Remove tests for:
- `/model` emulation
- `/status` emulation
- `/config` emulation
- `isNativeCommand` classification
- `canHandle` classification
- PTY fallback execution
- PTY queue serialization

Add tests for:
- `shouldForwardToCLI` returns true for `/model`, `/model arg`, `/compact`, `/commit`, `/status`, `/vim`
- `shouldForwardToCLI` returns false for `/help`, `/clear`
- `executeLocal("/help")` returns help text
- `executeLocal("/model")` throws

### Step 3: Run tests, verify pass

```bash
cd /Users/blackmyth/src/beamcode/.worktrees/fix-ui-bugs && npx vitest run src/core/slash-command-executor.test.ts
```

### Step 4: Commit

```
refactor: simplify SlashCommandExecutor to CLI-first model

Remove relay emulation (/model, /status, /config), PTY fallback,
and multi-tier command classification. All commands except /help
and /clear are now forwarded to the CLI.
```

---

## Task 2: Simplify SlashCommandHandler

The handler now has a single decision: is it `/help` or `/clear`? If so, handle locally. Otherwise, forward to CLI and always set `pendingPassthrough`.

**Files:**
- Modify: `src/core/slash-command-handler.ts`
- Modify: `src/core/slash-command-handler.ts` (the `executeSlashCommand` programmatic API)

### Step 1: Rewrite the handler routing

```typescript
handleSlashCommand(session, msg): void {
  const { command, request_id } = msg;

  if (this.executor.shouldForwardToCLI(command, session)) {
    // ALL forwarded commands get echo interception (not just passthrough)
    session.pendingPassthrough = {
      command: command.trim().split(/\s+/)[0],
      requestId: request_id,
    };
    this.sendUserMessage(session.id, command);
    return;
  }

  // Local commands: /help, /clear
  this.executor
    .executeLocal(session.state, command, session.registry)
    .then(result => { /* broadcast slash_command_result */ })
    .catch(err => { /* broadcast slash_command_error */ });
}
```

### Step 2: No new handler tests needed — update existing bridge-level tests

The handler has no standalone test file. Tests live in `session-bridge-slash-commands.test.ts`. We'll update those in Task 4.

### Step 3: Commit

```
refactor: simplify SlashCommandHandler to binary forward/local routing

All commands except /help and /clear are now forwarded to CLI with
echo interception. Removes shouldForwardToCLI multi-method chain.
```

---

## Task 3: Simplify SlashCommandRegistry

Remove the `"relay"` category. Commands that were `"relay"` (`/model`, `/status`, `/config`) become `"passthrough"`. This is accurate now — they all go through the CLI.

**Files:**
- Modify: `src/core/slash-command-registry.ts`
- Modify: `src/core/slash-command-registry.test.ts` (if category assertions exist)

### Step 1: Update built-in command definitions

```typescript
// Change /model, /status, /config from category: "relay" to category: "passthrough"
// Remove "relay" from CommandCategory union type
export type CommandCategory = "consumer" | "passthrough";
```

### Step 2: Verify registry tests still pass

```bash
npx vitest run src/core/slash-command-registry.test.ts
```

### Step 3: Commit

```
refactor: remove "relay" command category from registry

All non-consumer commands now use "passthrough" category since they
are all forwarded to the CLI uniformly.
```

---

## Task 4: Update bridge-level integration tests

Update `session-bridge-slash-commands.test.ts` to match the new behavior:
- `/model` (no args) is now forwarded to CLI, not emulated
- `/model arg` is forwarded to CLI (was silently dropped before)
- `/status`, `/config` are forwarded to CLI (were emulated)
- All forwarded commands get echo interception

**Files:**
- Modify: `src/core/session-bridge-slash-commands.test.ts`

### Step 1: Update existing tests

- `"emulates /model command and broadcasts result"` → change to `"forwards /model to CLI"`
- `"emits slash_command:executed event"` for `/model` → remove or change to verify forwarding
- `"programmatic executeSlashCommand returns emulated result"` → change to verify CLI forwarding
- Add: `"forwards /model with arguments to CLI"`
- Add: `"intercepts CLI echo for /model"`
- Add: `"intercepts CLI echo for /status"`

### Step 2: Run all slash command tests

```bash
npx vitest run src/core/session-bridge-slash-commands.test.ts
```

### Step 3: Commit

```
test: update slash command integration tests for CLI-first model
```

---

## Task 5: Add effectiveCwd tracking for git branch updates

When the CLI agent runs `cd /some/worktree`, the session's `cwd` stays stale because the CLI only reports it in `system.init`. Track cwd changes from Bash `tool_use` blocks.

**Files:**
- Create: `src/core/cwd-tracker.ts`
- Create: `src/core/cwd-tracker.test.ts`
- Modify: `src/types/session-state.ts` (add `effectiveCwd?: string`)
- Modify: `src/core/session-bridge.ts` (track cwd in handleUnifiedAssistant, use in handleUnifiedResult)
- Modify: `src/core/git-info-tracker.ts` (use `effectiveCwd ?? cwd` in refreshGitInfo)

### Step 1: Write cwd-tracker.test.ts

Test cases:
- `extractCwdFromCommand("cd /tmp", "/base")` → `"/tmp"`
- `extractCwdFromCommand("cd src", "/base")` → `"/base/src"`
- `extractCwdFromCommand("cd /tmp && ls", "/base")` → `"/tmp"`
- `extractCwdFromCommand("ls && cd /tmp", "/base")` → `"/tmp"`
- `extractCwdFromCommand("ls -la", "/base")` → `null`
- `extractCwdFromCommand("cd ~", "/base")` → `null`
- `extractCwdFromContent([Bash tool_use with cd], "/base")` → detected path
- `extractCwdFromContent([Read tool_use], "/base")` → `null`

### Step 2: Write cwd-tracker.ts

```typescript
import { resolve } from "node:path";

export function extractCwdFromContent(
  content: Array<{ type: string; name?: string; input?: unknown }>,
  baseCwd: string,
): string | null { /* scan Bash blocks for cd commands */ }

export function extractCwdFromCommand(command: string, baseCwd: string): string | null {
  /* split on && ; || , find last cd target, resolve against baseCwd */
}
```

### Step 3: Run cwd-tracker tests

```bash
npx vitest run src/core/cwd-tracker.test.ts
```

### Step 4: Add `effectiveCwd` to SessionState

In `src/types/session-state.ts`:
```typescript
/** Inferred cwd from Bash tool `cd` commands (may differ from initial `cwd`). */
effectiveCwd?: string;
```

### Step 5: Wire into session-bridge.ts

In `handleUnifiedAssistant`: extract cwd from Bash tool_use blocks, set `session.state.effectiveCwd`.

In `handleUnifiedResult`: after `refreshGitInfo`, broadcast `cwd` update if effectiveCwd changed.

In `handleUnifiedSessionInit`: clear `session.state.effectiveCwd` (CLI is authoritative).

### Step 6: Wire into git-info-tracker.ts

In `refreshGitInfo`: use `session.state.effectiveCwd ?? session.state.cwd` as the resolve path.

### Step 7: Run all affected tests

```bash
npx vitest run src/core/cwd-tracker.test.ts src/core/git-info-tracker.test.ts src/core/session-bridge-routing.test.ts
```

### Step 8: Commit

```
feat: track effectiveCwd from Bash tool_use blocks for git branch updates

When the CLI agent runs `cd /worktree/path`, the session cwd stays
stale. Now we scan Bash tool_use blocks for `cd` commands and
maintain effectiveCwd for git info resolution.
```

---

## Task 6: Clean up unused code and run full test suite

Remove any dead imports, unused types, or orphaned test helpers from the refactor.

**Files:**
- Possibly: `src/core/slash-command-executor.ts` (remove CommandRunner import if unused)
- Possibly: `src/types/config.ts` (remove PTY config if unused)
- Possibly: `src/testing/mock-command-runner.ts` (check if still needed elsewhere)

### Step 1: Check for unused imports

```bash
npx tsc --noEmit
```

### Step 2: Run full test suite

```bash
npm test
```

### Step 3: Verify test count is reasonable (should be close to 1922 baseline, minus removed emulation tests, plus new tests)

### Step 4: Commit

```
chore: remove dead code from slash command simplification
```

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| `/help` breaks (it depended on EMULATABLE_COMMANDS listing) | Keep /help emulator with augmentHelp; uses capabilities data |
| `/clear` handled wrongly | /clear is frontend-only (Composer.tsx, not sent to backend). Verify. |
| PTY used elsewhere | Check if `CommandRunner` is used outside slash commands before removing |
| Pending passthrough timeout | Out of scope for this PR, but noted as follow-up |
| CLI not connected — commands queue forever | Existing behavior, out of scope |

## Out of Scope

- Frontend changes (SlashMenu, Composer) — no changes needed
- PTY subsystem removal (it may be used elsewhere)
- Passthrough timeout handling
- Model state update after `/model` switch
