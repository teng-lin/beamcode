/**
 * OpenCode protocol types -- models the REST + SSE wire format
 * from the opencode serve API. Type definitions only, no runtime code.
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
// Messages
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
  | {
      status: "error";
      input: Record<string, unknown>;
      error: string;
      time: { start: number; end: number };
    };

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
  | {
      type: "message.part.removed";
      properties: { partID: string; messageID: string; sessionID: string };
    }
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
