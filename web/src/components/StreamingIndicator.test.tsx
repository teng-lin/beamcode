import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkA11y } from "../test/a11y";
import { resetStore, store } from "../test/factories";
import { StreamingIndicator } from "./StreamingIndicator";

vi.mock("../ws", () => ({ send: vi.fn() }));

const { send } = (await import("../ws")) as unknown as { send: ReturnType<typeof vi.fn> };

const SESSION = "stream-test";

describe("StreamingIndicator", () => {
  beforeEach(() => {
    resetStore();
    send.mockClear();
  });

  it("renders nothing when no streaming data", () => {
    store().ensureSessionData(SESSION);
    const { container } = render(<StreamingIndicator sessionId={SESSION} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when session doesn't exist", () => {
    const { container } = render(<StreamingIndicator sessionId="nonexistent" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders "Generating..." when streaming active', () => {
    store().ensureSessionData(SESSION);
    store().setStreamingStarted(SESSION, Date.now());
    render(<StreamingIndicator sessionId={SESSION} />);
    expect(screen.getByText("Generating...")).toBeInTheDocument();
  });

  it("renders streaming markdown content", () => {
    store().ensureSessionData(SESSION);
    store().setStreaming(SESSION, "**hello world**");
    store().setStreamingStarted(SESSION, Date.now());
    render(<StreamingIndicator sessionId={SESSION} />);
    const bold = screen.getByText("hello world");
    expect(bold.tagName).toBe("STRONG");
  });

  it("displays token count when available", () => {
    store().ensureSessionData(SESSION);
    store().setStreamingStarted(SESSION, Date.now());
    store().setStreamingOutputTokens(SESSION, 2500);
    render(<StreamingIndicator sessionId={SESSION} />);
    expect(screen.getByText(/2\.5k tokens/)).toBeInTheDocument();
  });

  describe("stop button", () => {
    function setupStreaming(status: "idle" | "running" | "compacting" | null = "running") {
      store().ensureSessionData(SESSION);
      store().setStreamingStarted(SESSION, Date.now());
      store().setSessionStatus(SESSION, status);
    }

    it("shows stop button when streaming and sessionStatus is running", () => {
      setupStreaming("running");
      render(<StreamingIndicator sessionId={SESSION} />);
      expect(screen.getByRole("button", { name: "Stop generation" })).toBeInTheDocument();
    });

    it("hides stop button when sessionStatus is idle", () => {
      setupStreaming("idle");
      render(<StreamingIndicator sessionId={SESSION} />);
      expect(screen.queryByRole("button", { name: "Stop generation" })).not.toBeInTheDocument();
    });

    it("sends interrupt message on click", async () => {
      setupStreaming("running");
      render(<StreamingIndicator sessionId={SESSION} />);
      await userEvent.click(screen.getByRole("button", { name: "Stop generation" }));
      expect(send).toHaveBeenCalledWith({ type: "interrupt" }, SESSION);
    });

    it('shows "Stopping..." label after click', async () => {
      setupStreaming("running");
      render(<StreamingIndicator sessionId={SESSION} />);
      await userEvent.click(screen.getByRole("button", { name: "Stop generation" }));
      expect(screen.getByText("Stopping...")).toBeInTheDocument();
      expect(screen.queryByText("Generating...")).not.toBeInTheDocument();
    });

    it("shows Esc keyboard hint", () => {
      setupStreaming("running");
      render(<StreamingIndicator sessionId={SESSION} />);
      expect(screen.getByText("Esc")).toBeInTheDocument();
    });

    it("passes axe a11y checks with stop button visible", async () => {
      setupStreaming("running");
      const { container } = render(<StreamingIndicator sessionId={SESSION} />);
      await checkA11y(container);
    });
  });
});
