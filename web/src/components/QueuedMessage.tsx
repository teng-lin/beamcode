interface QueuedMessageProps {
  content: string;
  displayName: string;
  isEditing: boolean;
  isOwn: boolean;
}

export function QueuedMessage({ content, displayName, isEditing, isOwn }: QueuedMessageProps) {
  return (
    <div className="self-end max-w-[85%] opacity-50 transition-opacity duration-300">
      <div className="rounded-2xl bg-bc-user-bg px-4 py-2.5 text-sm border border-dashed border-bc-border/50">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-bc-accent opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-bc-accent" />
          </span>
          <span className="text-xs text-bc-text-muted">
            {isEditing ? `${displayName} is editing...` : displayName}
          </span>
        </div>
        <div className="mt-1">{content}</div>
      </div>
      <div className="mt-1 text-[11px] text-bc-text-muted/60 px-1">
        {isOwn
          ? "Queued \u2014 press \u2191 to edit"
          : "Queued \u2014 will send when current task completes"}
      </div>
    </div>
  );
}
