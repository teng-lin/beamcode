import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffView } from "./DiffView";

describe("DiffView", () => {
  it("renders a pre element when both strings are empty", () => {
    const { container } = render(<DiffView oldString="" newString="" />);
    expect(container.querySelector("pre")).toBeInTheDocument();
  });

  it("renders removed lines with - prefix", () => {
    render(<DiffView oldString="const a = 1;" newString="" />);
    expect(screen.getByText(/- const a = 1;/)).toBeInTheDocument();
  });

  it("renders added lines with + prefix", () => {
    render(<DiffView oldString="" newString="const b = 2;" />);
    expect(screen.getByText(/\+ const b = 2;/)).toBeInTheDocument();
  });

  it("renders both removed and added lines for a replacement", () => {
    render(<DiffView oldString="const a = 1;" newString="const a = 2;" />);
    expect(screen.getByText(/- const a = 1;/)).toBeInTheDocument();
    expect(screen.getByText(/\+ const a = 2;/)).toBeInTheDocument();
  });

  it("renders multi-line diffs", () => {
    const oldStr = "line1\nline2\nline3";
    const newStr = "line1\nline2-changed\nline3";
    render(<DiffView oldString={oldStr} newString={newStr} />);
    expect(screen.getByText(/- line2/)).toBeInTheDocument();
    expect(screen.getByText(/\+ line2-changed/)).toBeInTheDocument();
  });

  it("renders file path when provided", () => {
    render(<DiffView oldString="a" newString="b" filePath="/src/app.ts" />);
    expect(screen.getByText("/src/app.ts")).toBeInTheDocument();
  });

  it("applies red styling to removed lines", () => {
    const { container } = render(<DiffView oldString="removed" newString="" />);
    const removedLine = container.querySelector("[data-diff='removed']");
    expect(removedLine).toBeInTheDocument();
  });

  it("applies green styling to added lines", () => {
    const { container } = render(<DiffView oldString="" newString="added" />);
    const addedLine = container.querySelector("[data-diff='added']");
    expect(addedLine).toBeInTheDocument();
  });

  it("truncates long diffs beyond maxLines", () => {
    const oldStr = Array.from({ length: 50 }, (_, i) => `old-line-${i}`).join("\n");
    const newStr = Array.from({ length: 50 }, (_, i) => `new-line-${i}`).join("\n");
    render(<DiffView oldString={oldStr} newString={newStr} maxLines={20} />);
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });
});
