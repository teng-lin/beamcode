import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { Composer } from "./Composer";

vi.mock("../ws", () => ({ send: vi.fn() }));
vi.mock("./SlashMenu", () => ({
  SlashMenu: () => null,
}));

import { send } from "../ws";

const SESSION = "composer-test";
const store = () => useStore.getState();

describe("Composer", () => {
  beforeEach(() => {
    useStore.setState({
      sessionData: {},
      sessions: {},
      currentSessionId: null,
    });
    vi.clearAllMocks();
  });

  it('renders textarea with "Message BeamCode..." placeholder', () => {
    store().ensureSessionData(SESSION);
    render(<Composer sessionId={SESSION} />);
    expect(screen.getByPlaceholderText("Message BeamCode...")).toBeInTheDocument();
  });

  it("renders disabled send button when input is empty", () => {
    store().ensureSessionData(SESSION);
    render(<Composer sessionId={SESSION} />);
    expect(screen.getByLabelText("Send message")).toBeDisabled();
  });

  it("enables send button when text is entered", async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    render(<Composer sessionId={SESSION} />);

    await user.type(screen.getByLabelText("Message input"), "hello");
    expect(screen.getByLabelText("Send message")).toBeEnabled();
  });

  it("sends user_message on Enter key", async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    render(<Composer sessionId={SESSION} />);

    const textarea = screen.getByLabelText("Message input");
    await user.type(textarea, "hello{Enter}");

    expect(send).toHaveBeenCalledWith({
      type: "user_message",
      content: "hello",
    });
  });

  it('sends slash_command when input starts with "/"', async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    render(<Composer sessionId={SESSION} />);

    const textarea = screen.getByLabelText("Message input");
    // Type "/help" then press Enter
    await user.type(textarea, "/help{Enter}");

    expect(send).toHaveBeenCalledWith({
      type: "slash_command",
      command: "/help",
    });
  });

  it("clears input after sending", async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    render(<Composer sessionId={SESSION} />);

    const textarea = screen.getByLabelText("Message input");
    await user.type(textarea, "hello{Enter}");

    expect(textarea).toHaveValue("");
  });

  it("shows interrupt button when session is running", () => {
    store().ensureSessionData(SESSION);
    store().setSessionStatus(SESSION, "running");
    render(<Composer sessionId={SESSION} />);

    expect(screen.getByLabelText("Interrupt")).toBeInTheDocument();
  });

  it("sends interrupt on Enter when running", async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    store().setSessionStatus(SESSION, "running");
    render(<Composer sessionId={SESSION} />);

    const textarea = screen.getByLabelText("Message input");
    await user.type(textarea, "{Enter}");

    expect(send).toHaveBeenCalledWith({ type: "interrupt" });
  });

  it("sends interrupt on Escape when running", async () => {
    const user = userEvent.setup();
    store().ensureSessionData(SESSION);
    store().setSessionStatus(SESSION, "running");
    render(<Composer sessionId={SESSION} />);

    const textarea = screen.getByLabelText("Message input");
    await user.type(textarea, "{Escape}");

    expect(send).toHaveBeenCalledWith({ type: "interrupt" });
  });
});
