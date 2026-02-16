import type { ConsumerPermissionRequest } from "../../../shared/consumer-types";
import type { SdkSessionInfo } from "../store";

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
