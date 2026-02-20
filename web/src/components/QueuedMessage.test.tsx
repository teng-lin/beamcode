import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QueuedMessage } from "./QueuedMessage";

describe("QueuedMessage", () => {
  const defaults = {
    content: "Fix the bug",
    displayName: "Alice",
    isEditing: false,
    isOwn: true,
  };

  it("renders the message content", () => {
    render(<QueuedMessage {...defaults} />);
    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
  });

  it("renders the display name", () => {
    render(<QueuedMessage {...defaults} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("shows 'is editing...' when isEditing is true", () => {
    render(<QueuedMessage {...defaults} isEditing />);
    expect(screen.getByText("Alice is editing...")).toBeInTheDocument();
  });

  it("shows 'press up to edit' hint when isOwn", () => {
    render(<QueuedMessage {...defaults} isOwn />);
    expect(screen.getByText("Queued \u2014 press \u2191 to edit")).toBeInTheDocument();
  });

  it("shows 'will send when current task completes' hint when not own", () => {
    render(<QueuedMessage {...defaults} isOwn={false} />);
    expect(
      screen.getByText("Queued \u2014 will send when current task completes"),
    ).toBeInTheDocument();
  });

  it("applies opacity-50 class for queued appearance", () => {
    render(<QueuedMessage {...defaults} />);
    const wrapper = screen.getByText(defaults.content).parentElement?.parentElement;
    expect(wrapper).toBeInTheDocument();
    expect(wrapper).toHaveClass("opacity-50");
  });
});
