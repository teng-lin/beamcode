import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders heading text", () => {
    render(<EmptyState />);
    expect(screen.getByText("BeamCode")).toBeInTheDocument();
  });

  it("renders instruction text", () => {
    render(<EmptyState />);
    expect(screen.getByText("Send a message to start coding")).toBeInTheDocument();
  });

  it("renders slash command hint with kbd", () => {
    render(<EmptyState />);
    const kbd = screen.getByText("/");
    expect(kbd.tagName).toBe("KBD");
  });
});
