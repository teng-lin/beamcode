import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

vi.mock("marked", () => ({
  marked: {
    parse: () => {
      throw new Error("parse failed");
    },
  },
}));

it("MarkdownContent falls back to escaped text when parsing throws", async () => {
  const { MarkdownContent } = await import("./MarkdownContent");
  render(<MarkdownContent content="<b>safe</b>" />);
  expect(screen.getByText("<b>safe</b>")).toBeInTheDocument();
});
