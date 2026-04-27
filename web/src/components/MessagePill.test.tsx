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

type PillOverrides = Partial<Parameters<typeof MessagePill>[0]>;

function renderPill(msgOverrides: Partial<FlowMessage> = {}, propOverrides: PillOverrides = {}) {
  return render(
    <MessagePill
      message={makeMessage(msgOverrides)}
      detailLevel="compact"
      dimmed={false}
      onHoverStart={noop}
      onHoverEnd={noop}
      {...propOverrides}
    />,
  );
}

describe("MessagePill", () => {
  it('renders with data-flow-id for direction "out"', () => {
    const { container } = renderPill({ direction: "out" });
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("data-flow-id")).toBe("msg-1");
  });

  it('shows ↙ arrow for direction "in"', () => {
    renderPill({ direction: "in" });
    expect(screen.getByText("↙")).toBeInTheDocument();
  });

  it("shows ↗ arrow for direction out", () => {
    renderPill({ direction: "out" });
    expect(screen.getByText("↗")).toBeInTheDocument();
  });

  it("applies opacity-30 class when dimmed", () => {
    const { container } = renderPill({}, { dimmed: true });
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("opacity-30");
  });

  it("does not apply opacity-30 when not dimmed", () => {
    const { container } = renderPill({}, { dimmed: false });
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toContain("opacity-30");
  });

  it("toggles expand/collapse on click", async () => {
    const user = userEvent.setup();
    renderPill({ payload: { key: "value" } });

    const toggle = screen.getByText("[▾]");
    expect(toggle).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByText("[▴]")).toBeInTheDocument();

    await user.click(screen.getByText("[▴]"));
    expect(screen.getByText("[▾]")).toBeInTheDocument();
  });

  it("calls onHoverStart and onHoverEnd", async () => {
    const user = userEvent.setup();
    const onHoverStart = vi.fn();
    const onHoverEnd = vi.fn();
    const { container } = renderPill({}, { onHoverStart, onHoverEnd });
    const root = container.firstElementChild as HTMLElement;

    await user.hover(root);
    expect(onHoverStart).toHaveBeenCalled();

    await user.unhover(root);
    expect(onHoverEnd).toHaveBeenCalled();
  });

  it("displays timestamp formatted as +{n}ms", () => {
    renderPill({ timestamp: 5678 });
    expect(screen.getByText("+5678ms")).toBeInTheDocument();
  });
});
