import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { makeToolUseBlock, resetStore } from "../test/factories";
import { ToolGroupBlock } from "./ToolGroupBlock";

const SESSION = "group-test";

describe("ToolGroupBlock", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders nothing when blocks is empty", () => {
    const { container } = render(<ToolGroupBlock blocks={[]} sessionId={SESSION} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders tool name from first block", () => {
    render(<ToolGroupBlock blocks={[makeToolUseBlock({ name: "Read" })]} sessionId={SESSION} />);
    expect(screen.getByText("Read")).toBeInTheDocument();
  });

  it("renders count badge", () => {
    const blocks = [
      makeToolUseBlock({ id: "t1", name: "Bash" }),
      makeToolUseBlock({ id: "t2", name: "Read" }),
      makeToolUseBlock({ id: "t3", name: "Grep" }),
    ];
    render(<ToolGroupBlock blocks={blocks} sessionId={SESSION} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("does not show individual tools by default", () => {
    const blocks = [
      makeToolUseBlock({ id: "t1", name: "Bash", input: { command: "echo hi" } }),
      makeToolUseBlock({ id: "t2", name: "Read", input: { file_path: "/tmp/x.ts" } }),
    ];
    render(<ToolGroupBlock blocks={blocks} sessionId={SESSION} />);
    expect(screen.queryByText("echo hi")).not.toBeInTheDocument();
    expect(screen.queryByText("/tmp/x.ts")).not.toBeInTheDocument();
  });

  it("shows individual tools after clicking expand", async () => {
    const user = userEvent.setup();
    const blocks = [
      makeToolUseBlock({ id: "t1", name: "Bash", input: { command: "echo hi" } }),
      makeToolUseBlock({ id: "t2", name: "Read", input: { file_path: "/tmp/x.ts" } }),
    ];
    render(<ToolGroupBlock blocks={blocks} sessionId={SESSION} />);

    await user.click(screen.getByRole("button"));

    expect(screen.getByText("echo hi")).toBeInTheDocument();
    expect(screen.getByText("/tmp/x.ts")).toBeInTheDocument();
  });
});
