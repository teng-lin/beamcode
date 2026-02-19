import { useCallback, useEffect, useRef, useState } from "react";
import { createSession } from "../api";
import { useStore } from "../store";
import { updateSessionUrl } from "../utils/session";
import { connectToSession } from "../ws";

export const ADAPTER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  acp: "ACP",
  continue: "Continue",
  gemini: "Gemini",
  opencode: "OpenCode",
};

const ADAPTER_OPTIONS = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "gemini", label: "Gemini" },
  { value: "opencode", label: "OpenCode" },
] as const;

type AdapterValue = (typeof ADAPTER_OPTIONS)[number]["value"];

export function NewSessionDialog() {
  const open = useStore((s) => s.newSessionDialogOpen);
  const setOpen = useStore((s) => s.setNewSessionDialogOpen);
  const updateSession = useStore((s) => s.updateSession);
  const setCurrentSession = useStore((s) => s.setCurrentSession);

  const [adapter, setAdapter] = useState<AdapterValue>("claude");
  const [model, setModel] = useState("");
  const [cwd, setCwd] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const newButtonRef = useRef<HTMLButtonElement | null>(null);
  const firstButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);

  // Reset form on open; restore focus to trigger button on close.
  // The global useKeyboardShortcuts hook handles Escape, so no local listener needed.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      setAdapter("claude");
      setModel("");
      setCwd("");
      setError(null);
      newButtonRef.current = document.querySelector<HTMLButtonElement>(
        "[data-new-session-trigger]",
      );
      setTimeout(() => firstButtonRef.current?.focus(), 0);
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      setTimeout(() => newButtonRef.current?.focus(), 0);
    }
  }, [open]);

  const close = useCallback(() => setOpen(false), [setOpen]);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const session = await createSession({
        adapter,
        model: model.trim() || undefined,
        cwd: cwd.trim() || undefined,
      });
      updateSession(session.sessionId, session);
      setCurrentSession(session.sessionId);
      connectToSession(session.sessionId);
      updateSessionUrl(session.sessionId, "push");
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session");
    } finally {
      setCreating(false);
    }
  }

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        className="fixed inset-0 z-50 cursor-default border-none bg-black/60"
        aria-label="Close dialog"
        onClick={close}
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-bc-border bg-bc-surface shadow-2xl"
      >
        <div className="px-5 py-4">
          <h2 id="new-session-title" className="mb-4 text-sm font-semibold text-bc-text">
            New Session
          </h2>

          <fieldset className="mb-4 border-none p-0">
            <legend className="mb-1.5 text-xs font-medium text-bc-text-muted">Backend</legend>
            <div className="flex flex-wrap gap-1.5">
              {ADAPTER_OPTIONS.map((opt, i) => (
                <button
                  key={opt.value}
                  ref={i === 0 ? firstButtonRef : undefined}
                  type="button"
                  aria-pressed={adapter === opt.value}
                  onClick={() => setAdapter(opt.value)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    adapter === opt.value
                      ? "bg-bc-accent text-bc-bg"
                      : "bg-bc-surface-2 text-bc-text-muted hover:bg-bc-hover hover:text-bc-text"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="mb-4">
            <label
              htmlFor="new-session-model"
              className="mb-1.5 block text-xs font-medium text-bc-text-muted"
            >
              Model <span className="font-normal text-bc-text-muted/60">(optional)</span>
            </label>
            <input
              id="new-session-model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Default"
              maxLength={200}
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-md border border-bc-border bg-bc-bg px-3 py-1.5 text-sm text-bc-text placeholder:text-bc-text-muted/50 focus:border-bc-accent/50 focus:outline-none"
            />
          </div>

          <div className="mb-5">
            <label
              htmlFor="new-session-cwd"
              className="mb-1.5 block text-xs font-medium text-bc-text-muted"
            >
              Working directory{" "}
              <span className="font-normal text-bc-text-muted/60">(optional)</span>
            </label>
            <input
              id="new-session-cwd"
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="Server default"
              maxLength={500}
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-md border border-bc-border bg-bc-bg px-3 py-1.5 text-sm text-bc-text placeholder:text-bc-text-muted/50 focus:border-bc-accent/50 focus:outline-none"
            />
          </div>

          {error && (
            <p
              role="alert"
              className="mb-4 rounded-md bg-bc-error/10 px-3 py-2 text-xs text-bc-error"
            >
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded-md px-3 py-1.5 text-xs text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating}
              className="flex items-center gap-1.5 rounded-md bg-bc-accent px-3 py-1.5 text-xs font-medium text-bc-bg transition-colors hover:bg-bc-accent-hover disabled:opacity-60"
            >
              {creating && (
                <svg
                  className="h-3 w-3 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
              )}
              Create Session
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
