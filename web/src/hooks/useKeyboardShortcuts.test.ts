import { renderHook } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { resetStore, store } from "../test/factories";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

vi.mock("../ws", () => ({
  connectToSession: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
}));

vi.mock("../api", () => ({
  createSession: vi.fn(),
}));

describe("useKeyboardShortcuts", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("toggles sidebar on Cmd+B", async () => {
    const user = userEvent.setup();
    renderHook(() => useKeyboardShortcuts());

    store().toggleSidebar(); // ensure it's open first (resetStore sets sidebarOpen: false)
    expect(store().sidebarOpen).toBe(true);

    await user.keyboard("{Meta>}b{/Meta}");

    expect(store().sidebarOpen).toBe(false);
  });

  it("toggles task panel on Cmd+.", async () => {
    const user = userEvent.setup();
    renderHook(() => useKeyboardShortcuts());

    expect(store().taskPanelOpen).toBe(false);

    await user.keyboard("{Meta>}.{/Meta}");

    expect(store().taskPanelOpen).toBe(true);
  });

  it("toggles quick switcher on Cmd+K", async () => {
    const user = userEvent.setup();
    renderHook(() => useKeyboardShortcuts());

    expect(store().quickSwitcherOpen).toBe(false);

    await user.keyboard("{Meta>}k{/Meta}");

    expect(store().quickSwitcherOpen).toBe(true);

    await user.keyboard("{Meta>}k{/Meta}");

    expect(store().quickSwitcherOpen).toBe(false);
  });

  it("opens shortcuts modal on ?", async () => {
    const user = userEvent.setup();
    renderHook(() => useKeyboardShortcuts());

    expect(store().shortcutsModalOpen).toBeFalsy();

    await user.keyboard("?");

    expect(store().shortcutsModalOpen).toBe(true);
  });

  it("does not trigger ? shortcut when typing in an input/textarea", () => {
    renderHook(() => useKeyboardShortcuts());

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);

    // Mock activeElement to simulate textarea focus (jsdom focus is unreliable)
    const originalDescriptor =
      Object.getOwnPropertyDescriptor(document, "activeElement") ??
      Object.getOwnPropertyDescriptor(Document.prototype, "activeElement");
    Object.defineProperty(document, "activeElement", {
      get: () => textarea,
      configurable: true,
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));

    expect(useStore.getState().shortcutsModalOpen).toBe(false);

    // Restore
    if (originalDescriptor) {
      Object.defineProperty(document, "activeElement", originalDescriptor);
    }
    document.body.removeChild(textarea);
  });

  it("closes quick switcher on Escape before other modals", async () => {
    const user = userEvent.setup();
    renderHook(() => useKeyboardShortcuts());

    // Open both quick switcher and shortcuts modal
    store().setQuickSwitcherOpen(true);
    store().setShortcutsModalOpen(true);

    await user.keyboard("{Escape}");

    // Quick switcher should close first
    expect(store().quickSwitcherOpen).toBe(false);
    // Shortcuts modal should still be open
    expect(store().shortcutsModalOpen).toBe(true);

    await user.keyboard("{Escape}");

    expect(store().shortcutsModalOpen).toBe(false);
  });

  it("closes shortcuts modal on Escape", async () => {
    const user = userEvent.setup();
    renderHook(() => useKeyboardShortcuts());

    // Open it first
    store().setShortcutsModalOpen(true);
    expect(store().shortcutsModalOpen).toBe(true);

    await user.keyboard("{Escape}");

    expect(store().shortcutsModalOpen).toBe(false);
  });
});
