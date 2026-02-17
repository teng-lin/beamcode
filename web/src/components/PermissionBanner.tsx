import { type ReactNode, useCallback, useMemo } from "react";
import { useStore } from "../store";
import { send } from "../ws";
import { DiffView } from "./DiffView";

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
        <DiffView
          oldString={String(input.old_string ?? "")}
          newString={String(input.new_string ?? "")}
          filePath={String(input.file_path ?? "")}
        />
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
  const permissions = useStore((s) => s.sessionData[sessionId]?.pendingPermissions);
  const identityRole = useStore((s) => s.sessionData[sessionId]?.identity?.role ?? null);
  const isObserver = identityRole !== null && identityRole !== "participant";

  const handleResponse = useCallback(
    (requestId: string, behavior: "allow" | "deny") => {
      send({ type: "permission_response", request_id: requestId, behavior }, sessionId);
      useStore.getState().removePermission(sessionId, requestId);
    },
    [sessionId],
  );

  const permList = useMemo(() => Object.values(permissions ?? {}), [permissions]);

  const handleAllowAll = useCallback(() => {
    const perms = useStore.getState().sessionData[sessionId]?.pendingPermissions ?? {};
    for (const perm of Object.values(perms)) {
      handleResponse(perm.request_id, "allow");
    }
  }, [sessionId, handleResponse]);

  if (permList.length === 0) return null;

  return (
    <div
      className="max-h-[60vh] overflow-y-auto border-t border-bc-warning/30 bg-bc-surface max-md:max-h-[40vh]"
      role="alert"
      aria-label="Permission requests"
    >
      {permList.length > 1 && !isObserver && (
        <div className="flex items-center justify-between border-b border-bc-border bg-bc-surface-2/50 px-4 py-2">
          <span className="text-xs text-bc-text-muted">{permList.length} pending permissions</span>
          <button
            type="button"
            onClick={handleAllowAll}
            className="rounded-lg bg-bc-success/20 px-4 py-1.5 text-xs font-medium text-bc-success transition-colors hover:bg-bc-success/30"
            aria-label={`Allow all ${permList.length} permissions`}
          >
            Allow All
          </button>
        </div>
      )}
      {permList.map((perm) => (
        <div key={perm.request_id} className="border-b border-bc-border px-4 py-3">
          <div className="flex items-center gap-2">
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              className="flex-shrink-0"
              aria-hidden="true"
            >
              <path
                d="M7 1.5l5 3v5l-5 3-5-3v-5l5-3z"
                stroke="var(--color-bc-warning)"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
              <circle cx="7" cy="6" r="1" fill="var(--color-bc-warning)" />
              <path d="M7 8.5v1" stroke="var(--color-bc-warning)" strokeWidth="1.2" />
            </svg>
            <span className="rounded-md bg-bc-warning/15 px-2 py-0.5 font-mono-code text-xs font-medium text-bc-warning">
              {perm.tool_name}
            </span>
            {perm.description && (
              <span className="text-xs text-bc-text-muted">{perm.description}</span>
            )}
          </div>

          {toolPreview(perm.tool_name, perm.input)}

          {!isObserver && (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => handleResponse(perm.request_id, "allow")}
                className="rounded-lg bg-bc-success/20 px-4 py-1.5 text-xs font-medium text-bc-success transition-colors hover:bg-bc-success/30"
                aria-label={`Approve ${perm.tool_name}: ${perm.description ?? ""}`}
              >
                Allow
              </button>
              <button
                type="button"
                onClick={() => handleResponse(perm.request_id, "deny")}
                className="rounded-lg bg-bc-error/20 px-4 py-1.5 text-xs font-medium text-bc-error transition-colors hover:bg-bc-error/30"
                aria-label={`Deny ${perm.tool_name}: ${perm.description ?? ""}`}
              >
                Deny
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
