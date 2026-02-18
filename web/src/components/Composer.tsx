import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { send } from "../ws";
import { SlashMenu, type SlashMenuHandle } from "./SlashMenu";
import { ModelPicker, PermissionModePicker, StatusBar } from "./StatusBar";

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

type ImagePayload = { images: { media_type: string; data: string }[] };

function SendIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 12V4M8 4L4 8M8 4l4 4" />
    </svg>
  );
}

/** Strip preview data from attached images, keeping only the fields the server needs. */
function imagePayload(imgs: AttachedImage[]): ImagePayload | undefined {
  if (imgs.length === 0) return undefined;
  return { images: imgs.map(({ media_type, data }) => ({ media_type, data })) };
}

function composerPlaceholder(
  isObserver: boolean,
  isRunning: boolean,
  hasQueuedMessage: boolean,
  isOwnQueue: boolean,
  isEditingQueue: boolean,
  queuedByName?: string,
): string {
  if (isObserver) return "Observer mode \u2014 read-only";
  if (isEditingQueue) return "Editing queued message...";
  if (hasQueuedMessage && isOwnQueue) return "Message queued \u2014 press \u2191 to edit";
  if (hasQueuedMessage) return `${queuedByName ?? "Someone"} has a message queued`;
  if (isRunning) return "Type a message to queue, or Esc to interrupt...";
  return "Message BeamCode...";
}

export function Composer({ sessionId }: ComposerProps) {
  const [value, setValue] = useState("");
  const [showSlash, setShowSlash] = useState(false);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashMenuRef = useRef<SlashMenuHandle>(null);
  const sessionStatus = useStore((s) => s.sessionData[sessionId]?.sessionStatus);
  const capabilities = useStore((s) => s.sessionData[sessionId]?.capabilities);
  const identityRole = useStore((s) => s.sessionData[sessionId]?.identity?.role ?? null);
  const queuedMessage = useStore((s) => s.sessionData[sessionId]?.queuedMessage ?? null);
  const isEditingQueue = useStore((s) => s.sessionData[sessionId]?.isEditingQueue ?? false);
  const ownUserId = useStore((s) => s.sessionData[sessionId]?.identity?.userId ?? null);
  const setEditingQueue = useStore((s) => s.setEditingQueue);
  const isRunning = sessionStatus === "running";
  // Deny-by-default: if identity arrived and role is not participant, it's read-only
  const isObserver = identityRole !== null && identityRole !== "participant";
  const hasQueuedMessage = queuedMessage !== null;
  const isOwnQueue = hasQueuedMessage && queuedMessage.consumerId === ownUserId;

  // O(1) lookup map for argument hints, keyed by normalized command name (with leading slash)
  const hintMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const cmd of capabilities?.commands ?? []) {
      if (!cmd.argumentHint) continue;
      const name = cmd.name.startsWith("/") ? cmd.name : `/${cmd.name}`;
      map.set(name, cmd.argumentHint);
    }
    return map;
  }, [capabilities]);

  const argumentHint = useMemo(() => {
    // Show hint only when value is exactly "/command " (trailing space, no args yet)
    const match = value.match(/^(\/\S+)\s$/);
    if (!match) return null;
    return hintMap.get(match[1]) ?? null;
  }, [value, hintMap]);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
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
    const availableSlots = Math.max(0, MAX_IMAGES - imagesRef.current.length);
    const allImages = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const { addToast } = useStore.getState();

    const withinSizeLimit = allImages.filter((f) => {
      if (f.size > MAX_IMAGE_SIZE) {
        addToast(`Image too large (${(f.size / 1024 / 1024).toFixed(1)}MB) — max 10MB`, "error");
        return false;
      }
      return true;
    });
    const eligible = withinSizeLimit.slice(0, availableSlots);

    if (withinSizeLimit.length > availableSlots) {
      addToast(`Maximum ${MAX_IMAGES} images allowed`, "error");
    }

    if (eligible.length === 0) return;

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

    // Editing mode: update or cancel
    if (isEditingQueue) {
      if (trimmed) {
        send(
          { type: "update_queued_message", content: trimmed, ...imagePayload(images) },
          sessionId,
        );
      } else {
        send({ type: "cancel_queued_message" }, sessionId);
      }
      setEditingQueue(sessionId, false);
      setValue("");
      setImages([]);
      setShowSlash(false);
      return;
    }

    if (!trimmed && images.length === 0) return;

    if (trimmed.startsWith("/")) {
      send({ type: "slash_command", command: trimmed }, sessionId);
    } else if (isRunning && !hasQueuedMessage) {
      send({ type: "queue_message", content: trimmed, ...imagePayload(images) }, sessionId);
    } else {
      send({ type: "user_message", content: trimmed, ...imagePayload(images) }, sessionId);
      // Optimistically mark running — the CLI will process this message, but
      // message_start won't arrive until the API starts streaming (1-5s gap).
      // Without this, the next Enter would send user_message instead of
      // queue_message during that gap.
      useStore.getState().setSessionStatus(sessionId, "running");
    }
    setValue("");
    setImages([]);
    setShowSlash(false);
  }, [value, images, sessionId, isRunning, hasQueuedMessage, isEditingQueue, setEditingQueue]);

  const handleInterrupt = useCallback(() => {
    send({ type: "interrupt" }, sessionId);
  }, [sessionId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (showSlash && slashMenuRef.current?.handleKeyDown(e)) {
        return;
      }

      // Up arrow to edit own queued message
      if (e.key === "ArrowUp" && isOwnQueue && !isEditingQueue && !value) {
        e.preventDefault();
        setValue(queuedMessage?.content ?? "");
        if (queuedMessage?.images && queuedMessage.images.length > 0) {
          setImages(
            queuedMessage.images.map((img) => ({
              id: crypto.randomUUID(),
              media_type: img.media_type,
              data: img.data,
              preview: `data:${img.media_type};base64,${img.data}`,
            })),
          );
        }
        setEditingQueue(sessionId, true);
        return;
      }

      // Escape while editing queue: cancel editing (return to queued state)
      if (e.key === "Escape" && isEditingQueue) {
        e.preventDefault();
        setValue("");
        setEditingQueue(sessionId, false);
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        // Interrupt when running and there is nothing new to send
        if (!isEditingQueue && isRunning && (hasQueuedMessage || !value.trim())) {
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
    [
      showSlash,
      isRunning,
      isOwnQueue,
      isEditingQueue,
      hasQueuedMessage,
      value,
      queuedMessage,
      handleSubmit,
      handleInterrupt,
      sessionId,
      setEditingQueue,
    ],
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setValue(v);
    setShowSlash(v.startsWith("/") && !v.includes(" "));
  }, []);

  const handleSlashSelect = useCallback((command: string) => {
    const normalized = command.startsWith("/") ? command : `/${command}`;
    setValue(`${normalized} `);
    setShowSlash(false);
    textareaRef.current?.focus();
  }, []);

  const showInterrupt = isRunning && hasQueuedMessage && !isEditingQueue;

  return (
    <section
      aria-label="Message composer"
      className="px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-drop zone on container */}
      <div
        className="relative mx-auto max-w-3xl rounded-xl border border-bc-border bg-bc-surface transition-colors focus-within:border-bc-accent/50 focus-within:shadow-[0_0_0_1px_rgba(232,160,64,0.15)]"
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

        {/* Image previews */}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
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

        {/* Textarea */}
        <div className={`relative${isOwnQueue && !isEditingQueue ? " opacity-50" : ""}`}>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={composerPlaceholder(
              isObserver,
              isRunning,
              hasQueuedMessage,
              isOwnQueue,
              isEditingQueue,
              queuedMessage?.displayName,
            )}
            rows={3}
            disabled={isObserver || (hasQueuedMessage && !isOwnQueue && !isEditingQueue)}
            readOnly={isOwnQueue && !isEditingQueue}
            className={`min-h-[80px] w-full resize-none bg-transparent px-4 py-3 text-sm text-bc-text placeholder:text-bc-text-muted/60 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50${isOwnQueue && !isEditingQueue ? " cursor-default" : ""}`}
            aria-label="Message input"
          />
          {argumentHint && (
            <div
              data-testid="argument-hint"
              className="pointer-events-none absolute inset-0 overflow-hidden px-4 py-2.5 text-sm"
            >
              <span className="invisible">{value}</span>
              <span className="text-bc-text-muted/40">{argumentHint}</span>
            </div>
          )}
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1 px-3 pb-2 pt-1">
          {/* Attach image button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isObserver || images.length >= MAX_IMAGES}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-bc-text-muted transition-colors hover:bg-bc-hover hover:text-bc-text disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Attach image"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            aria-label="Upload images"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) processFiles(e.target.files);
              e.target.value = "";
            }}
          />

          {/* Permission mode picker */}
          <PermissionModePicker disabled={isObserver} />

          <div className="flex-1" />

          {/* Model picker */}
          <ModelPicker disabled={isObserver} />

          {/* Submit / Interrupt button */}
          <button
            type="button"
            onClick={showInterrupt ? handleInterrupt : handleSubmit}
            disabled={
              isObserver ||
              (!showInterrupt && !isEditingQueue && !value.trim() && images.length === 0)
            }
            className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition-all ${
              showInterrupt
                ? "bg-bc-error text-white shadow-sm hover:bg-bc-error/80"
                : "bg-bc-accent text-bc-bg shadow-sm hover:bg-bc-accent-hover disabled:bg-bc-surface-2 disabled:text-bc-text-muted/30 disabled:shadow-none"
            }`}
            aria-label={showInterrupt ? "Interrupt" : "Send message"}
          >
            {showInterrupt ? (
              <svg
                width="12"
                height="12"
                viewBox="0 0 14 14"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect width="14" height="14" rx="2" />
              </svg>
            ) : (
              <SendIcon />
            )}
          </button>
        </div>

        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-bc-accent bg-bc-accent/10">
            <span className="text-sm text-bc-accent">Drop image here</span>
          </div>
        )}
      </div>
      <StatusBar />
    </section>
  );
}
