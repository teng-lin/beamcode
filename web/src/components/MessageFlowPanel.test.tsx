import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";

// Mock useMessageFlow to avoid pulling in ws.ts
vi.mock("../hooks/useMessageFlow", () => ({
  useMessageFlow: () => ({
    messages: [],
    paused: false,
    pendingCount: 0,
    setPaused: vi.fn(),
    clear: vi.fn(),
  }),
}));

// Lazy import after mock is registered
const { MessageFlowPanel } = await import("./MessageFlowPanel");

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

describe("MessageFlowPanel", () => {
  beforeEach(() => {
    useStore.setState({
      messageFlowOpen: false,
      currentSessionId: "test-session",
    });
  });

  afterEach(cleanup);

  it("returns null when messageFlowOpen is false", () => {
    const { container } = render(<MessageFlowPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("renders when messageFlowOpen is true", () => {
    useStore.setState({ messageFlowOpen: true });
    render(<MessageFlowPanel />);
    expect(screen.getByText("MESSAGE FLOW")).toBeTruthy();
  });

  it("returns null when currentSessionId is null", () => {
    useStore.setState({ messageFlowOpen: true, currentSessionId: null });
    const { container } = render(<MessageFlowPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("closes on Escape key", () => {
    useStore.setState({ messageFlowOpen: true });
    render(<MessageFlowPanel />);
    expect(screen.getByText("MESSAGE FLOW")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(useStore.getState().messageFlowOpen).toBe(false);
  });

  it("close button sets messageFlowOpen to false", () => {
    useStore.setState({ messageFlowOpen: true });
    render(<MessageFlowPanel />);
    const closeBtn = screen.getByLabelText("Close message flow");
    fireEvent.click(closeBtn);
    expect(useStore.getState().messageFlowOpen).toBe(false);
  });
});
