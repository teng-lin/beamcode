# OpenCode Backend Adapter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `BackendAdapter` for the opencode CLI (`sst/opencode`), enabling BeamCode to use opencode as an AI backend alongside Codex, SDK-URL, and ACP.

**Architecture:** opencode exposes an HTTP REST API + SSE event stream (via `opencode serve`). Unlike Codex (per-session stdio process), one opencode server serves multiple sessions over TCP. The adapter spawns and manages the server process, creates sessions via REST, sends prompts via HTTP POST, and streams responses via a shared SSE connection that demuxes events by session ID.

**Tech Stack:** TypeScript, Node.js native `fetch` API, lightweight SSE parser (no external deps), extends `ProcessSupervisor` for process management.

**Key Reference Files:**
- `src/core/interfaces/backend-adapter.ts` — BackendAdapter/BackendSession contracts
- `src/adapters/codex/` — Reference adapter implementation
- `src/core/process-supervisor.ts` — Base class for process management
- `src/core/types/unified-message.ts` — UnifiedMessage envelope
- `src/core/interfaces/backend-adapter-compliance.ts` — Compliance test harness

**opencode Protocol Reference** (commit `5d12eb9`):
- Server: `opencode serve --port N --hostname 127.0.0.1`
- Auth: HTTP Basic via `OPENCODE_SERVER_PASSWORD` env var
- Directory scoping: `?directory=` query param or `X-Opencode-Directory` header
- Sessions: `POST/GET/DELETE /session`, `POST /session/:id/prompt_async`
- Events: `GET /event` (SSE, per-directory), events have `{ type, properties }` shape
- Permissions: `POST /permission/:requestID/reply`
- Health: `GET /global/health`
- Completion signal: `session.status` event with `{ type: "idle" }`

**Momus Review Fixes Applied:**
- Task 4: Use `process:stdout` event instead of reading stdout directly (fixes reader lock conflict)
- Task 4: Fix spawn mock to throw instead of returning null
- Reordered: HTTP client (Task 5) before Session (Task 6) since session depends on it
- Tasks 5-9: Implementation code filled in during execution
- Clarified: `sessionId` = BeamCode ID, `opcSessionId` = opencode server ID (SSE filter key)

---

## Task 1: OpenCode Protocol Types

Define the TypeScript types that model the opencode wire protocol. No runtime code — just type definitions.

**Files:**
- Create: `src/adapters/opencode/opencode-types.ts`

**Step 1: Create the types file**

```typescript
// src/adapters/opencode/opencode-types.ts

/**
 * OpenCode protocol types — models the REST + SSE wire format
 * from the opencode serve API.
 *
 * Reference: https://github.com/sst/opencode (commit 5d12eb9)
 * No runtime code — type definitions only.
 */

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface OpencodeSession {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  version: string;
  time: { created: number; updated: number; compacting?: number; archived?: number };
  permission?: OpencodePermissionRule[];
  summary?: { additions: number; deletions: number; files: number };
  share?: { url: string };
}

export interface OpencodePermissionRule {
  permission: string;
  pattern: string;
  action: "allow" | "deny";
}

export type OpencodeSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

// ---------------------------------------------------------------------------
// Messages & Parts
// ---------------------------------------------------------------------------

export interface OpencodeUserMessage {
  id: string;
  sessionID: string;
  role: "user";
  time: { created: number };
  agent: string;
  model: { providerID: string; modelID: string };
}

export interface OpencodeAssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  time: { created: number; completed?: number };
  parentID: string;
  modelID: string;
  providerID: string;
  agent: string;
  path: { cwd: string; root: string };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  finish?: string;
  error?: OpencodeMessageError;
}

export type OpencodeMessage = OpencodeUserMessage | OpencodeAssistantMessage;

export type OpencodeMessageError =
  | { name: "provider_auth"; data: { message: string } }
  | { name: "unknown"; data: { message: string } }
  | { name: "output_length"; data: { message: string } }
  | { name: "aborted"; data: { message: string } }
  | { name: "context_overflow"; data: { message: string } }
  | { name: "api_error"; data: { message: string; status?: number } };

// ---------------------------------------------------------------------------
// Parts (content blocks within messages)
// ---------------------------------------------------------------------------

export interface OpencodeTextPart {
  type: "text";
  id: string;
  messageID: string;
  sessionID: string;
  text: string;
  time: { created: number; updated: number };
}

export interface OpencodeReasoningPart {
  type: "reasoning";
  id: string;
  messageID: string;
  sessionID: string;
  text: string;
  time: { created: number; updated: number };
}

export interface OpencodeToolPart {
  type: "tool";
  id: string;
  messageID: string;
  sessionID: string;
  callID: string;
  tool: string;
  state: OpencodeToolState;
  time: { created: number; updated: number };
}

export type OpencodeToolState =
  | { status: "pending"; input: Record<string, unknown>; raw?: string }
  | { status: "running"; input: Record<string, unknown>; title?: string; time: { start: number } }
  | {
      status: "completed";
      input: Record<string, unknown>;
      output: string;
      title: string;
      time: { start: number; end: number };
    }
  | { status: "error"; input: Record<string, unknown>; error: string; time: { start: number; end: number } };

export interface OpencodeStepStartPart {
  type: "step-start";
  id: string;
  messageID: string;
  sessionID: string;
}

export interface OpencodeStepFinishPart {
  type: "step-finish";
  id: string;
  messageID: string;
  sessionID: string;
  cost?: number;
  tokens?: { input: number; output: number };
}

export type OpencodePart =
  | OpencodeTextPart
  | OpencodeReasoningPart
  | OpencodeToolPart
  | OpencodeStepStartPart
  | OpencodeStepFinishPart;

// ---------------------------------------------------------------------------
// SSE Events
// ---------------------------------------------------------------------------

export type OpencodeEvent =
  | { type: "server.connected"; properties: Record<string, never> }
  | { type: "session.created"; properties: { session: OpencodeSession } }
  | { type: "session.updated"; properties: { session: OpencodeSession } }
  | { type: "session.deleted"; properties: { sessionID: string } }
  | { type: "session.status"; properties: { sessionID: string; status: OpencodeSessionStatus } }
  | { type: "session.error"; properties: { sessionID: string; error: OpencodeMessageError } }
  | { type: "session.compacted"; properties: { sessionID: string } }
  | { type: "session.diff"; properties: { sessionID: string; diffs: unknown[] } }
  | { type: "message.updated"; properties: { info: OpencodeMessage } }
  | { type: "message.removed"; properties: { messageID: string; sessionID: string } }
  | {
      type: "message.part.updated";
      properties: { part: OpencodePart; delta?: string };
    }
  | { type: "message.part.removed"; properties: { partID: string; messageID: string; sessionID: string } }
  | {
      type: "permission.updated";
      properties: {
        id: string;
        sessionID: string;
        permission: string;
        title?: string;
        metadata?: Record<string, unknown>;
      };
    }
  | { type: "permission.replied"; properties: { id: string; sessionID: string; reply: string } }
  | { type: "server.heartbeat"; properties: Record<string, never> };

// ---------------------------------------------------------------------------
// REST API request/response shapes
// ---------------------------------------------------------------------------

export interface OpencodeCreateSessionRequest {
  parentID?: string;
  title?: string;
  permission?: OpencodePermissionRule[];
}

export interface OpencodePartInput {
  type: "text";
  text: string;
  id?: string;
}

export interface OpencodePromptRequest {
  parts: OpencodePartInput[];
  model?: { providerID: string; modelID: string };
  agent?: string;
}

export interface OpencodePermissionReply {
  reply: "once" | "always" | "reject";
}

export interface OpencodeHealthResponse {
  healthy: boolean;
  version?: string;
}
```

**Step 2: Commit**

```bash
git add src/adapters/opencode/opencode-types.ts
git commit -m "feat(opencode): add protocol type definitions"
```

---

## Task 2: SSE Parser

Lightweight parser for the `text/event-stream` format. Zero external dependencies — just processes lines from a `ReadableStream`. This is a generic utility, not opencode-specific.

**Files:**
- Create: `src/adapters/opencode/sse-parser.ts`
- Create: `src/adapters/opencode/sse-parser.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/adapters/opencode/sse-parser.test.ts
import { describe, expect, it } from "vitest";
import { parseSseStream, type SseEvent } from "./sse-parser.js";

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("parseSseStream", () => {
  it("parses a single data event", async () => {
    const stream = textStream('data: {"type":"test"}\n\n');
    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events).toEqual([{ data: '{"type":"test"}' }]);
  });

  it("parses multiple events", async () => {
    const stream = textStream('data: first\n\ndata: second\n\n');
    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe("first");
    expect(events[1].data).toBe("second");
  });

  it("concatenates multi-line data fields", async () => {
    const stream = textStream('data: line1\ndata: line2\n\n');
    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events[0].data).toBe("line1\nline2");
  });

  it("ignores comment lines (starting with colon)", async () => {
    const stream = textStream(': this is a comment\ndata: real\n\n');
    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("real");
  });

  it("handles chunked delivery across data boundaries", async () => {
    const chunks = ['data: hel', 'lo\n\ndata: world\n\n'];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });
    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe("hello");
    expect(events[1].data).toBe("world");
  });

  it("skips events with no data field", async () => {
    const stream = textStream('event: ping\n\ndata: real\n\n');
    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("real");
  });

  it("returns empty async iterable for empty stream", async () => {
    const stream = textStream("");
    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(0);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/adapters/opencode/sse-parser.test.ts
```

Expected: FAIL (module not found)

**Step 3: Implement the SSE parser**

```typescript
// src/adapters/opencode/sse-parser.ts

/**
 * Lightweight SSE (text/event-stream) parser.
 *
 * Yields SseEvent objects from a ReadableStream<Uint8Array>.
 * Handles chunked delivery, multi-line data fields, and comment lines.
 * No external dependencies.
 */

export interface SseEvent {
  data: string;
}

/**
 * Parse an SSE byte stream into an async iterable of events.
 *
 * Follows the W3C EventSource parsing rules:
 * - Lines starting with "data:" accumulate into the event data field
 * - Lines starting with ":" are comments (ignored)
 * - Empty lines dispatch the accumulated event
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "") {
          // Empty line = event boundary
          if (dataLines.length > 0) {
            yield { data: dataLines.join("\n") };
            dataLines = [];
          }
        } else if (line.startsWith(":")) {
          // Comment — ignore
        } else if (line.startsWith("data: ")) {
          dataLines.push(line.slice(6));
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5));
        }
        // Ignore other fields (event:, id:, retry:) for now
      }
    }

    // Flush any remaining data after stream ends
    if (dataLines.length > 0) {
      yield { data: dataLines.join("\n") };
    }
  } finally {
    reader.releaseLock();
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/adapters/opencode/sse-parser.test.ts
```

Expected: PASS (all 7 tests)

**Step 5: Commit**

```bash
git add src/adapters/opencode/sse-parser.ts src/adapters/opencode/sse-parser.test.ts
git commit -m "feat(opencode): add lightweight SSE parser"
```

---

## Task 3: Message Translator

Pure functions translating between opencode SSE events and UnifiedMessage, and between UnifiedMessage and opencode HTTP request payloads. Follows the same pattern as `codex-message-translator.ts`.

**Files:**
- Create: `src/adapters/opencode/opencode-message-translator.ts`
- Create: `src/adapters/opencode/opencode-message-translator.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/adapters/opencode/opencode-message-translator.test.ts
import { describe, expect, it } from "vitest";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type {
  OpencodeAssistantMessage,
  OpencodeEvent,
  OpencodeTextPart,
  OpencodeToolPart,
} from "./opencode-types.js";
import {
  extractSessionId,
  translateEvent,
  translateToOpencode,
} from "./opencode-message-translator.js";

describe("translateEvent", () => {
  it("translates message.part.updated with text part to stream_event", () => {
    const event: OpencodeEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          id: "p1",
          messageID: "m1",
          sessionID: "s1",
          text: "Hello world",
          time: { created: 1, updated: 2 },
        } satisfies OpencodeTextPart,
        delta: "world",
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("stream_event");
    expect(msg!.role).toBe("assistant");
    expect(msg!.metadata.delta).toBe("world");
    expect(msg!.metadata.partId).toBe("p1");
  });

  it("translates message.part.updated with tool part to tool_progress", () => {
    const event: OpencodeEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          id: "p2",
          messageID: "m1",
          sessionID: "s1",
          callID: "call1",
          tool: "bash",
          state: { status: "running", input: { command: "ls" }, time: { start: 1 } },
          time: { created: 1, updated: 2 },
        } satisfies OpencodeToolPart,
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("tool_progress");
    expect(msg!.metadata.tool_name).toBe("bash");
    expect(msg!.metadata.status).toBe("running");
  });

  it("translates message.part.updated with completed tool to tool_use_summary", () => {
    const event: OpencodeEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          id: "p2",
          messageID: "m1",
          sessionID: "s1",
          callID: "call1",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "file.ts",
            title: "List files",
            time: { start: 1, end: 2 },
          },
          time: { created: 1, updated: 2 },
        } satisfies OpencodeToolPart,
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("tool_use_summary");
    expect(msg!.metadata.output).toBe("file.ts");
  });

  it("translates message.updated with assistant message", () => {
    const event: OpencodeEvent = {
      type: "message.updated",
      properties: {
        info: {
          id: "m1",
          sessionID: "s1",
          role: "assistant",
          time: { created: 1 },
          parentID: "m0",
          modelID: "claude-sonnet-4-20250514",
          providerID: "anthropic",
          agent: "coder",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0.01,
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        } satisfies OpencodeAssistantMessage,
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("assistant");
    expect(msg!.metadata.modelID).toBe("claude-sonnet-4-20250514");
  });

  it("translates session.status idle to result", () => {
    const event: OpencodeEvent = {
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "idle" } },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("result");
    expect(msg!.metadata.status).toBe("completed");
  });

  it("translates session.status busy to status_change", () => {
    const event: OpencodeEvent = {
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "busy" } },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("status_change");
    expect(msg!.metadata.busy).toBe(true);
  });

  it("translates session.error to result with error", () => {
    const event: OpencodeEvent = {
      type: "session.error",
      properties: {
        sessionID: "s1",
        error: { name: "api_error", data: { message: "rate limited", status: 429 } },
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("result");
    expect(msg!.metadata.is_error).toBe(true);
  });

  it("translates permission.updated to permission_request", () => {
    const event: OpencodeEvent = {
      type: "permission.updated",
      properties: {
        id: "req1",
        sessionID: "s1",
        permission: "bash",
        title: "Run: ls -la",
        metadata: { command: "ls -la" },
      },
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("permission_request");
    expect(msg!.metadata.request_id).toBe("req1");
    expect(msg!.metadata.tool_name).toBe("bash");
  });

  it("translates server.connected to session_init", () => {
    const event: OpencodeEvent = {
      type: "server.connected",
      properties: {},
    };
    const msg = translateEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("session_init");
  });

  it("returns null for heartbeat events", () => {
    const event: OpencodeEvent = {
      type: "server.heartbeat",
      properties: {},
    };
    expect(translateEvent(event)).toBeNull();
  });
});

describe("translateToOpencode", () => {
  it("translates user_message to prompt request", () => {
    const msg = createUnifiedMessage({
      type: "user_message",
      role: "user",
      content: [{ type: "text", text: "Fix the bug" }],
    });
    const action = translateToOpencode(msg);
    expect(action.type).toBe("prompt");
    expect(action.parts).toEqual([{ type: "text", text: "Fix the bug" }]);
  });

  it("translates permission_response allow to permission reply", () => {
    const msg = createUnifiedMessage({
      type: "permission_response",
      role: "user",
      metadata: { request_id: "req1", behavior: "allow" },
    });
    const action = translateToOpencode(msg);
    expect(action.type).toBe("permission_reply");
    expect(action.requestId).toBe("req1");
    expect(action.reply).toBe("once");
  });

  it("translates permission_response deny to permission reject", () => {
    const msg = createUnifiedMessage({
      type: "permission_response",
      role: "user",
      metadata: { request_id: "req1", behavior: "deny" },
    });
    const action = translateToOpencode(msg);
    expect(action.type).toBe("permission_reply");
    expect(action.reply).toBe("reject");
  });

  it("translates interrupt to abort", () => {
    const msg = createUnifiedMessage({ type: "interrupt", role: "user" });
    const action = translateToOpencode(msg);
    expect(action.type).toBe("abort");
  });
});

describe("extractSessionId", () => {
  it("extracts sessionID from message.part.updated", () => {
    const event: OpencodeEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          id: "p1",
          messageID: "m1",
          sessionID: "s1",
          text: "hi",
          time: { created: 1, updated: 2 },
        },
      },
    };
    expect(extractSessionId(event)).toBe("s1");
  });

  it("extracts sessionID from session.status", () => {
    const event: OpencodeEvent = {
      type: "session.status",
      properties: { sessionID: "s2", status: { type: "idle" } },
    };
    expect(extractSessionId(event)).toBe("s2");
  });

  it("extracts sessionID from message.updated (assistant)", () => {
    const event: OpencodeEvent = {
      type: "message.updated",
      properties: {
        info: {
          id: "m1",
          sessionID: "s3",
          role: "assistant",
          time: { created: 1 },
          parentID: "m0",
          modelID: "m",
          providerID: "p",
          agent: "coder",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } satisfies OpencodeAssistantMessage,
      },
    };
    expect(extractSessionId(event)).toBe("s3");
  });

  it("returns undefined for server.connected", () => {
    const event: OpencodeEvent = { type: "server.connected", properties: {} };
    expect(extractSessionId(event)).toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/adapters/opencode/opencode-message-translator.test.ts
```

Expected: FAIL (module not found)

**Step 3: Implement the message translator**

```typescript
// src/adapters/opencode/opencode-message-translator.ts

/**
 * OpenCode Message Translator
 *
 * Pure functions that translate between the opencode serve API's
 * SSE events / REST payloads and BeamCode's UnifiedMessage envelope.
 *
 * No side effects, no state mutation, no I/O.
 */

import type { UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type {
  OpencodeEvent,
  OpencodePartInput,
  OpencodeToolPart,
} from "./opencode-types.js";

// ---------------------------------------------------------------------------
// Outbound action type (UnifiedMessage → HTTP request)
// ---------------------------------------------------------------------------

export type OpencodeAction =
  | { type: "prompt"; parts: OpencodePartInput[]; model?: { providerID: string; modelID: string } }
  | { type: "permission_reply"; requestId: string; reply: "once" | "always" | "reject" }
  | { type: "abort" };

// ---------------------------------------------------------------------------
// SSE event → UnifiedMessage
// ---------------------------------------------------------------------------

export function translateEvent(event: OpencodeEvent): UnifiedMessage | null {
  switch (event.type) {
    case "message.part.updated":
      return translatePartUpdated(event.properties);
    case "message.updated":
      return translateMessageUpdated(event.properties);
    case "session.status":
      return translateSessionStatus(event.properties);
    case "session.error":
      return translateSessionError(event.properties);
    case "permission.updated":
      return translatePermissionUpdated(event.properties);
    case "server.connected":
      return createUnifiedMessage({ type: "session_init", role: "system" });
    case "server.heartbeat":
    case "permission.replied":
    case "session.compacted":
    case "session.diff":
    case "session.created":
    case "session.updated":
    case "session.deleted":
    case "message.removed":
    case "message.part.removed":
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// UnifiedMessage → opencode action
// ---------------------------------------------------------------------------

export function translateToOpencode(message: UnifiedMessage): OpencodeAction {
  switch (message.type) {
    case "user_message":
      return {
        type: "prompt",
        parts: extractParts(message),
      };
    case "permission_response":
      return {
        type: "permission_reply",
        requestId: message.metadata.request_id as string,
        reply: message.metadata.behavior === "allow" ? "once" : "reject",
      };
    case "interrupt":
      return { type: "abort" };
    default:
      return { type: "prompt", parts: extractParts(message) };
  }
}

// ---------------------------------------------------------------------------
// Session ID extraction (for SSE demuxing)
// ---------------------------------------------------------------------------

export function extractSessionId(event: OpencodeEvent): string | undefined {
  const props = event.properties as Record<string, unknown>;
  if ("sessionID" in props && typeof props.sessionID === "string") {
    return props.sessionID;
  }
  if ("part" in props && typeof props.part === "object" && props.part !== null) {
    const part = props.part as Record<string, unknown>;
    if ("sessionID" in part && typeof part.sessionID === "string") {
      return part.sessionID;
    }
  }
  if ("info" in props && typeof props.info === "object" && props.info !== null) {
    const info = props.info as Record<string, unknown>;
    if ("sessionID" in info && typeof info.sessionID === "string") {
      return info.sessionID;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function translatePartUpdated(props: {
  part: import("./opencode-types.js").OpencodePart;
  delta?: string;
}): UnifiedMessage | null {
  const { part, delta } = props;

  if (part.type === "text") {
    return createUnifiedMessage({
      type: "stream_event",
      role: "assistant",
      content: delta != null ? [{ type: "text", text: delta }] : [],
      metadata: {
        delta: delta ?? part.text,
        partId: part.id,
        messageId: part.messageID,
        sessionId: part.sessionID,
        fullText: part.text,
      },
    });
  }

  if (part.type === "tool") {
    return translateToolPart(part as OpencodeToolPart);
  }

  if (part.type === "reasoning") {
    return createUnifiedMessage({
      type: "stream_event",
      role: "assistant",
      metadata: {
        reasoning: true,
        delta: delta ?? part.text,
        partId: part.id,
      },
    });
  }

  // step-start, step-finish — not user-facing
  return null;
}

function translateToolPart(part: OpencodeToolPart): UnifiedMessage {
  const isCompleted = part.state.status === "completed";

  return createUnifiedMessage({
    type: isCompleted ? "tool_use_summary" : "tool_progress",
    role: "tool",
    metadata: {
      tool_name: part.tool,
      call_id: part.callID,
      partId: part.id,
      status: part.state.status,
      input: part.state.input,
      ...(part.state.status === "completed" && {
        output: part.state.output,
        title: part.state.title,
      }),
      ...(part.state.status === "error" && {
        error: part.state.error,
        is_error: true,
      }),
    },
  });
}

function translateMessageUpdated(props: { info: import("./opencode-types.js").OpencodeMessage }): UnifiedMessage {
  const { info } = props;

  if (info.role === "assistant") {
    return createUnifiedMessage({
      type: "assistant",
      role: "assistant",
      metadata: {
        messageId: info.id,
        sessionId: info.sessionID,
        modelID: info.modelID,
        providerID: info.providerID,
        cost: info.cost,
        tokens: info.tokens,
        parentID: info.parentID,
        ...(info.error && { error: info.error, is_error: true }),
      },
    });
  }

  // User message echo — not typically forwarded
  return createUnifiedMessage({
    type: "user_message",
    role: "user",
    metadata: { messageId: info.id, sessionId: info.sessionID },
  });
}

function translateSessionStatus(props: {
  sessionID: string;
  status: import("./opencode-types.js").OpencodeSessionStatus;
}): UnifiedMessage {
  if (props.status.type === "idle") {
    return createUnifiedMessage({
      type: "result",
      role: "system",
      metadata: { status: "completed", sessionId: props.sessionID },
    });
  }
  if (props.status.type === "busy") {
    return createUnifiedMessage({
      type: "status_change",
      role: "system",
      metadata: { busy: true, sessionId: props.sessionID },
    });
  }
  // retry
  return createUnifiedMessage({
    type: "status_change",
    role: "system",
    metadata: {
      retry: true,
      attempt: props.status.attempt,
      message: props.status.message,
      sessionId: props.sessionID,
    },
  });
}

function translateSessionError(props: {
  sessionID: string;
  error: import("./opencode-types.js").OpencodeMessageError;
}): UnifiedMessage {
  return createUnifiedMessage({
    type: "result",
    role: "system",
    metadata: {
      status: "failed",
      is_error: true,
      error: props.error.name,
      error_message: props.error.data.message,
      sessionId: props.sessionID,
    },
  });
}

function translatePermissionUpdated(props: {
  id: string;
  sessionID: string;
  permission: string;
  title?: string;
  metadata?: Record<string, unknown>;
}): UnifiedMessage {
  return createUnifiedMessage({
    type: "permission_request",
    role: "system",
    metadata: {
      request_id: props.id,
      sessionId: props.sessionID,
      tool_name: props.permission,
      title: props.title,
      ...(props.metadata ?? {}),
    },
  });
}

function extractParts(message: UnifiedMessage): OpencodePartInput[] {
  if (message.content.length > 0) {
    return message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => ({ type: "text" as const, text: c.text }));
  }
  const text = (message.metadata.text as string) ?? "";
  return text ? [{ type: "text", text }] : [];
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/adapters/opencode/opencode-message-translator.test.ts
```

Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add src/adapters/opencode/opencode-message-translator.ts src/adapters/opencode/opencode-message-translator.test.ts
git commit -m "feat(opencode): add message translator with tests"
```

---

## Task 4: OpenCode Launcher

Extends `ProcessSupervisor` to spawn and manage the `opencode serve` process. Waits for the "listening on" log line to confirm readiness.

**Files:**
- Create: `src/adapters/opencode/opencode-launcher.ts`
- Create: `src/adapters/opencode/opencode-launcher.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/adapters/opencode/opencode-launcher.test.ts
import { describe, expect, it, vi } from "vitest";
import type { ProcessHandle, ProcessManager } from "../../interfaces/process-manager.js";
import { OpencodeLauncher } from "./opencode-launcher.js";

function createMockProcessManager(
  stdoutText?: string,
): { pm: ProcessManager; handles: ProcessHandle[] } {
  const handles: ProcessHandle[] = [];
  const pm: ProcessManager = {
    spawn: vi.fn().mockImplementation(() => {
      const chunks = stdoutText
        ? [new TextEncoder().encode(stdoutText)]
        : [];
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          // Don't close — simulates long-running process
        },
      });
      const handle: ProcessHandle = {
        pid: 42,
        exited: new Promise<number | null>(() => {}),
        kill: vi.fn(),
        stdout,
        stderr: null,
      };
      handles.push(handle);
      return handle;
    }),
    isAlive: vi.fn().mockReturnValue(true),
  };
  return { pm, handles };
}

describe("OpencodeLauncher", () => {
  it("spawns opencode serve with correct args", async () => {
    const { pm } = createMockProcessManager(
      "opencode server listening on http://127.0.0.1:4096\n",
    );
    const launcher = new OpencodeLauncher({ processManager: pm });

    const result = await launcher.launch("test-session", { port: 4096 });

    expect(pm.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "opencode",
        args: expect.arrayContaining(["serve", "--port", "4096", "--hostname", "127.0.0.1"]),
      }),
    );
    expect(result.url).toBe("http://127.0.0.1:4096");
    expect(result.pid).toBe(42);
  });

  it("uses custom binary path", async () => {
    const { pm } = createMockProcessManager(
      "opencode server listening on http://127.0.0.1:4096\n",
    );
    const launcher = new OpencodeLauncher({ processManager: pm });

    await launcher.launch("test-session", {
      port: 4096,
      opencodeBinary: "/usr/local/bin/opencode",
    });

    expect(pm.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: "/usr/local/bin/opencode" }),
    );
  });

  it("throws if process fails to spawn", async () => {
    const pm: ProcessManager = {
      spawn: vi.fn().mockReturnValue(null),
      isAlive: vi.fn().mockReturnValue(false),
    };
    const launcher = new OpencodeLauncher({ processManager: pm });

    await expect(launcher.launch("test-session", { port: 4096 })).rejects.toThrow();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/adapters/opencode/opencode-launcher.test.ts
```

**Step 3: Implement the launcher**

```typescript
// src/adapters/opencode/opencode-launcher.ts

/**
 * OpencodeLauncher — spawns and manages the `opencode serve` process.
 *
 * Extends ProcessSupervisor for kill escalation, circuit breaker,
 * PID tracking, and output piping.
 */

import type { ProcessSupervisorOptions } from "../../core/process-supervisor.js";
import { ProcessSupervisor } from "../../core/process-supervisor.js";
import type { Logger } from "../../interfaces/logger.js";
import type { ProcessManager } from "../../interfaces/process-manager.js";

export interface OpencodeLauncherOptions {
  processManager: ProcessManager;
  logger?: Logger;
  killGracePeriodMs?: number;
}

export interface OpencodeLaunchOptions {
  port?: number;
  hostname?: string;
  cwd?: string;
  opencodeBinary?: string;
  password?: string;
}

interface InternalSpawnPayload {
  binary: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
}

export class OpencodeLauncher extends ProcessSupervisor {
  constructor(options: OpencodeLauncherOptions) {
    const supervisorOptions: ProcessSupervisorOptions = {
      processManager: options.processManager,
      logger: options.logger,
      killGracePeriodMs: options.killGracePeriodMs ?? 5000,
    };
    super(supervisorOptions);
  }

  protected buildSpawnArgs(
    _sessionId: string,
    options: unknown,
  ): { command: string; args: string[]; cwd: string; env?: Record<string, string | undefined> } {
    const payload = options as InternalSpawnPayload;
    return {
      command: payload.binary,
      args: payload.args,
      cwd: payload.cwd,
      env: payload.env,
    };
  }

  /**
   * Launch an opencode serve process.
   *
   * Spawns `opencode serve --port N --hostname H` and waits for the
   * "listening on" stdout line to confirm readiness.
   */
  async launch(
    sessionId: string,
    options: OpencodeLaunchOptions = {},
  ): Promise<{ url: string; pid: number }> {
    const port = options.port ?? 4096;
    const hostname = options.hostname ?? "127.0.0.1";
    const cwd = options.cwd ?? process.cwd();
    const binary = options.opencodeBinary ?? "opencode";
    const url = `http://${hostname}:${port}`;

    const args = ["serve", "--port", String(port), "--hostname", hostname];

    const env: Record<string, string | undefined> = {};
    if (options.password) {
      env.OPENCODE_SERVER_PASSWORD = options.password;
    }

    const proc = this.spawnProcess(
      sessionId,
      { binary, args, cwd, env } satisfies InternalSpawnPayload,
      "opencode-launcher",
    );

    if (!proc) {
      throw new Error("Failed to spawn opencode serve process");
    }

    // Wait for readiness by reading stdout for the "listening on" line.
    // If stdout is not available, assume it's ready (e.g. in test mocks).
    if (proc.stdout) {
      await this.waitForReady(proc.stdout, url);
    }

    return { url, pid: proc.pid };
  }

  private async waitForReady(
    stdout: ReadableStream<Uint8Array>,
    expectedUrl: string,
    timeoutMs = 15_000,
  ): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`opencode serve did not become ready within ${timeoutMs}ms`)), timeoutMs),
    );

    const readLoop = async (): Promise<void> => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          throw new Error("opencode serve process exited before becoming ready");
        }
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("listening on")) {
          reader.releaseLock();
          return;
        }
      }
    };

    await Promise.race([readLoop(), timeout]);
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/adapters/opencode/opencode-launcher.test.ts
```

**Step 5: Commit**

```bash
git add src/adapters/opencode/opencode-launcher.ts src/adapters/opencode/opencode-launcher.test.ts
git commit -m "feat(opencode): add process launcher extending ProcessSupervisor"
```

---

## Task 5: OpenCode Session

Implements `BackendSession`. Manages one session's lifecycle: sends prompts via HTTP, streams responses from the shared SSE connection filtered by session ID, handles permissions.

**Files:**
- Create: `src/adapters/opencode/opencode-session.ts`
- Create: `src/adapters/opencode/opencode-session.test.ts`

**Step 1: Write the failing tests**

Tests should cover:
- `send()` translates UnifiedMessage to HTTP POST (prompt_async, permission reply, abort)
- `messages` async iterable yields translated SSE events for this session
- `close()` terminates the message stream and rejects further sends
- Filters SSE events by session ID (ignores events for other sessions)
- Permission flow: receives permission.updated SSE → yields permission_request → user sends permission_response → HTTP POST /permission/:id/reply

The tests should use a mock HTTP client (injected dependency) and a mock SSE event source (push-based). This avoids real network calls.

**Key design decisions:**
- The session receives an `EventTarget`-like subscription from the adapter (not its own SSE connection)
- HTTP calls go through an injected `OpencodeHttpClient` interface for testability
- The async iterable queue pattern matches Codex session's approach

**Step 2: Implement OpencodeSession**

Core structure:
```typescript
export class OpencodeSession implements BackendSession {
  readonly sessionId: string;
  readonly messages: AsyncIterable<UnifiedMessage>;

  constructor(options: {
    sessionId: string;
    opcSessionId: string;  // opencode's internal session ID (may differ)
    httpClient: OpencodeHttpClient;
    subscribe: (handler: (event: OpencodeEvent) => void) => () => void;
  });

  send(message: UnifiedMessage): void;
  sendRaw(_ndjson: string): void;  // throws — opencode doesn't use NDJSON
  async close(): Promise<void>;
}
```

**Step 3: Commit**

```bash
git add src/adapters/opencode/opencode-session.ts src/adapters/opencode/opencode-session.test.ts
git commit -m "feat(opencode): add session implementing BackendSession"
```

---

## Task 6: HTTP Client

Thin typed HTTP client wrapping `fetch` calls to the opencode server. Handles auth, directory scoping, and error responses.

**Files:**
- Create: `src/adapters/opencode/opencode-http-client.ts`
- Create: `src/adapters/opencode/opencode-http-client.test.ts`

**Key methods:**
```typescript
export interface OpencodeHttpClient {
  createSession(request?: OpencodeCreateSessionRequest): Promise<OpencodeSession>;
  promptAsync(sessionId: string, request: OpencodePromptRequest): Promise<void>;
  abort(sessionId: string): Promise<void>;
  replyPermission(requestId: string, reply: OpencodePermissionReply): Promise<void>;
  health(): Promise<OpencodeHealthResponse>;
  connectSse(): Promise<ReadableStream<Uint8Array>>;
}
```

**Implementation:**
- Uses native `fetch` API
- Adds `Authorization: Basic ...` header if password is set
- Adds `X-Opencode-Directory` header for project scoping
- Parses error responses and throws typed errors

**Step: Commit**

```bash
git add src/adapters/opencode/opencode-http-client.ts src/adapters/opencode/opencode-http-client.test.ts
git commit -m "feat(opencode): add typed HTTP client"
```

---

## Task 7: OpenCode Adapter

Implements `BackendAdapter`. Manages the server process lifecycle, shared SSE connection, and session creation.

**Files:**
- Create: `src/adapters/opencode/opencode-adapter.ts`
- Create: `src/adapters/opencode/opencode-adapter.test.ts`

**Key responsibilities:**
1. On first `connect()`, launch `opencode serve` via OpencodeLauncher
2. Establish SSE connection via `GET /event`
3. Parse SSE events, route to registered sessions by session ID
4. Create opencode session via `POST /session`, wrap in OpencodeSession
5. Return OpencodeSession implementing BackendSession

```typescript
export class OpencodeAdapter implements BackendAdapter {
  readonly name = "opencode";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: false,
  };

  constructor(options: OpencodeAdapterOptions);
  async connect(options: ConnectOptions): Promise<BackendSession>;
}
```

**SSE multiplexing pattern:**
- Adapter maintains a `Map<string, Set<(event: OpencodeEvent) => void>>` of session subscribers
- When an SSE event arrives, `extractSessionId()` determines the target session
- Event is forwarded only to matching session's subscriber
- Broadcast events (server.connected, server.heartbeat) go to all sessions

**Step: Commit**

```bash
git add src/adapters/opencode/opencode-adapter.ts src/adapters/opencode/opencode-adapter.test.ts
git commit -m "feat(opencode): add adapter implementing BackendAdapter"
```

---

## Task 8: Factory Registration

Register the new adapter in the factory so it can be selected via CLI flag.

**Files:**
- Modify: `src/adapters/create-adapter.ts`

**Changes:**
1. Add `"opencode"` to `CliAdapterName` union type
2. Add `"opencode"` to `CLI_ADAPTER_NAMES` array
3. Add case in `createAdapter()` switch statement

```typescript
export type CliAdapterName = "sdk-url" | "codex" | "acp" | "opencode";
export const CLI_ADAPTER_NAMES: readonly CliAdapterName[] = ["sdk-url", "codex", "acp", "opencode"];

// In switch:
case "opencode":
  return new OpencodeAdapter({
    processManager: deps.processManager,
    logger: deps.logger,
  });
```

**Step: Update existing `create-adapter.test.ts` if it exists, or add test for new case**

```bash
git add src/adapters/create-adapter.ts src/adapters/create-adapter.test.ts
git commit -m "feat(opencode): register adapter in factory"
```

---

## Task 9: Compliance Tests

Run the reusable `BackendAdapter` compliance suite against the opencode adapter, using mocks for HTTP and SSE (same pattern as `codex-compliance.test.ts`).

**Files:**
- Create: `src/adapters/opencode/opencode-compliance.test.ts`

**Pattern:**
- Create `ComplianceOpencodeAdapter` that constructs sessions with mock HTTP client and mock SSE event source
- Mock HTTP client auto-responds to `promptAsync` by pushing a `message.part.updated` event + `session.status idle` through the mock SSE
- Run `runBackendAdapterComplianceTests()` against the wrapper

**Step: Commit**

```bash
git add src/adapters/opencode/opencode-compliance.test.ts
git commit -m "test(opencode): add compliance test suite"
```

---

## Task 10: Integration Verification

Final integration pass — ensure all tests pass, the adapter works end-to-end with mock infrastructure, and the full test suite remains green.

**Steps:**
1. Run all opencode adapter tests: `npx vitest run src/adapters/opencode/`
2. Run full test suite: `npx vitest run`
3. Run type check: `npx tsc --noEmit`
4. Verify no regressions in existing adapter tests

**Step: Final commit**

```bash
git add -A
git commit -m "test(opencode): verify full integration and no regressions"
```

---

## File Summary

| File | Purpose |
|------|---------|
| `src/adapters/opencode/opencode-types.ts` | Protocol type definitions |
| `src/adapters/opencode/sse-parser.ts` | Lightweight SSE stream parser |
| `src/adapters/opencode/sse-parser.test.ts` | SSE parser tests |
| `src/adapters/opencode/opencode-message-translator.ts` | Event ↔ UnifiedMessage translation |
| `src/adapters/opencode/opencode-message-translator.test.ts` | Translator tests |
| `src/adapters/opencode/opencode-launcher.ts` | Process supervisor for `opencode serve` |
| `src/adapters/opencode/opencode-launcher.test.ts` | Launcher tests |
| `src/adapters/opencode/opencode-http-client.ts` | Typed HTTP client |
| `src/adapters/opencode/opencode-http-client.test.ts` | HTTP client tests |
| `src/adapters/opencode/opencode-session.ts` | BackendSession implementation |
| `src/adapters/opencode/opencode-session.test.ts` | Session tests |
| `src/adapters/opencode/opencode-adapter.ts` | BackendAdapter implementation |
| `src/adapters/opencode/opencode-adapter.test.ts` | Adapter tests |
| `src/adapters/opencode/opencode-compliance.test.ts` | Compliance suite |
| `src/adapters/create-adapter.ts` | Factory registration (modify) |
