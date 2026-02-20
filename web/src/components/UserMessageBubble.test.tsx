import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UserMessageBubble } from "./UserMessageBubble";

describe("UserMessageBubble", () => {
  it("renders message content", () => {
    render(<UserMessageBubble content="Hello world" />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });
});
