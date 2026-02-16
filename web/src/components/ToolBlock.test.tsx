import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStore, store } from "../test/factories";
import { ToolBlock } from "./ToolBlock";

const SESSION = "tool-test";

describe("ToolBlock", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders tool name", () => {
    render(<ToolBlock id="t1" name="Bash" input={{ command: "ls" }} sessionId={SESSION} />);
    expect(screen.getByText("Bash")).toBeInTheDocument();
  });

  it("shows command preview for Bash tool", () => {
    render(<ToolBlock id="t1" name="Bash" input={{ command: "echo hello" }} sessionId={SESSION} />);
    expect(screen.getByText("echo hello")).toBeInTheDocument();
  });

  it("shows file_path preview for Read tool", () => {
    render(
      <ToolBlock id="t1" name="Read" input={{ file_path: "/tmp/test.ts" }} sessionId={SESSION} />,
    );
    expect(screen.getByText("/tmp/test.ts")).toBeInTheDocument();
  });

  it("shows pattern preview for Grep tool", () => {
    render(<ToolBlock id="t1" name="Grep" input={{ pattern: "TODO" }} sessionId={SESSION} />);
    expect(screen.getByText("TODO")).toBeInTheDocument();
  });

  it("shows tool name as fallback preview for unknown tools", () => {
    render(<ToolBlock id="t1" name="WebSearch" input={{ query: "test" }} sessionId={SESSION} />);
    const nameElements = screen.getAllByText("WebSearch");
    expect(nameElements).toHaveLength(2);
  });

  it("does not show input JSON by default", () => {
    render(<ToolBlock id="t1" name="Bash" input={{ command: "ls" }} sessionId={SESSION} />);
    expect(screen.queryByText(/"command": "ls"/)).not.toBeInTheDocument();
  });

  it("shows input JSON after clicking", async () => {
    const user = userEvent.setup();
    render(<ToolBlock id="t1" name="Bash" input={{ command: "ls" }} sessionId={SESSION} />);

    await user.click(screen.getByRole("button"));

    expect(screen.getByText(/"command": "ls"/)).toBeInTheDocument();
  });

  it("displays elapsed time when tool progress exists", () => {
    store().ensureSessionData(SESSION);
    store().setToolProgress(SESSION, "tool-1", "Bash", 5.2);

    render(
      <ToolBlock id="tool-1" name="Bash" input={{ command: "sleep 5" }} sessionId={SESSION} />,
    );
    expect(screen.getByText("5s")).toBeInTheDocument();
  });
});
