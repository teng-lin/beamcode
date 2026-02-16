import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStore, store } from "../test/factories";
import { ShortcutsModal } from "./ShortcutsModal";

describe("ShortcutsModal", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders nothing when shortcutsModalOpen is false", () => {
    const { container } = render(<ShortcutsModal />);
    expect(container.firstChild).toBeNull();
  });

  it("renders modal when shortcutsModalOpen is true", () => {
    store().setShortcutsModalOpen(true);
    render(<ShortcutsModal />);
    expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
  });

  it("lists key shortcuts", () => {
    store().setShortcutsModalOpen(true);
    render(<ShortcutsModal />);
    expect(screen.getByText("Toggle sidebar")).toBeInTheDocument();
    expect(screen.getByText("Toggle task panel")).toBeInTheDocument();
    expect(screen.getByText("Show shortcuts")).toBeInTheDocument();
  });

  it("closes when clicking the backdrop", async () => {
    const user = userEvent.setup();
    store().setShortcutsModalOpen(true);
    render(<ShortcutsModal />);

    await user.click(screen.getByTestId("shortcuts-backdrop"));

    expect(store().shortcutsModalOpen).toBe(false);
  });
});
