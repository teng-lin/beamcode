import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { send } from "../ws";
import { SlashMenu, type SlashMenuHandle } from "./SlashMenu";

interface ComposerProps {
  sessionId: string;
}

export function Composer({ sessionId }: ComposerProps) {
  const [value, setValue] = useState("");
  const [showSlash, setShowSlash] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashMenuRef = useRef<SlashMenuHandle>(null);
  const sessionStatus = useStore((s) => s.sessionData[sessionId]?.sessionStatus);
  const isRunning = sessionStatus === "running";

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: value triggers resize recalculation
  useEffect(() => {
    autoResize();
  }, [value, autoResize]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset state when session changes
  useEffect(() => {
    setValue("");
    setShowSlash(false);
    textareaRef.current?.focus();
  }, [sessionId]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("/")) {
      send({ type: "slash_command", command: trimmed });
    } else {
      send({ type: "user_message", content: trimmed });
    }
    setValue("");
    setShowSlash(false);
  }, [value]);

  const handleInterrupt = useCallback(() => {
    send({ type: "interrupt" });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Delegate to SlashMenu first if it's open
      if (showSlash && slashMenuRef.current?.handleKeyDown(e)) {
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isRunning) {
          handleInterrupt();
        } else {
          handleSubmit();
        }
      }
      if (e.key === "Escape" && isRunning) {
        e.preventDefault();
        handleInterrupt();
      }
    },
    [showSlash, isRunning, handleSubmit, handleInterrupt],
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setValue(v);
    setShowSlash(v.startsWith("/") && !v.includes(" "));
  }, []);

  const handleSlashSelect = useCallback((command: string) => {
    setValue(`/${command} `);
    setShowSlash(false);
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="relative border-t border-bc-border bg-bc-surface p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {showSlash && (
        <SlashMenu
          ref={slashMenuRef}
          sessionId={sessionId}
          query={value.slice(1)}
          onSelect={handleSlashSelect}
          onClose={() => setShowSlash(false)}
        />
      )}

      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={isRunning ? "Press Enter or Esc to interrupt..." : "Message BeamCode..."}
          rows={1}
          className="min-h-[40px] flex-1 resize-none rounded-lg border border-bc-border bg-bc-bg px-3 py-2.5 text-sm text-bc-text placeholder:text-bc-text-muted focus:border-bc-accent focus:outline-none"
          aria-label="Message input"
        />
        <button
          type="button"
          onClick={isRunning ? handleInterrupt : handleSubmit}
          disabled={!isRunning && !value.trim()}
          className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg transition-colors ${
            isRunning
              ? "bg-bc-error text-white hover:bg-bc-error/80"
              : "bg-bc-accent text-bc-bg hover:bg-bc-accent-hover disabled:opacity-30"
          }`}
          aria-label={isRunning ? "Interrupt" : "Send message"}
        >
          {isRunning ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
              <rect width="14" height="14" rx="2" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M2 14l12-6L2 2v5l8 1-8 1z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
