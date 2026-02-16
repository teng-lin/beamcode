import { create } from "zustand";
import type {
  ConsumerContentBlock,
  ConsumerMessage,
  ConsumerPermissionRequest,
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
  } | null;
  toolProgress: Record<string, { toolName: string; elapsedSeconds: number }>;
}

interface AppState {
  // Session data (grouped per session)
  sessionData: Record<string, SessionData>;
  sessions: Record<string, SdkSessionInfo>;
  currentSessionId: string | null;

  // UI state
  darkMode: boolean;
  sidebarOpen: boolean;
  taskPanelOpen: boolean;

  // Actions
  setCurrentSession: (id: string) => void;
  toggleSidebar: () => void;
  toggleTaskPanel: () => void;
  toggleDarkMode: () => void;

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
    caps: { commands: InitializeCommand[]; models: InitializeModel[] },
  ) => void;
  setToolProgress: (
    sessionId: string,
    toolUseId: string,
    toolName: string,
    elapsedSeconds: number,
  ) => void;

  // Session list actions
  setSessions: (sessions: Record<string, SdkSessionInfo>) => void;
  updateSession: (id: string, update: Partial<SdkSessionInfo>) => void;
  removeSession: (id: string) => void;
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
  const val = localStorage.getItem(key);
  if (val === null) return fallback;
  return val !== "false";
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

  setCurrentSession: (id) => set({ currentSessionId: id }),
  toggleSidebar: () =>
    set((s) => {
      const next = !s.sidebarOpen;
      localStorage.setItem("beamcode_sidebar_open", String(next));
      return { sidebarOpen: next };
    }),
  toggleTaskPanel: () => set((s) => ({ taskPanelOpen: !s.taskPanelOpen })),
  toggleDarkMode: () =>
    set((s) => {
      const next = !s.darkMode;
      localStorage.setItem("beamcode_dark_mode", String(next));
      return { darkMode: next };
    }),

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
