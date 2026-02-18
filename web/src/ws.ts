import type {
  ConsumerMessage,
  ConsumerSessionState,
  InboundMessage,
} from "../../shared/consumer-types";
import { useStore } from "./store";
import { stripAnsi } from "./utils/ansi-strip";
import { playCompletionSound } from "./utils/audio";

// ── Module-level state (not a hook) ────────────────────────────────────────

const connections = new Map<string, WebSocket>();
const reconnectState = new Map<
  string,
  { timer: ReturnType<typeof setTimeout> | null; attempt: number }
>();
const MAX_RECONNECT_DELAY = 30_000;

// ── Streaming delta batching ──────────────────────────────────────────────
// Coalesce rapid content_block_delta events into at most one Zustand set()
// per animation frame, reducing re-renders from hundreds/s to ~60/s.

interface PendingDelta {
  /** Accumulated text for the main session streaming. */
  main: string;
  /** Accumulated text per agent sub-stream. */
  agents: Record<string, string>;
}

const pendingDeltas = new Map<string, PendingDelta>();
let flushScheduled = false;

function scheduleDeltaFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(flushDeltas);
}

/** @internal Exported for testing only. */
export function flushDeltas(): void {
  flushScheduled = false;
  // Snapshot and clear atomically to avoid re-entrancy issues if a Zustand
  // subscriber synchronously triggers another bufferStreamingDelta call.
  const snapshot = new Map(pendingDeltas);
  pendingDeltas.clear();
  const store = useStore.getState();
  for (const [sessionId, delta] of snapshot) {
    if (delta.main) {
      store.appendStreaming(sessionId, delta.main);
    }
    for (const [agentId, text] of Object.entries(delta.agents)) {
      store.appendAgentStreaming(sessionId, agentId, text);
    }
  }
}

function bufferStreamingDelta(sessionId: string, agentId: string | null, text: string): void {
  let entry = pendingDeltas.get(sessionId);
  if (!entry) {
    entry = { main: "", agents: {} };
    pendingDeltas.set(sessionId, entry);
  }
  if (agentId) {
    entry.agents[agentId] = (entry.agents[agentId] ?? "") + text;
  } else {
    entry.main += text;
  }
  scheduleDeltaFlush();
}

function getConsumerId(): string {
  const key = "beamcode_consumer_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

// ── Connection management ──────────────────────────────────────────────────

function buildWsUrl(sessionId: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const consumerId = getConsumerId();
  return `${proto}//${location.host}/ws/consumer/${encodeURIComponent(sessionId)}?consumer_id=${encodeURIComponent(consumerId)}`;
}

function handleMessage(sessionId: string, data: string): void {
  const store = useStore.getState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }

  // Guard: ensure parsed value is an object with a string `type` discriminant
  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return;
  const msg = parsed as ConsumerMessage;

  store.ensureSessionData(sessionId);

  switch (msg.type) {
    case "assistant":
      // Flush any buffered deltas before clearing streaming state
      if (pendingDeltas.has(sessionId)) flushDeltas();
      if (msg.parent_tool_use_id) {
        store.clearAgentStreaming(sessionId, msg.parent_tool_use_id);
      } else {
        store.clearStreaming(sessionId);
      }
      store.addMessage(sessionId, msg);
      break;

    case "result":
      if (pendingDeltas.has(sessionId)) flushDeltas();
      store.setSessionStatus(sessionId, "idle");
      store.addMessage(sessionId, msg);
      // Sound + browser notification when tab is hidden
      if (document.hidden) {
        if (store.soundEnabled) playCompletionSound();
        if (
          store.alertsEnabled &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          new Notification("Task complete", {
            body: msg.data.is_error ? "Completed with errors" : "Completed successfully",
          });
        }
      }
      break;

    case "user_message":
    case "error":
    case "slash_command_result":
    case "slash_command_error":
      store.addMessage(sessionId, msg);
      break;

    case "message_queued":
      store.setQueuedMessage(sessionId, {
        consumerId: msg.consumer_id,
        displayName: msg.display_name,
        content: msg.content,
        images: msg.images,
        queuedAt: msg.queued_at,
      });
      break;

    case "queued_message_updated": {
      const prev = store.sessionData[sessionId]?.queuedMessage;
      if (prev) {
        store.setQueuedMessage(sessionId, {
          ...prev,
          content: msg.content,
          images: msg.images,
        });
      }
      break;
    }

    case "queued_message_cancelled":
      store.setQueuedMessage(sessionId, null);
      store.setEditingQueue(sessionId, false);
      break;

    case "queued_message_sent": {
      // Capture position of the queued message element for FLIP animation
      const queuedEl = document.querySelector("[data-queued-message]");
      if (queuedEl) {
        const rect = queuedEl.getBoundingClientRect();
        store.setFlipOrigin(sessionId, { top: rect.top, left: rect.left, width: rect.width });
        // Safety: clear flipOrigin if the echo user_message never arrives
        setTimeout(() => {
          const currentStore = useStore.getState();
          if (currentStore.sessionData[sessionId]?.flipOrigin) {
            currentStore.setFlipOrigin(sessionId, null);
          }
        }, 2000);
      }
      store.setQueuedMessage(sessionId, null);
      store.setEditingQueue(sessionId, false);
      break;
    }

    case "stream_event": {
      const { event, parent_tool_use_id } = msg;
      const agentId = parent_tool_use_id; // null = main session

      switch (event.type) {
        case "message_start":
          if (agentId) {
            store.initAgentStreaming(sessionId, agentId);
          } else {
            store.setStreamingStarted(sessionId, Date.now());
            store.setStreaming(sessionId, "");
          }
          store.setSessionStatus(sessionId, "running");
          break;

        case "content_block_delta": {
          const delta = (event as { delta?: { type: string; text?: string } }).delta;
          if (delta?.type === "text_delta" && delta.text) {
            bufferStreamingDelta(sessionId, agentId, delta.text);
          }
          break;
        }

        case "message_delta": {
          const usage = (event as { usage?: { output_tokens?: number } }).usage;
          if (usage?.output_tokens) {
            if (agentId) {
              store.setAgentStreamingOutputTokens(sessionId, agentId, usage.output_tokens);
            } else {
              store.setStreamingOutputTokens(sessionId, usage.output_tokens);
            }
          }
          break;
        }
      }
      break;
    }

    case "message_history":
      if (pendingDeltas.has(sessionId)) flushDeltas();
      store.setMessages(sessionId, msg.messages);
      store.clearStreaming(sessionId);
      break;

    case "capabilities_ready":
      store.setCapabilities(sessionId, {
        commands: msg.commands,
        models: msg.models,
        skills: msg.skills ?? [],
      });
      break;

    case "session_init": {
      store.setSessionState(sessionId, {
        // Spread first to preserve optional fields (git_branch, tools, etc.)
        ...msg.session,
        // Override required fields with safe defaults
        session_id: msg.session.session_id ?? sessionId,
        model: msg.session.model ?? "",
        cwd: msg.session.cwd ?? "",
        total_cost_usd: msg.session.total_cost_usd ?? 0,
        num_turns: msg.session.num_turns ?? 0,
        context_used_percent: msg.session.context_used_percent ?? 0,
        is_compacting: msg.session.is_compacting ?? false,
      });
      // Populate capabilities from init data as fallback (capabilities_ready may never arrive
      // if the CLI doesn't respond to the initialize control request)
      const session = msg.session as Record<string, unknown>;
      const cmds = Array.isArray(session.slash_commands)
        ? (session.slash_commands as string[])
        : [];
      const initSkills = Array.isArray(session.skills) ? (session.skills as string[]) : [];
      if (
        !store.sessionData[sessionId]?.capabilities &&
        (cmds.length > 0 || initSkills.length > 0)
      ) {
        store.setCapabilities(sessionId, {
          commands: cmds.map((name) => ({ name, description: "" })),
          models: [],
          skills: initSkills,
        });
      }
      break;
    }

    case "session_update": {
      const prev = store.sessionData[sessionId]?.state;
      if (prev) {
        // Auto-open task panel when team first appears
        if (!prev.team && msg.session.team && !store.taskPanelOpen) {
          store.setTaskPanelOpen(true);
        }
        store.setSessionState(sessionId, { ...prev, ...msg.session });
      } else {
        // Accept update even without prior session_init
        store.setSessionState(sessionId, msg.session as ConsumerSessionState);
      }
      break;
    }

    case "status_change":
      store.setSessionStatus(sessionId, msg.status);
      break;

    case "permission_request":
      store.addPermission(sessionId, msg.request);
      break;

    case "permission_cancelled":
      store.removePermission(sessionId, msg.request_id);
      break;

    case "cli_connected":
      store.setCliConnected(sessionId, true);
      break;

    case "cli_disconnected":
      store.setCliConnected(sessionId, false);
      break;

    case "tool_progress":
      store.setToolProgress(sessionId, msg.tool_use_id, msg.tool_name, msg.elapsed_time_seconds);
      break;

    case "session_name_update":
      store.updateSession(sessionId, { name: msg.name });
      break;

    case "identity":
      store.setIdentity(sessionId, {
        userId: msg.userId,
        displayName: msg.displayName,
        role: msg.role,
      });
      break;

    case "presence_update":
      store.setPresence(sessionId, msg.consumers);
      break;

    case "auth_status":
      store.setAuthStatus(sessionId, {
        isAuthenticating: msg.isAuthenticating,
        output: msg.output,
        error: msg.error,
      });
      break;

    case "resume_failed":
      store.addToast("Could not resume previous session — starting fresh", "error");
      break;

    case "process_output":
      store.appendProcessLog(sessionId, stripAnsi(msg.data));
      break;
  }
}

export function connectToSession(sessionId: string): void {
  // Idempotent: return early if an OPEN or CONNECTING socket already exists
  const existing = connections.get(sessionId);
  if (
    existing &&
    (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  // Clear any pending reconnect timer for this session (preserve attempt count for backoff)
  const rs = reconnectState.get(sessionId);
  if (rs?.timer) {
    clearTimeout(rs.timer);
    reconnectState.set(sessionId, { timer: null, attempt: rs.attempt });
  }

  // Close stale socket for this session if any
  if (existing) {
    existing.onclose = null;
    existing.close();
    connections.delete(sessionId);
  }

  const store = useStore.getState();
  store.ensureSessionData(sessionId);
  store.setConnectionStatus(sessionId, "connecting");

  const url = buildWsUrl(sessionId);
  const socket = new WebSocket(url);
  connections.set(sessionId, socket);

  socket.onopen = () => {
    reconnectState.set(sessionId, { timer: null, attempt: 0 });
    store.setConnectionStatus(sessionId, "connected");
    store.setReconnectAttempt(sessionId, 0);
  };

  socket.onmessage = (event) => {
    if (typeof event.data === "string") {
      handleMessage(sessionId, event.data);
    }
  };

  socket.onclose = () => {
    store.setConnectionStatus(sessionId, "disconnected");
    store.clearStreaming(sessionId);
    store.setSessionStatus(sessionId, "idle");
    // Clear ephemeral per-connection state to avoid stale data on reconnect
    store.setIdentity(sessionId, null);
    store.setPresence(sessionId, []);
    store.clearPendingPermissions(sessionId);
    store.setAuthStatus(sessionId, null);
    connections.delete(sessionId);
    scheduleReconnect(sessionId);
  };

  socket.onerror = () => {
    // onclose will fire after onerror
  };
}

function scheduleReconnect(sessionId: string): void {
  const rs = reconnectState.get(sessionId) ?? { timer: null, attempt: 0 };
  if (rs.timer) clearTimeout(rs.timer);
  const delay = Math.min(1000 * 2 ** rs.attempt, MAX_RECONNECT_DELAY);
  const nextAttempt = rs.attempt + 1;
  useStore.getState().setReconnectAttempt(sessionId, nextAttempt);
  const timer = setTimeout(() => {
    // Only reconnect if no connection currently exists for this session
    if (!connections.has(sessionId)) {
      connectToSession(sessionId);
    }
  }, delay);
  reconnectState.set(sessionId, { timer, attempt: nextAttempt });
}

export function disconnectSession(sessionId: string): void {
  const rs = reconnectState.get(sessionId);
  if (rs?.timer) clearTimeout(rs.timer);
  reconnectState.delete(sessionId);

  const socket = connections.get(sessionId);
  if (socket) {
    socket.onclose = null;
    socket.close();
    connections.delete(sessionId);
  }
  useStore.getState().setConnectionStatus(sessionId, "disconnected");
}

export function disconnect(): void {
  for (const [sessionId, socket] of connections) {
    socket.onclose = null;
    socket.close();
    useStore.getState().setConnectionStatus(sessionId, "disconnected");
  }
  connections.clear();

  for (const rs of reconnectState.values()) {
    if (rs.timer) clearTimeout(rs.timer);
  }
  reconnectState.clear();
}

export function send(message: InboundMessage, sessionId?: string): void {
  const targetId = sessionId ?? useStore.getState().currentSessionId;
  if (!targetId) return;
  const socket = connections.get(targetId);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

/** @deprecated Use `useStore.getState().currentSessionId` instead. */
export function getActiveSessionId(): string | null {
  return useStore.getState().currentSessionId;
}

/** Reset internal state -- test-only. */
export function _resetForTesting(): void {
  disconnect();
  pendingDeltas.clear();
  flushScheduled = false;
}
