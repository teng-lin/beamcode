import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type FlowMessage, MessagePill } from "./MessagePill";

function makeMessage(overrides: Partial<FlowMessage> = {}): FlowMessage {
  return {
    id: "msg-1",
    direction: "out",
    type: "assistant",
    payload: { text: "hello" },
    timestamp: 1234,
    wallTime: Date.now(),
    ...overrides,
  };
}

const noop = () => {};

describe("MessagePill", () => {
  it('renders with data-flow-id for direction "out"', () => {
    const msg = makeMessage({ direction: "out" });
    const { container } = render(
      <MessagePill
        message={msg}
        detailLevel="compact"
        dimmed={false}
        onHoverStart={noop}
        onHoverEnd={noop}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("data-flow-id")).toBe("msg-1");
  });

  it('shows ↙ arrow for direction "in"', () => {
    const msg = makeMessage({ direction: "in" });
    render(
      <MessagePill
        message={msg}
        detailLevel="compact"
        dimmed={false}
        onHoverStart={noop}
        onHoverEnd={noop}
      />,
    );
    expect(screen.getByText("↙")).toBeInTheDocument();
  });

  it("shows ↗ arrow for direction out", () => {
    const msg = makeMessage({ direction: "out" });
    render(
      <MessagePill
        message={msg}
        detailLevel="compact"
        dimmed={false}
        onHoverStart={noop}
        onHoverEnd={noop}
      />,
    );
    expect(screen.getByText("↗")).toBeInTheDocument();
  });

  it("applies opacity-30 class when dimmed", () => {
    const msg = makeMessage();
    const { container } = render(
      <MessagePill
        message={msg}
        detailLevel="compact"
        dimmed={true}
        onHoverStart={noop}
        onHoverEnd={noop}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("opacity-30");
  });

  it("does not apply opacity-30 when not dimmed", () => {
    const msg = makeMessage();
    const { container } = render(
      <MessagePill
        message={msg}
        detailLevel="compact"
        dimmed={false}
        onHoverStart={noop}
        onHoverEnd={noop}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toContain("opacity-30");
  });

  it("toggles expand/collapse on click", async () => {
    const user = userEvent.setup();
    const msg = makeMessage({ payload: { key: "value" } });
    render(
      <MessagePill
        message={msg}
        detailLevel="compact"
        dimmed={false}
        onHoverStart={noop}
        onHoverEnd={noop}
      />,
    );

    // Initially collapsed — toggle button shows [▾]
    const toggle = screen.getByText("[▾]");
    expect(toggle).toBeInTheDocument();

    await user.click(toggle);
    // Now expanded — toggle shows [▴]
    expect(screen.getByText("[▴]")).toBeInTheDocument();

    await user.click(screen.getByText("[▴]"));
    expect(screen.getByText("[▾]")).toBeInTheDocument();
  });

  it("calls onHoverStart and onHoverEnd", async () => {
    const user = userEvent.setup();
    const onHoverStart = vi.fn();
    const onHoverEnd = vi.fn();
    const msg = makeMessage();
    const { container } = render(
      <MessagePill
        message={msg}
        detailLevel="compact"
        dimmed={false}
        onHoverStart={onHoverStart}
        onHoverEnd={onHoverEnd}
      />,
    );
    const root = container.firstElementChild as HTMLElement;

    await user.hover(root);
    expect(onHoverStart).toHaveBeenCalled();

    await user.unhover(root);
    expect(onHoverEnd).toHaveBeenCalled();
  });

  it("displays timestamp formatted as +{n}ms", () => {
    const msg = makeMessage({ timestamp: 5678 });
    render(
      <MessagePill
        message={msg}
        detailLevel="compact"
        dimmed={false}
        onHoverStart={noop}
        onHoverEnd={noop}
      />,
    );
    expect(screen.getByText("+5678ms")).toBeInTheDocument();
  });
});
