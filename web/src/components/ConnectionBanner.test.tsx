import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionBanner } from "./ConnectionBanner";

vi.mock("../ws", () => ({
  connectToSession: vi.fn(),
}));

vi.mock("../store", async () => {
  const actual = await vi.importActual("../store");
  return actual;
});

import { useStore } from "../store";
import { connectToSession } from "../ws";

describe("ConnectionBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ currentSessionId: "s1" });
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
    useStore.setState({ currentSessionId: "s1" });

    render(<ConnectionBanner />);
    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(connectToSession).toHaveBeenCalledWith("s1");
  });

  it("does not call connectToSession when no active session", async () => {
    const user = userEvent.setup();
    useStore.setState({ currentSessionId: null });

    render(<ConnectionBanner />);
    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(connectToSession).not.toHaveBeenCalled();
  });
});
