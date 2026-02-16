import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useStore } from "../store";

export interface SlashMenuHandle {
  handleKeyDown: (e: KeyboardEvent | React.KeyboardEvent) => boolean;
}

interface SlashMenuProps {
  sessionId: string;
  query: string;
  onSelect: (command: string) => void;
  onClose: () => void;
}

interface CommandItem {
  name: string;
  description: string;
  category?: string;
}

interface CommandCategory {
  label: string;
  commands: CommandItem[];
}

const CATEGORY_MAP: Record<string, string> = {
  add: "File Operations",
  drop: "File Operations",
  clear: "File Operations",
  architect: "AI Modes",
  plan: "AI Modes",
  model: "Session",
  compact: "Session",
  reset: "Session",
  test: "Analysis",
  lint: "Analysis",
  diff: "Analysis",
};

function categorize(commands: CommandItem[]): CommandCategory[] {
  const categories = new Map<string, CommandItem[]>();

  for (const cmd of commands) {
    const cat = cmd.category ?? CATEGORY_MAP[cmd.name] ?? "Other";
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)?.push(cmd);
  }

  return Array.from(categories.entries()).map(([label, cmds]) => ({
    label,
    commands: cmds,
  }));
}

export const SlashMenu = forwardRef<SlashMenuHandle, SlashMenuProps>(function SlashMenu(
  { sessionId, query, onSelect, onClose },
  ref,
) {
  const capabilities = useStore((s) => s.sessionData[sessionId]?.capabilities);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const allCommands = useMemo(() => {
    const cmds = capabilities?.commands ?? [];
    const skills = (capabilities?.skills ?? []).map((s) => ({
      name: s,
      description: `Run ${s} skill`,
      category: "Skills",
    }));
    return [...cmds, ...skills];
  }, [capabilities]);

  const filtered = useMemo(() => {
    if (!query) return allCommands;
    const q = query.toLowerCase();
    return allCommands.filter(
      (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    );
  }, [allCommands, query]);

  const categories = useMemo(() => categorize(filtered), [filtered]);

  const flatList = useMemo(() => categories.flatMap((c) => c.commands), [categories]);

  // Reset active index when query changes
  const prevQueryRef = useRef(query);
  if (prevQueryRef.current !== query) {
    prevQueryRef.current = query;
    setActiveIndex(0);
  }

  // Expose keyboard handler to parent (Composer) — returns true if event was consumed
  const handleKeyDown = useCallback(
    (e: KeyboardEvent | React.KeyboardEvent): boolean => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, flatList.length - 1));
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        if (flatList[activeIndex]) {
          onSelect(flatList[activeIndex].name);
        }
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return true;
      }
      return false;
    },
    [flatList, activeIndex, onSelect, onClose],
  );

  useImperativeHandle(ref, () => ({ handleKeyDown }), [handleKeyDown]);

  if (flatList.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-3 right-3 mb-1 max-h-60 overflow-y-auto rounded-lg border border-bc-border bg-bc-surface shadow-lg"
      role="listbox"
      aria-label="Slash commands"
    >
      {categories.map((cat) => (
        <div key={cat.label}>
          <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-bc-text-muted">
            {cat.label}
          </div>
          {cat.commands.map((cmd) => {
            const idx = flatList.indexOf(cmd);
            return (
              <button
                type="button"
                key={cmd.name}
                onClick={() => onSelect(cmd.name)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                  idx === activeIndex ? "bg-bc-active" : "hover:bg-bc-hover"
                }`}
                role="option"
                aria-selected={idx === activeIndex}
                id={`slash-option-${cmd.name}`}
              >
                <span className="font-mono-code text-bc-accent">/{cmd.name}</span>
                <span className="truncate text-xs text-bc-text-muted">{cmd.description}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
});
