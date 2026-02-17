import type {
  ConsumerMessage,
  ConsumerSessionState,
  InboundMessage,
} from "../../shared/consumer-types";
import { useStore } from "./store";

// ── Module-level state (not a hook) ────────────────────────────────────────

const connections = new Map<string, WebSocket>();
const reconnectState = new Map<
  string,
  { timer: ReturnType<typeof setTimeout> | null; attempt: number }
>();
const MAX_RECONNECT_DELAY = 30_000;

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
  let msg: ConsumerMessage;
  try {
    msg = JSON.parse(data) as ConsumerMessage;
  } catch {
    return;
  }

  store.ensureSessionData(sessionId);

  switch (msg.type) {
    case "assistant":
      if (msg.parent_tool_use_id) {
        store.clearAgentStreaming(sessionId, msg.parent_tool_use_id);
      } else {
        store.clearStreaming(sessionId);
      }
      store.addMessage(sessionId, msg);
      break;

    case "result":
      store.setSessionStatus(sessionId, "idle");
      store.addMessage(sessionId, msg);
      break;

    case "user_message":
    case "error":
    case "slash_command_result":
    case "slash_command_error":
      store.addMessage(sessionId, msg);
      break;

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
            if (agentId) {
              store.appendAgentStreaming(sessionId, agentId, delta.text);
            } else {
              store.appendStreaming(sessionId, delta.text);
            }
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

    case "session_init":
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
      break;

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
}
