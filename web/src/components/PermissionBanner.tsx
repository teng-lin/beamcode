import { type ReactNode, useCallback } from "react";
import { useStore } from "../store";
import { send } from "../ws";

interface PermissionBannerProps {
  sessionId: string;
}

function toolPreview(name: string, input: Record<string, unknown>): ReactNode {
  switch (name) {
    case "Bash":
      return (
        <pre className="mt-1 rounded bg-bc-code-bg px-2 py-1 font-mono-code text-xs text-bc-text-muted">
          $ {String(input.command ?? "")}
        </pre>
      );
    case "Edit":
      return (
        <div className="mt-1 rounded bg-bc-code-bg p-2 font-mono-code text-xs">
          <div className="text-bc-text-muted">{String(input.file_path ?? "")}</div>
          {"old_string" in input && (
            <div className="mt-1 text-bc-error">- {String(input.old_string).slice(0, 200)}</div>
          )}
          {"new_string" in input && (
            <div className="text-bc-success">+ {String(input.new_string).slice(0, 200)}</div>
          )}
        </div>
      );
    case "Write":
      return (
        <div className="mt-1 text-xs text-bc-text-muted">
          <span className="font-mono-code">{String(input.file_path ?? "")}</span>
          {"content" in input && (
            <pre className="mt-1 max-h-20 overflow-hidden rounded bg-bc-code-bg p-1 font-mono-code">
              {String(input.content).slice(0, 300)}
            </pre>
          )}
        </div>
      );
    case "Read":
    case "Glob":
    case "Grep":
      return (
        <div className="mt-1 font-mono-code text-xs text-bc-text-muted">
          {"pattern" in input && <span>{String(input.pattern)}</span>}
          {"file_path" in input && <span> {String(input.file_path)}</span>}
          {"path" in input && <span> in {String(input.path)}</span>}
        </div>
      );
    default:
      return (
        <pre className="mt-1 max-h-20 overflow-hidden rounded bg-bc-code-bg p-1 font-mono-code text-xs text-bc-text-muted">
          {JSON.stringify(input, null, 2).slice(0, 300)}
        </pre>
      );
  }
}

export function PermissionBanner({ sessionId }: PermissionBannerProps) {
  const permissions = useStore((s) => s.sessionData[sessionId]?.pendingPermissions ?? {});

  const handleResponse = useCallback(
    (requestId: string, behavior: "allow" | "deny") => {
      send({ type: "permission_response", request_id: requestId, behavior });
      useStore.getState().removePermission(sessionId, requestId);
    },
    [sessionId],
  );

  const permList = Object.values(permissions);
  if (permList.length === 0) return null;

  return (
    <div
      className="max-h-[60vh] overflow-y-auto border-t border-bc-warning/30 bg-bc-surface max-md:max-h-[40vh]"
      role="alert"
      aria-label="Permission requests"
    >
      {permList.map((perm) => (
        <div key={perm.request_id} className="border-b border-bc-border px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="rounded bg-bc-warning/20 px-1.5 py-0.5 font-mono-code text-xs text-bc-warning">
              {perm.tool_name}
            </span>
            {perm.description && (
              <span className="text-xs text-bc-text-muted">{perm.description}</span>
            )}
          </div>

          {toolPreview(perm.tool_name, perm.input)}

          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => handleResponse(perm.request_id, "allow")}
              className="rounded bg-bc-success/20 px-3 py-1 text-xs font-medium text-bc-success hover:bg-bc-success/30"
              aria-label={`Approve ${perm.tool_name}: ${perm.description ?? ""}`}
            >
              Allow
            </button>
            <button
              type="button"
              onClick={() => handleResponse(perm.request_id, "deny")}
              className="rounded bg-bc-error/20 px-3 py-1 text-xs font-medium text-bc-error hover:bg-bc-error/30"
              aria-label={`Deny ${perm.tool_name}: ${perm.description ?? ""}`}
            >
              Deny
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
