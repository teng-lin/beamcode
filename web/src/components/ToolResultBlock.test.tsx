import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToolResultBlock } from "./ToolResultBlock";

describe("ToolResultBlock", () => {
  it("renders tool name in summary", () => {
    render(<ToolResultBlock toolName="Bash" content="hello world" />);
    expect(screen.getByText("Bash")).toBeInTheDocument();
  });

  it("renders 'Tool result' when toolName is null", () => {
    render(<ToolResultBlock toolName={null} content="output" />);
    expect(screen.getByText("Tool result")).toBeInTheDocument();
  });

  it("shows error indicator when isError is true", () => {
    render(<ToolResultBlock toolName="Bash" content="error output" isError />);
    expect(screen.getByText("(error)")).toBeInTheDocument();
  });

  it("renders Bash content as preformatted text", () => {
    const { container } = render(<ToolResultBlock toolName="Bash" content="$ ls -la" />);
    // Open the details element
    const details = container.querySelector("details");
    details?.setAttribute("open", "");
    expect(screen.getByText("$ ls -la")).toBeInTheDocument();
  });

  it("renders Read content as preformatted text", () => {
    const { container } = render(<ToolResultBlock toolName="Read" content="line 1\nline 2" />);
    const details = container.querySelector("details");
    details?.setAttribute("open", "");
    expect(screen.getByText("line 1\\nline 2")).toBeInTheDocument();
  });

  it("renders unknown tool content as JSON", () => {
    const { container } = render(
      <ToolResultBlock toolName="CustomMcp" content='{"key": "value"}' />,
    );
    const details = container.querySelector("details");
    details?.setAttribute("open", "");
    expect(screen.getByText(/key/)).toBeInTheDocument();
  });

  it("renders content block arrays as JSON", () => {
    const { container } = render(
      <ToolResultBlock
        toolName={null}
        content={[{ type: "text" as const, text: "nested content" }]}
      />,
    );
    const details = container.querySelector("details");
    details?.setAttribute("open", "");
    expect(screen.getByText(/nested content/)).toBeInTheDocument();
  });

  it("shows truncation button for long Bash output", async () => {
    const user = userEvent.setup();
    const longOutput = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    const { container } = render(<ToolResultBlock toolName="Bash" content={longOutput} />);
    const details = container.querySelector("details");
    details?.setAttribute("open", "");

    expect(screen.getByText(/Show all/)).toBeInTheDocument();
    expect(screen.getByText(/60 lines/)).toBeInTheDocument();

    await user.click(screen.getByText(/Show all/));
    expect(screen.queryByText(/Show all/)).not.toBeInTheDocument();
    expect(screen.getByText(/line 60/)).toBeInTheDocument();
  });

  it("does not show truncation for short output", () => {
    const { container } = render(<ToolResultBlock toolName="Bash" content="short" />);
    const details = container.querySelector("details");
    details?.setAttribute("open", "");
    expect(screen.queryByText(/Show all/)).not.toBeInTheDocument();
  });
});
