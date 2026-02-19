import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ImageBlock } from "./ImageBlock";

describe("ImageBlock", () => {
  it("renders an img with a data URL", () => {
    render(<ImageBlock media_type="image/png" data="abc123" />);
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,abc123");
  });

  it("has an accessible alt text", () => {
    render(<ImageBlock media_type="image/jpeg" data="xyz" />);
    expect(screen.getByRole("img", { name: /content/i })).toBeDefined();
  });
});
