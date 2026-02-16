import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { send } from "../ws";
import { SlashMenu, type SlashMenuHandle } from "./SlashMenu";

interface ComposerProps {
  sessionId: string;
}

interface AttachedImage {
  id: string;
  media_type: string;
  data: string;
  preview: string;
}

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_IMAGES = 10;

export function Composer({ sessionId }: ComposerProps) {
  const [value, setValue] = useState("");
  const [showSlash, setShowSlash] = useState(false);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);
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
    setImages([]);
    setIsDragging(false);
    textareaRef.current?.focus();
  }, [sessionId]);

  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  const processFiles = useCallback((files: FileList) => {
    const availableSlots = MAX_IMAGES - imagesRef.current.length;
    if (availableSlots <= 0) return;

    const eligible = Array.from(files)
      .filter((f) => f.type.startsWith("image/") && f.size <= MAX_IMAGE_SIZE)
      .slice(0, availableSlots);

    for (const file of eligible) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(",")[1];
        if (!base64) return;
        setImages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), media_type: file.type, data: base64, preview: dataUrl },
        ]);
      };
      reader.onerror = () => {
        console.error("Failed to read image file:", file.name);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        processFiles(e.dataTransfer.files);
      }
    },
    [processFiles],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (e.clipboardData.files.length > 0) {
        e.preventDefault();
        processFiles(e.clipboardData.files);
      }
    },
    [processFiles],
  );

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;

    if (trimmed.startsWith("/")) {
      send({ type: "slash_command", command: trimmed });
    } else {
      send({
        type: "user_message",
        content: trimmed,
        ...(images.length > 0 && {
          images: images.map(({ media_type, data }) => ({ media_type, data })),
        }),
      });
    }
    setValue("");
    setImages([]);
    setShowSlash(false);
  }, [value, images]);

  const handleInterrupt = useCallback(() => {
    send({ type: "interrupt" });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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
    <section
      aria-label="Message composer"
      className="relative border-t border-bc-border bg-bc-surface px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showSlash && (
        <SlashMenu
          ref={slashMenuRef}
          sessionId={sessionId}
          query={value.slice(1)}
          onSelect={handleSlashSelect}
          onClose={() => setShowSlash(false)}
        />
      )}

      <div className="mx-auto max-w-3xl">
        {/* Image previews */}
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div
                key={img.id}
                className="group relative h-16 w-16 overflow-hidden rounded-lg border border-bc-border"
              >
                <img
                  src={img.preview}
                  alt={`Attached ${i + 1}`}
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-bc-error text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={`Remove image ${i + 1}`}
                >
                  x
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={isRunning ? "Press Enter or Esc to interrupt..." : "Message BeamCode..."}
              rows={1}
              className="min-h-[42px] w-full resize-none rounded-xl border border-bc-border bg-bc-bg px-4 py-2.5 pr-3 text-sm text-bc-text placeholder:text-bc-text-muted/60 transition-colors focus:border-bc-accent/50 focus:shadow-[0_0_0_1px_rgba(232,160,64,0.15)] focus:outline-none"
              aria-label="Message input"
            />
          </div>
          <button
            type="button"
            onClick={isRunning ? handleInterrupt : handleSubmit}
            disabled={!isRunning && !value.trim() && images.length === 0}
            className={`flex h-[42px] w-[42px] flex-shrink-0 items-center justify-center rounded-xl transition-all ${
              isRunning
                ? "bg-bc-error text-white shadow-sm hover:bg-bc-error/80"
                : "bg-bc-accent text-bc-bg shadow-sm hover:bg-bc-accent-hover disabled:bg-bc-surface-2 disabled:text-bc-text-muted/30 disabled:shadow-none"
            }`}
            aria-label={isRunning ? "Interrupt" : "Send message"}
          >
            {isRunning ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect width="14" height="14" rx="2" />
              </svg>
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M3 13l10-5L3 3v4l6 1-6 1z" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-bc-accent bg-bc-accent/10">
          <span className="text-sm text-bc-accent">Drop image here</span>
        </div>
      )}
    </section>
  );
}
