import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore, store } from "../test/factories";
import { SlashMenu } from "./SlashMenu";

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
});
