import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import { resetStore } from "../test/factories";
import { LogDrawer } from "./LogDrawer";

const SESSION = "log-drawer-test";

// jsdom does not implement scrollIntoView
Element.prototype.scrollIntoView = () => {};

describe("LogDrawer", () => {
  beforeEach(() => {
    resetStore({ logDrawerOpen: false, processLogs: {} });
  });

  it("renders nothing when logDrawerOpen is false", () => {
    useStore.setState({
      logDrawerOpen: false,
      currentSessionId: SESSION,
      processLogs: { [SESSION]: ["line1"] },
    });
    const { container } = render(<LogDrawer />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when no session is active", () => {
    useStore.setState({
      logDrawerOpen: true,
      currentSessionId: null,
      processLogs: {},
    });
    const { container } = render(<LogDrawer />);
    expect(container.innerHTML).toBe("");
  });

  it('renders header "Process Logs" when open', () => {
    useStore.setState({
      logDrawerOpen: true,
      currentSessionId: SESSION,
      processLogs: { [SESSION]: [] },
    });
    render(<LogDrawer />);
    expect(screen.getByText("Process Logs")).toBeInTheDocument();
  });

  it("renders log entries", () => {
    useStore.setState({
      logDrawerOpen: true,
      currentSessionId: SESSION,
      processLogs: { [SESSION]: ["first line", "second line"] },
    });
    render(<LogDrawer />);
    expect(screen.getByText(/first line/)).toBeInTheDocument();
    expect(screen.getByText(/second line/)).toBeInTheDocument();
  });

  it('shows "No process logs yet" when logs array is empty', () => {
    useStore.setState({
      logDrawerOpen: true,
      currentSessionId: SESSION,
      processLogs: { [SESSION]: [] },
    });
    render(<LogDrawer />);
    expect(screen.getByText("No process logs yet")).toBeInTheDocument();
  });

  it("closes on Escape key press", async () => {
    const user = userEvent.setup();
    useStore.setState({
      logDrawerOpen: true,
      currentSessionId: SESSION,
      processLogs: { [SESSION]: ["log entry"] },
    });
    render(<LogDrawer />);
    expect(screen.getByText("Process Logs")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(useStore.getState().logDrawerOpen).toBe(false);
  });

  it("closes on close button click", async () => {
    const user = userEvent.setup();
    useStore.setState({
      logDrawerOpen: true,
      currentSessionId: SESSION,
      processLogs: { [SESSION]: ["log entry"] },
    });
    render(<LogDrawer />);

    await user.click(screen.getByLabelText("Close logs"));
    expect(useStore.getState().logDrawerOpen).toBe(false);
  });
});
