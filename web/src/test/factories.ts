import type {
  AssistantContent,
  ConsumerContentBlock,
  ConsumerMessage,
  ConsumerPermissionRequest,
} from "../../../shared/consumer-types";
import type { SdkSessionInfo } from "../store";
import { useStore } from "../store";

// ── Store helpers ────────────────────────────────────────────────────────────

export function resetStore(overrides?: Partial<ReturnType<typeof useStore.getState>>): void {
  useStore.setState({
    sessionData: {},
    sessions: {},
    currentSessionId: null,
    sidebarOpen: false,
    taskPanelOpen: false,
    shortcutsModalOpen: false,
    darkMode: true,
    ...overrides,
  });
}

export function store(): ReturnType<typeof useStore.getState> {
  return useStore.getState();
}

// ── Domain factories ─────────────────────────────────────────────────────────

export function makePermission(
  overrides?: Partial<ConsumerPermissionRequest>,
): ConsumerPermissionRequest {
  return {
    request_id: "perm-1",
    tool_use_id: "tu-1",
    tool_name: "Bash",
    description: "Run a command",
    input: { command: "ls" },
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeSessionInfo(
  overrides: Partial<SdkSessionInfo> & { sessionId: string },
): SdkSessionInfo {
  return { cwd: "/tmp", state: "connected", createdAt: Date.now(), ...overrides };
}

export function makeAssistantContent(
  content: ConsumerContentBlock[],
  overrides?: Partial<AssistantContent>,
): AssistantContent {
  return {
    id: "msg-1",
    type: "message",
    role: "assistant",
    model: "claude-3-opus",
    content,
    stop_reason: "end_turn",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  };
}

export function makeAssistantMessage(
  parentToolUseId: string | null = null,
  id = "msg-1",
): Extract<ConsumerMessage, { type: "assistant" }> {
  return {
    type: "assistant",
    parent_tool_use_id: parentToolUseId,
    message: makeAssistantContent([{ type: "text", text: "Hello" }], { id }),
  };
}

export function makeToolUseBlock(
  overrides?: Partial<{ id: string; name: string; input: Record<string, unknown> }>,
): Extract<ConsumerContentBlock, { type: "tool_use" }> {
  return {
    type: "tool_use",
    id: overrides?.id ?? "t1",
    name: overrides?.name ?? "Bash",
    input: overrides?.input ?? { command: "ls" },
  };
}
