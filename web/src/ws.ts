import type {
  ConsumerMessage,
  ConsumerSessionState,
  InboundMessage,
} from "../../shared/consumer-types";
import { useStore } from "./store";

// ── Module-level state (not a hook) ────────────────────────────────────────

let ws: WebSocket | null = null;
let activeSessionId: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
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
      store.clearStreaming(sessionId);
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
      const { event } = msg;
      switch (event.type) {
        case "message_start":
          store.setStreamingStarted(sessionId, Date.now());
          store.setStreaming(sessionId, "");
          store.setSessionStatus(sessionId, "running");
          break;
        case "content_block_delta": {
          const delta = (event as { delta?: { type: string; text?: string } }).delta;
          if (delta?.type === "text_delta" && delta.text) {
            store.appendStreaming(sessionId, delta.text);
          }
          break;
        }
        case "message_delta": {
          const usage = (event as { usage?: { output_tokens?: number } }).usage;
          if (usage?.output_tokens) {
            store.setStreamingOutputTokens(sessionId, usage.output_tokens);
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
      });
      break;

    case "session_init":
      store.setSessionState(sessionId, {
        session_id: msg.session.session_id ?? sessionId,
        model: msg.session.model ?? "",
        cwd: msg.session.cwd ?? "",
        total_cost_usd: msg.session.total_cost_usd ?? 0,
        num_turns: msg.session.num_turns ?? 0,
        context_used_percent: msg.session.context_used_percent ?? 0,
        is_compacting: msg.session.is_compacting ?? false,
        team: msg.session.team,
      });
      break;

    case "session_update": {
      const prev = store.sessionData[sessionId]?.state;
      if (prev) {
        // Auto-open task panel when team first appears
        if (!prev.team && msg.session.team && !store.taskPanelOpen) {
          store.toggleTaskPanel();
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
  }
}

export function connectToSession(sessionId: string): void {
  // Clear any pending reconnect timer
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Disconnect previous session or stale connection to same session
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }

  reconnectAttempt = 0;
  activeSessionId = sessionId;
  const store = useStore.getState();
  store.ensureSessionData(sessionId);
  store.setConnectionStatus(sessionId, "connecting");

  const url = buildWsUrl(sessionId);
  ws = new WebSocket(url);

  ws.onopen = () => {
    reconnectAttempt = 0;
    store.setConnectionStatus(sessionId, "connected");
    store.setReconnectAttempt(sessionId, 0);
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      handleMessage(sessionId, event.data);
    }
  };

  ws.onclose = () => {
    store.setConnectionStatus(sessionId, "disconnected");
    store.clearStreaming(sessionId);
    store.setSessionStatus(sessionId, "idle");
    ws = null;
    // Only reconnect if this is still the active session
    if (activeSessionId === sessionId) {
      scheduleReconnect(sessionId);
    }
  };

  ws.onerror = () => {
    // onclose will fire after onerror
  };
}

function scheduleReconnect(sessionId: string): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY);
  reconnectAttempt++;
  useStore.getState().setReconnectAttempt(sessionId, reconnectAttempt);
  reconnectTimer = setTimeout(() => {
    if (activeSessionId === sessionId) {
      connectToSession(sessionId);
    }
  }, delay);
}

export function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  if (activeSessionId) {
    useStore.getState().setConnectionStatus(activeSessionId, "disconnected");
  }
  activeSessionId = null;
}

export function send(message: InboundMessage): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

export function getActiveSessionId(): string | null {
  return activeSessionId;
}
