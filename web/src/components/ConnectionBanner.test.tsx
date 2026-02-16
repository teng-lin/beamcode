import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionBanner } from "./ConnectionBanner";

vi.mock("../ws", () => ({
  connectToSession: vi.fn(),
  getActiveSessionId: vi.fn(() => "s1"),
}));

import { connectToSession, getActiveSessionId } from "../ws";

describe("ConnectionBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders an alert with disconnection message", () => {
    render(<ConnectionBanner />);
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent("CLI disconnected — waiting for reconnection");
  });

  it("shows reconnection attempt count when provided", () => {
    render(<ConnectionBanner reconnectAttempt={3} />);
    expect(screen.getByText("(attempt 3)")).toBeInTheDocument();
  });

  it("does not show attempt count when reconnectAttempt is 0", () => {
    render(<ConnectionBanner reconnectAttempt={0} />);
    expect(screen.queryByText(/attempt/)).not.toBeInTheDocument();
  });

  it("does not show attempt count when reconnectAttempt is undefined", () => {
    render(<ConnectionBanner />);
    expect(screen.queryByText(/attempt/)).not.toBeInTheDocument();
  });

  it("renders a retry button", () => {
    render(<ConnectionBanner />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("calls connectToSession when retry is clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(getActiveSessionId).mockReturnValue("s1");

    render(<ConnectionBanner />);
    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(connectToSession).toHaveBeenCalledWith("s1");
  });

  it("does not call connectToSession when no active session", async () => {
    const user = userEvent.setup();
    vi.mocked(getActiveSessionId).mockReturnValue(null);

    render(<ConnectionBanner />);
    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(connectToSession).not.toHaveBeenCalled();
  });
});
