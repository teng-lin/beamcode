import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ThinkingBlock } from "./ThinkingBlock";

describe("ThinkingBlock", () => {
  it("renders 'Thinking...' label", () => {
    render(<ThinkingBlock content="some thought" />);
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("does not show content by default", () => {
    render(<ThinkingBlock content="hidden thought" />);
    expect(screen.queryByText("hidden thought")).not.toBeInTheDocument();
  });

  it("shows content after clicking the button", async () => {
    const user = userEvent.setup();
    render(<ThinkingBlock content="revealed thought" />);

    await user.click(screen.getByRole("button"));

    expect(screen.getByText("revealed thought")).toBeInTheDocument();
  });

  it("hides content after clicking again (toggle)", async () => {
    const user = userEvent.setup();
    render(<ThinkingBlock content="toggled thought" />);

    const button = screen.getByRole("button");
    await user.click(button);
    expect(screen.getByText("toggled thought")).toBeInTheDocument();

    await user.click(button);
    expect(screen.queryByText("toggled thought")).not.toBeInTheDocument();
  });
});
