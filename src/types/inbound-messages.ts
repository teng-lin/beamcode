import type { PermissionUpdate } from "./cli-messages.js";

/** Messages consumers send to the bridge (browser, agent, etc.) */
export type InboundMessage =
  | {
      type: "user_message";
      content: string;
      session_id?: string;
      images?: { media_type: string; data: string }[];
    }
  | {
      type: "permission_response";
      request_id: string;
      behavior: "allow" | "deny";
      updated_input?: Record<string, unknown>;
      updated_permissions?: PermissionUpdate[];
      message?: string;
    }
  | { type: "interrupt" }
  | { type: "set_model"; model: string }
  | { type: "set_permission_mode"; mode: string }
  | { type: "presence_query" }
  | { type: "slash_command"; command: string; request_id?: string };
