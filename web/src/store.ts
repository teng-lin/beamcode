import { create } from "zustand";
import type {
  ConsumerContentBlock,
  ConsumerMessage,
  ConsumerPermissionRequest,
  ConsumerRole,
  ConsumerSessionState,
  InitializeCommand,
  InitializeModel,
} from "../../shared/consumer-types";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SdkSessionInfo {
  sessionId: string;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  cwd: string;
  createdAt: number;
  cliSessionId?: string;
  archived?: boolean;
  name?: string;
  adapterType?: string;
}

export interface SessionIdentity {
  userId: string;
  displayName: string;
  role: ConsumerRole;
}

export interface SessionData {
  messages: ConsumerMessage[];
  streaming: string | null;
  streamingStartedAt: number | null;
  streamingOutputTokens: number;
  streamingBlocks: ConsumerContentBlock[];
  connectionStatus: "connected" | "connecting" | "disconnected";
  cliConnected: boolean;
  sessionStatus: "idle" | "running" | "compacting" | null;
  pendingPermissions: Record<string, ConsumerPermissionRequest>;
  state: ConsumerSessionState | null;
  capabilities: {
    commands: InitializeCommand[];
    models: InitializeModel[];
    skills: string[];
  } | null;
  toolProgress: Record<string, { toolName: string; elapsedSeconds: number }>;
  agentStreaming: Record<
    string,
    {
      text: string | null;
      startedAt: number | null;
      outputTokens: number;
    }
  >;
  reconnectAttempt: number;
  identity: SessionIdentity | null;
  presence: Array<{ userId: string; displayName: string; role: ConsumerRole }>;
}

export interface AppState {
  // Session data (grouped per session)
  sessionData: Record<string, SessionData>;
  sessions: Record<string, SdkSessionInfo>;
  currentSessionId: string | null;

  // UI state
  darkMode: boolean;
  sidebarOpen: boolean;
  taskPanelOpen: boolean;
  shortcutsModalOpen: boolean;
  inspectedAgentId: string | null;

  // Actions
  setCurrentSession: (id: string) => void;
  toggleSidebar: () => void;
  toggleTaskPanel: () => void;
  setTaskPanelOpen: (open: boolean) => void;
  toggleDarkMode: () => void;
  setShortcutsModalOpen: (open: boolean) => void;
  setInspectedAgent: (id: string | null) => void;

  // Session data actions
  ensureSessionData: (id: string) => void;
  addMessage: (sessionId: string, message: ConsumerMessage) => void;
  setMessages: (sessionId: string, messages: ConsumerMessage[]) => void;
  setStreaming: (sessionId: string, text: string | null) => void;
  appendStreaming: (sessionId: string, delta: string) => void;
  setStreamingStarted: (sessionId: string, ts: number | null) => void;
  setStreamingOutputTokens: (sessionId: string, count: number) => void;
  setStreamingBlocks: (sessionId: string, blocks: ConsumerContentBlock[]) => void;
  clearStreaming: (sessionId: string) => void;
  setConnectionStatus: (
    sessionId: string,
    status: "connected" | "connecting" | "disconnected",
  ) => void;
  setCliConnected: (sessionId: string, connected: boolean) => void;
  setSessionStatus: (sessionId: string, status: "idle" | "running" | "compacting" | null) => void;
  addPermission: (sessionId: string, request: ConsumerPermissionRequest) => void;
  removePermission: (sessionId: string, requestId: string) => void;
  setSessionState: (sessionId: string, state: ConsumerSessionState | null) => void;
  setCapabilities: (
    sessionId: string,
    caps: { commands: InitializeCommand[]; models: InitializeModel[]; skills: string[] },
  ) => void;
  setToolProgress: (
    sessionId: string,
    toolUseId: string,
    toolName: string,
    elapsedSeconds: number,
  ) => void;
  setReconnectAttempt: (sessionId: string, attempt: number) => void;
  setIdentity: (sessionId: string, identity: SessionIdentity | null) => void;
  setPresence: (
    sessionId: string,
    consumers: Array<{ userId: string; displayName: string; role: ConsumerRole }>,
  ) => void;
  initAgentStreaming: (sessionId: string, agentId: string) => void;
  appendAgentStreaming: (sessionId: string, agentId: string, delta: string) => void;
  setAgentStreamingOutputTokens: (sessionId: string, agentId: string, count: number) => void;
  clearAgentStreaming: (sessionId: string, agentId: string) => void;

  // Session list actions
  setSessions: (sessions: Record<string, SdkSessionInfo>) => void;
  updateSession: (id: string, update: Partial<SdkSessionInfo>) => void;
  removeSession: (id: string) => void;
}

// ── Selector helpers ────────────────────────────────────────────────────────

/** Get the current session's data, or undefined if no session is active. */
export function currentData(s: AppState) {
  return s.currentSessionId ? s.sessionData[s.currentSessionId] : undefined;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function emptySessionData(): SessionData {
  return {
    messages: [],
    streaming: null,
    streamingStartedAt: null,
    streamingOutputTokens: 0,
    streamingBlocks: [],
    connectionStatus: "disconnected",
    cliConnected: false,
    sessionStatus: null,
    pendingPermissions: {},
    state: null,
    capabilities: null,
    toolProgress: {},
    agentStreaming: {},
    reconnectAttempt: 0,
    identity: null,
    presence: [],
  };
}

/** Merge a partial update into a single session's data, initializing if absent. */
function patchSession(
  state: AppState,
  sessionId: string,
  patch: Partial<SessionData>,
): Pick<AppState, "sessionData"> {
  const data = state.sessionData[sessionId] ?? emptySessionData();
  return {
    sessionData: {
      ...state.sessionData,
      [sessionId]: { ...data, ...patch },
    },
  };
}

const MAX_MESSAGES_PER_SESSION = 2000;

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const val = localStorage.getItem(key);
    if (val === null) return fallback;
    return val !== "false";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // localStorage unavailable (SSR, private browsing quota, etc.)
  }
}

// ── Store ───────────────────────────────────────────────────────────────────

export const useStore = create<AppState>()((set, get) => ({
  sessionData: {},
  sessions: {},
  currentSessionId: null,

  darkMode: readBool("beamcode_dark_mode", true),
  sidebarOpen: readBool(
    "beamcode_sidebar_open",
    typeof window !== "undefined" && window.innerWidth >= 768,
  ),
  taskPanelOpen: false,
  shortcutsModalOpen: false,
  inspectedAgentId: null,

  setCurrentSession: (id) => set({ currentSessionId: id }),
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebarOpen;
      writeBool("beamcode_sidebar_open", next);
      return { sidebarOpen: next };
    }),
  toggleTaskPanel: () => set((s) => ({ taskPanelOpen: !s.taskPanelOpen })),
  setTaskPanelOpen: (open) => set({ taskPanelOpen: open }),
  toggleDarkMode: () =>
    set((s) => {
      const next = !s.darkMode;
      writeBool("beamcode_dark_mode", next);
      return { darkMode: next };
    }),
  setShortcutsModalOpen: (open) => set({ shortcutsModalOpen: open }),
  setInspectedAgent: (id) => set({ inspectedAgentId: id }),

  ensureSessionData: (id) => {
    if (!get().sessionData[id]) {
      set((s) => patchSession(s, id, {}));
    }
  },

  addMessage: (sessionId, message) =>
    set((s) => {
      const data = s.sessionData[sessionId] ?? emptySessionData();
      const messages = [...data.messages, message];
      return patchSession(s, sessionId, {
        messages:
          messages.length > MAX_MESSAGES_PER_SESSION
            ? messages.slice(-MAX_MESSAGES_PER_SESSION)
            : messages,
      });
    }),

  setMessages: (sessionId, messages) => set((s) => patchSession(s, sessionId, { messages })),

  setStreaming: (sessionId, text) => set((s) => patchSession(s, sessionId, { streaming: text })),

  appendStreaming: (sessionId, delta) =>
    set((s) => {
      const data = s.sessionData[sessionId] ?? emptySessionData();
      return patchSession(s, sessionId, { streaming: (data.streaming ?? "") + delta });
    }),

  setStreamingStarted: (sessionId, ts) =>
    set((s) => patchSession(s, sessionId, { streamingStartedAt: ts })),

  setStreamingOutputTokens: (sessionId, count) =>
    set((s) => patchSession(s, sessionId, { streamingOutputTokens: count })),

  setStreamingBlocks: (sessionId, blocks) =>
    set((s) => patchSession(s, sessionId, { streamingBlocks: blocks })),

  clearStreaming: (sessionId) =>
    set((s) =>
      patchSession(s, sessionId, {
        streaming: null,
        streamingStartedAt: null,
        streamingOutputTokens: 0,
        streamingBlocks: [],
      }),
    ),

  setConnectionStatus: (sessionId, status) =>
    set((s) => patchSession(s, sessionId, { connectionStatus: status })),

  setCliConnected: (sessionId, connected) =>
    set((s) => patchSession(s, sessionId, { cliConnected: connected })),

  setSessionStatus: (sessionId, status) =>
    set((s) => patchSession(s, sessionId, { sessionStatus: status })),

  addPermission: (sessionId, request) =>
    set((s) => {
      const data = s.sessionData[sessionId] ?? emptySessionData();
      return patchSession(s, sessionId, {
        pendingPermissions: {
          ...data.pendingPermissions,
          [request.request_id]: request,
        },
      });
    }),

  removePermission: (sessionId, requestId) =>
    set((s) => {
      const data = s.sessionData[sessionId];
      if (!data) return s;
      const { [requestId]: _, ...rest } = data.pendingPermissions;
      return patchSession(s, sessionId, { pendingPermissions: rest });
    }),

  setSessionState: (sessionId, state) => set((s) => patchSession(s, sessionId, { state })),

  setCapabilities: (sessionId, caps) =>
    set((s) => patchSession(s, sessionId, { capabilities: caps })),

  setToolProgress: (sessionId, toolUseId, toolName, elapsedSeconds) =>
    set((s) => {
      const data = s.sessionData[sessionId] ?? emptySessionData();
      return patchSession(s, sessionId, {
        toolProgress: {
          ...data.toolProgress,
          [toolUseId]: { toolName, elapsedSeconds },
        },
      });
    }),

  setReconnectAttempt: (sessionId, attempt) =>
    set((s) => patchSession(s, sessionId, { reconnectAttempt: attempt })),

  setIdentity: (sessionId, identity) => set((s) => patchSession(s, sessionId, { identity })),

  setPresence: (sessionId, consumers) =>
    set((s) => patchSession(s, sessionId, { presence: consumers })),

  initAgentStreaming: (sessionId, agentId) =>
    set((s) => {
      const data = s.sessionData[sessionId] ?? emptySessionData();
      return patchSession(s, sessionId, {
        agentStreaming: {
          ...data.agentStreaming,
          [agentId]: { text: "", startedAt: Date.now(), outputTokens: 0 },
        },
      });
    }),

  appendAgentStreaming: (sessionId, agentId, delta) =>
    set((s) => {
      const data = s.sessionData[sessionId] ?? emptySessionData();
      const current = data.agentStreaming[agentId];
      return patchSession(s, sessionId, {
        agentStreaming: {
          ...data.agentStreaming,
          [agentId]: {
            text: (current?.text ?? "") + delta,
            startedAt: current?.startedAt ?? null,
            outputTokens: current?.outputTokens ?? 0,
          },
        },
      });
    }),

  setAgentStreamingOutputTokens: (sessionId, agentId, count) =>
    set((s) => {
      const data = s.sessionData[sessionId] ?? emptySessionData();
      const current = data.agentStreaming[agentId];
      if (!current) return s;
      return patchSession(s, sessionId, {
        agentStreaming: {
          ...data.agentStreaming,
          [agentId]: { ...current, outputTokens: count },
        },
      });
    }),

  clearAgentStreaming: (sessionId, agentId) =>
    set((s) => {
      const data = s.sessionData[sessionId];
      if (!data) return s;
      const { [agentId]: _, ...rest } = data.agentStreaming;
      return patchSession(s, sessionId, { agentStreaming: rest });
    }),

  setSessions: (sessions) => set({ sessions }),
  updateSession: (id, update) =>
    set((s) => ({
      sessions: { ...s.sessions, [id]: { ...s.sessions[id], ...update } },
    })),
  removeSession: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.sessions;
      const { [id]: __, ...restData } = s.sessionData;
      return { sessions: rest, sessionData: restData };
    }),
}));
