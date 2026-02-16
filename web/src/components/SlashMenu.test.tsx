import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore, store } from "../test/factories";
import { SlashMenu, type SlashMenuHandle } from "./SlashMenu";

const SESSION = "slash-test";

const onSelect = vi.fn();
const onClose = vi.fn();

function setupCommands(commands: Array<{ name: string; description: string }>): void {
  store().ensureSessionData(SESSION);
  store().setCapabilities(SESSION, { commands, models: [] });
}

function renderMenu(query = ""): ReturnType<typeof render> {
  return render(
    <SlashMenu sessionId={SESSION} query={query} onSelect={onSelect} onClose={onClose} />,
  );
}

function renderMenuWithRef(
  query = "",
): { ref: React.RefObject<SlashMenuHandle | null> } & ReturnType<typeof render> {
  const ref = React.createRef<SlashMenuHandle>();
  const result = render(
    <SlashMenu ref={ref} sessionId={SESSION} query={query} onSelect={onSelect} onClose={onClose} />,
  );
  return { ref, ...result };
}

function syntheticKeyEvent(key: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
}

describe("SlashMenu", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("renders nothing when no commands match", () => {
    setupCommands([{ name: "help", description: "Show help" }]);
    const { container } = renderMenu("zzz");
    expect(container.firstChild).toBeNull();
  });

  it("renders commands from capabilities", () => {
    setupCommands([
      { name: "help", description: "Show help" },
      { name: "model", description: "Change model" },
    ]);
    renderMenu();

    expect(screen.getByText("/help")).toBeInTheDocument();
    expect(screen.getByText("/model")).toBeInTheDocument();
  });

  it("filters commands by query", () => {
    setupCommands([
      { name: "help", description: "Show help" },
      { name: "model", description: "Change model" },
    ]);
    renderMenu("hel");

    expect(screen.getByText("/help")).toBeInTheDocument();
    expect(screen.queryByText("/model")).not.toBeInTheDocument();
  });

  it("shows category labels", () => {
    setupCommands([
      { name: "model", description: "Change model" },
      { name: "compact", description: "Compact context" },
      { name: "add", description: "Add file" },
    ]);
    renderMenu();

    expect(screen.getByText("Session")).toBeInTheDocument();
    expect(screen.getByText("File Operations")).toBeInTheDocument();
  });

  it("calls onSelect when clicking a command", async () => {
    const user = userEvent.setup();
    setupCommands([{ name: "help", description: "Show help" }]);
    renderMenu();

    await user.click(screen.getByRole("option"));
    expect(onSelect).toHaveBeenCalledWith("help");
  });

  it("renders nothing when capabilities are null", () => {
    store().ensureSessionData(SESSION);
    const { container } = renderMenu();
    expect(container.firstChild).toBeNull();
  });

  // ── Keyboard navigation via handleKeyDown ──────────────────────────────

  describe("keyboard navigation", () => {
    it("ArrowDown moves active index forward", () => {
      setupCommands([
        { name: "help", description: "Show help" },
        { name: "model", description: "Change model" },
        { name: "add", description: "Add file" },
      ]);
      const { ref } = renderMenuWithRef();

      // Initially first item is active
      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");

      // Press ArrowDown — wrap in act to flush state
      let consumed: boolean;
      act(() => {
        consumed = ref.current!.handleKeyDown(syntheticKeyEvent("ArrowDown"));
      });
      expect(consumed!).toBe(true);

      // Second option should now be active, first deselected
      const updatedOptions = screen.getAllByRole("option");
      expect(updatedOptions[0]).toHaveAttribute("aria-selected", "false");
      expect(updatedOptions[1]).toHaveAttribute("aria-selected", "true");
    });

    it("ArrowDown does not exceed list bounds", () => {
      setupCommands([{ name: "help", description: "Show help" }]);
      const { ref } = renderMenuWithRef();

      // Press ArrowDown when already at last (only) item
      act(() => {
        ref.current!.handleKeyDown(syntheticKeyEvent("ArrowDown"));
      });

      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");
    });

    it("ArrowUp moves active index backward", () => {
      setupCommands([
        { name: "help", description: "Show help" },
        { name: "model", description: "Change model" },
      ]);
      const { ref } = renderMenuWithRef();

      // Move down first
      act(() => {
        ref.current!.handleKeyDown(syntheticKeyEvent("ArrowDown"));
      });
      expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

      // Move back up
      let consumed: boolean;
      act(() => {
        consumed = ref.current!.handleKeyDown(syntheticKeyEvent("ArrowUp"));
      });
      expect(consumed!).toBe(true);
      expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    });

    it("ArrowUp does not go below 0", () => {
      setupCommands([{ name: "help", description: "Show help" }]);
      const { ref } = renderMenuWithRef();

      // Press ArrowUp when already at 0
      act(() => {
        ref.current!.handleKeyDown(syntheticKeyEvent("ArrowUp"));
      });

      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");
    });

    it("Enter selects the active command", () => {
      setupCommands([
        { name: "help", description: "Show help" },
        { name: "model", description: "Change model" },
      ]);
      const { ref } = renderMenuWithRef();

      // Move to second item and press Enter
      act(() => {
        ref.current!.handleKeyDown(syntheticKeyEvent("ArrowDown"));
      });
      let consumed: boolean;
      act(() => {
        consumed = ref.current!.handleKeyDown(syntheticKeyEvent("Enter"));
      });

      expect(consumed!).toBe(true);
      expect(onSelect).toHaveBeenCalledWith("model");
    });

    it("Tab selects the active command", () => {
      setupCommands([{ name: "help", description: "Show help" }]);
      const { ref } = renderMenuWithRef();

      let consumed: boolean;
      act(() => {
        consumed = ref.current!.handleKeyDown(syntheticKeyEvent("Tab"));
      });
      expect(consumed!).toBe(true);
      expect(onSelect).toHaveBeenCalledWith("help");
    });

    it("Escape calls onClose", () => {
      setupCommands([{ name: "help", description: "Show help" }]);
      const { ref } = renderMenuWithRef();

      let consumed: boolean;
      act(() => {
        consumed = ref.current!.handleKeyDown(syntheticKeyEvent("Escape"));
      });
      expect(consumed!).toBe(true);
      expect(onClose).toHaveBeenCalled();
    });

    it("returns false for unhandled keys", () => {
      setupCommands([{ name: "help", description: "Show help" }]);
      const { ref } = renderMenuWithRef();

      let consumed: boolean;
      act(() => {
        consumed = ref.current!.handleKeyDown(syntheticKeyEvent("a"));
      });
      expect(consumed!).toBe(false);
    });
  });

  // ── Active index reset on query change ─────────────────────────────────

  describe("active index reset on query change", () => {
    it("resets active index to 0 when query changes", () => {
      setupCommands([
        { name: "help", description: "Show help" },
        { name: "model", description: "Change model" },
        { name: "add", description: "Add file" },
      ]);
      const { ref, rerender } = renderMenuWithRef();

      // Move down to second item
      act(() => {
        ref.current!.handleKeyDown(syntheticKeyEvent("ArrowDown"));
      });
      expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

      // Re-render with a different query
      const newRef = React.createRef<SlashMenuHandle>();
      rerender(
        <SlashMenu
          ref={newRef}
          sessionId={SESSION}
          query="he"
          onSelect={onSelect}
          onClose={onClose}
        />,
      );

      // Active index should reset to 0
      const options = screen.getAllByRole("option");
      expect(options[0]).toHaveAttribute("aria-selected", "true");
    });
  });

  // ── categorize: "Other" category ───────────────────────────────────────

  describe("categorize with Other category", () => {
    it('groups unknown commands into "Other" category', () => {
      setupCommands([
        { name: "model", description: "Change model" },
        { name: "help", description: "Show help" },
        { name: "unknown-cmd", description: "Some unknown command" },
      ]);
      renderMenu();

      expect(screen.getByText("Session")).toBeInTheDocument();
      expect(screen.getByText("Other")).toBeInTheDocument();
      expect(screen.getByText("/help")).toBeInTheDocument();
      expect(screen.getByText("/unknown-cmd")).toBeInTheDocument();
    });
  });
});
