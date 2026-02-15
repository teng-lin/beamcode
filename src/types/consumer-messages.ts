import type { ConsumerRole } from "./auth.js";
import type {
  CLIAssistantMessage,
  CLIResultMessage,
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
  PermissionRequest,
} from "./cli-messages.js";
import type { SessionState } from "./session-state.js";

/** Messages the bridge sends to consumers (browser, agent, etc.) */
export type ConsumerMessage =
  | { type: "session_init"; session: SessionState }
  | { type: "session_update"; session: Partial<SessionState> }
  | {
      type: "assistant";
      message: CLIAssistantMessage["message"];
      parent_tool_use_id: string | null;
    }
  | {
      type: "stream_event";
      event: unknown;
      parent_tool_use_id: string | null;
    }
  | { type: "result"; data: CLIResultMessage }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_cancelled"; request_id: string }
  | {
      type: "tool_progress";
      tool_use_id: string;
      tool_name: string;
      elapsed_time_seconds: number;
    }
  | { type: "tool_use_summary"; summary: string; tool_use_ids: string[] }
  | {
      type: "status_change";
      status: "compacting" | "idle" | "running" | null;
    }
  | {
      type: "auth_status";
      isAuthenticating: boolean;
      output: string[];
      error?: string;
    }
  | { type: "error"; message: string }
  | { type: "cli_disconnected" }
  | { type: "cli_connected" }
  | { type: "user_message"; content: string; timestamp: number }
  | { type: "message_history"; messages: ConsumerMessage[] }
  | { type: "session_name_update"; name: string }
  | { type: "identity"; userId: string; displayName: string; role: ConsumerRole }
  | {
      type: "presence_update";
      consumers: Array<{ userId: string; displayName: string; role: ConsumerRole }>;
    }
  | {
      type: "slash_command_result";
      command: string;
      request_id?: string;
      content: string;
      source: "emulated" | "pty";
    }
  | {
      type: "slash_command_error";
      command: string;
      request_id?: string;
      error: string;
    }
  | {
      type: "capabilities_ready";
      commands: InitializeCommand[];
      models: InitializeModel[];
      account: InitializeAccount | null;
    };
