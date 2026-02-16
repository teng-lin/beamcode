# Slash Command Research: How Coding Agents Handle Commands

Research conducted 2026-02-15 across Aider, OpenAI Codex CLI, Claude Code SDK, Continue.dev, and Cline.

## Three Architecture Patterns

| Pattern | Used By | How It Works | SDK-Friendly? |
|---------|---------|-------------|---------------|
| **Execute & Mutate** | Aider | Commands directly mutate state (`SwitchCoder` exception) | Poor — exceptions fail silently in API mode |
| **Result Objects** | Continue, Codex | Commands return structured intents; caller handles state | Good — intents map to protocol messages |
| **Prompt Injection** | Cline | Commands rewrite into LLM instructions | Good — works anywhere text flows |

---

## 1. Aider (Aider-AI/aider)

### Architecture

Convention-based dispatch: any `cmd_<name>` method on the `Commands` class becomes `/name`. ~35 commands, ALL client-side.

### Command Parsing

```python
# aider/commands.py
def is_command(self, inp):
    return inp[0] in "/!"

def run(self, inp):
    matching_commands, first_word, rest_inp = self.matching_commands(inp)
    if len(matching_commands) == 1:
        return self.do_run(matching_commands[0][1:], rest_inp)
```

- Supports prefix matching (`/mod` matches `/model`)
- `!` prefix is alias for `/run` (shell commands)

### State Mutation: SwitchCoder Pattern

State-mutating commands raise a `SwitchCoder` exception that propagates to the main loop, which reconstructs the entire `Coder` object:

```python
# Command raises exception with new params
raise SwitchCoder(main_model=model, edit_format=new_edit_format)

# Main loop catches and reconstructs
while True:
    try:
        coder.run()
    except SwitchCoder as switch:
        coder = Coder.create(from_coder=coder, **switch.kwargs)
```

### Preprocessing Pipeline

```python
# aider/coders/base_coder.py
def preproc_user_input(self, inp):
    if self.commands.is_command(inp):
        return self.commands.run(inp)  # Intercept: no LLM call
    return inp  # Proceed to LLM
```

### API Mode

Commands work via `coder.run("/tokens")` but `SwitchCoder` commands silently fail in `--message` mode.

### Command Catalog

| Category | Commands |
|----------|----------|
| Model switching | `/model`, `/editor-model`, `/weak-model` |
| Mode switching | `/chat-mode`, `/ask`, `/code`, `/architect` |
| File management | `/add`, `/drop`, `/read-only` |
| History | `/clear`, `/reset` |
| Git | `/commit`, `/undo`, `/diff`, `/git` |
| Execution | `/run`, `/test`, `/lint` |
| Diagnostics | `/tokens`, `/ls`, `/map`, `/settings` |
| I/O | `/voice`, `/paste`, `/copy`, `/copy-context` |
| Content | `/web` |
| Batch | `/load`, `/save` |
| Config | `/think-tokens`, `/reasoning-effort` |

---

## 2. OpenAI Codex CLI (openai/codex)

### Architecture

Rust enum (`SlashCommand`) with `strum` derive macros. Two-stage dispatch: `chat_composer` parses input, `ChatWidget::dispatch_command()` handles each variant.

### Clean SDK Separation

The `app-server` JSON-RPC protocol does NOT expose slash commands. Each TUI command maps to a dedicated RPC method:

| TUI Command | App-Server RPC |
|------------|----------------|
| `/new` | `thread/start` |
| `/compact` | `thread/compact/start` |
| `/model` | `model/list` + `turn/start { model }` |
| `/resume` | `thread/resume` |
| `/fork` | `thread/fork` |
| `/review` | `review/start` |
| `/skills` | `skills/list` |
| `/rename` | `thread/name/set` |
| `/ps`, `/clean` | `thread/backgroundTerminals/clean` |

### Dispatch Patterns

| Pattern | Commands | How |
|---------|----------|-----|
| AppEvent dispatch | `/new`, `/resume`, `/fork` | Sends events to app event loop |
| Core Op dispatch | `/compact`, `/memory-drop` | Sends ops to codex engine |
| UI popup | `/model`, `/permissions`, `/personality` | Opens TUI selection view |
| Submit as prompt | `/init` | Injects prompt as user message |
| Inline computation | `/diff`, `/status` | Runs locally, inserts results |

### Task-Running Guards

Commands classified as available/blocked during active tasks:
- **Blocked**: `/model`, `/compact`, `/new`, `/resume`, `/permissions`
- **Available**: `/diff`, `/status`, `/rename`, `/skills`, `/quit`

---

## 3. Claude Code SDK Mode

### Limited Subset

Only `/compact`, `/clear`, `/help` + custom skills work in SDK mode. Interactive commands (`/model`, `/permissions`, `/plan`) are TUI-only.

### State Communication

Changes emit typed system messages:
```typescript
// Compaction result
{ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens, post_tokens } }
```

### Command Discovery

The `init` system message includes a `slash_commands` array listing available commands.

---

## 4. Continue.dev (continuedev/continue)

### Architecture

Declarative command registry with distinct separation:
- **System commands** (client-side state management)
- **Assistant prompts** (LLM-based slash commands)
- **Built-in legacy commands** (with `run()` generators)

### Result Object Pattern

Commands return intent objects rather than mutating state:
```typescript
const commandHandlers = {
  clear: () => ({ clear: true, output: "Chat history cleared" }),
  model: () => ({ openModelSelector: true }),
  compact: () => ({ compact: true }),
  exit: () => ({ exit: true, output: "Goodbye!" }),
};
```

### Remote Mode Restriction

Separate, restricted command set for remote mode:
```typescript
export const REMOTE_MODE_SLASH_COMMANDS = [
  { name: "exit", description: "Exit the remote environment" },
  { name: "diff", description: "Show the current diff" },
  { name: "apply", description: "Apply the current diff locally" },
];
```

### Command Resolution Order

1. Built-in system commands
2. Assistant prompts (from config)
3. Invokable rules (from config)
4. Unknown command error

---

## 5. Cline (cline/cline)

### Architecture

Text preprocessing: slash commands are transformed into XML-wrapped instructions before being sent to the LLM.

### Transformation Pattern

```
/compact → <explicit_instructions type="compact">Please condense...</explicit_instructions>
/newrule → <explicit_instructions type="newrule">Create a new rule...</explicit_instructions>
```

No state mutation — commands become LLM context.

### Unique Features

- Slash commands allowed **anywhere in the message** (not just at start)
- Only one slash command per message
- File-based workflows: Markdown files in workspace become slash commands

### Command Resolution Priority

1. Built-in defaults (`/newtask`, `/compact`, `/newrule`, etc.)
2. MCP prompt commands (`/mcp:server:prompt`)
3. Local workflows (workspace files)
4. Global workflows (global config files)
5. Remote workflows

---

## Cross-Project Comparison

### Command Parsing

| Aspect | Aider | Codex | Continue | Cline |
|--------|-------|-------|----------|-------|
| Detection | `inp[0] in "/!"` | Enum match | `input.startsWith("/")` | Regex anywhere in text |
| Prefix matching | Yes | No (exact) | No (exact) | No (exact) |
| Custom commands | `/load` files | AGENTS.md | Config prompts | Workflow files |
| Extensibility | Python methods | Enum variants | YAML/JSON/TS | Markdown files |

### Client vs Server Handling

| Aspect | Aider | Codex | Continue | Cline |
|--------|-------|-------|----------|-------|
| Where | All client-side | TUI layer | System: client / Legacy: SDK | Core preprocessing |
| LLM involvement | Commands skip LLM | `/init` only | Prompts go to LLM | All become LLM context |
| SDK approach | Same API | Separate RPC methods | Result objects | Preprocessing |

### State Mutations

| Aspect | Aider | Codex | Continue | Cline |
|--------|-------|-------|----------|-------|
| Mechanism | `SwitchCoder` exception | `AppEvent`/`Op` dispatch | Result intent objects | No mutation (prompt injection) |
| Model change | Reconstructs `Coder` | UI popup + config write | `{ openModelSelector: true }` | N/A |
| Clear history | Direct mutation | `Op::Clear` | `{ clear: true }` | N/A |

---

## Implications for BeamCode

### Recommended Approach

Based on this research, BeamCode (as a relay) should adopt a hybrid of **Codex's protocol separation** and **Continue's result objects**:

1. **Consumer-side commands** — Handle in browser JS, never hit the server:
   - `/help` — Show help UI
   - `/clear` — Clear local message display
   - `/cost` — Show cached cost info

2. **Relay-mediated commands** — Send as typed JSON messages through WS, let the relay translate:
   - `/model <name>` — `{ type: "slash_command", command: "model", args: "sonnet" }`
   - `/compact` — `{ type: "slash_command", command: "compact" }`
   - These get forwarded to the CLI as proper protocol messages

3. **Pass-through commands** — Forward as regular user messages (Claude Code handles internally):
   - Custom skills (`/skill-name`)
   - Any unrecognized `/` command

4. **Restricted set** — Like Continue's remote mode, only expose commands that make sense over a relay. Block commands that require TUI interaction (model picker, permission dialogs).

### Protocol Design

```typescript
// Consumer → Relay
{ type: "slash_command", command: "compact", args?: string }

// Relay → Consumer (result)
{ type: "slash_command_result", command: "compact", success: true, content?: string }
{ type: "slash_command_error", command: "compact", error: string }
```

### Command Registry

```typescript
interface SlashCommandDef {
  name: string;
  description: string;
  category: "consumer" | "relay" | "passthrough";
  availableDuringTask: boolean;
}
```
