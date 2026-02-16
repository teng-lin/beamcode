import { useEffect } from "react";
import { useStore } from "../store";

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || (el as HTMLElement).isContentEditable;
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      const state = useStore.getState();

      // Cmd/Ctrl+B: toggle sidebar
      if (meta && e.key === "b") {
        e.preventDefault();
        state.toggleSidebar();
        return;
      }

      // Cmd/Ctrl+.: toggle task panel
      if (meta && e.key === ".") {
        e.preventDefault();
        state.toggleTaskPanel();
        return;
      }

      // Escape: close agent pane first, then shortcuts modal
      if (e.key === "Escape") {
        if (state.inspectedAgentId) {
          e.preventDefault();
          state.setInspectedAgent(null);
          return;
        }
        if (state.shortcutsModalOpen) {
          e.preventDefault();
          state.setShortcutsModalOpen(false);
          return;
        }
      }

      // ?: open shortcuts modal (only when not typing in input)
      if (e.key === "?" && !meta && !e.altKey && !isInputFocused()) {
        e.preventDefault();
        state.setShortcutsModalOpen(true);
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
