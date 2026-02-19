import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ImageBlock } from "./ImageBlock";

describe("ImageBlock", () => {
  it("renders an img with a data URL", () => {
    render(<ImageBlock mediaType="image/png" data="abc123" />);
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,abc123");
  });

  it("has an accessible alt text", () => {
    render(<ImageBlock mediaType="image/jpeg" data="xyz" />);
    expect(screen.getByRole("img", { name: /content/i })).toBeDefined();
  });

  it("renders nothing for disallowed media types", () => {
    const { container } = render(<ImageBlock mediaType="image/svg+xml" data="abc" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for completely unknown media types", () => {
    const { container } = render(<ImageBlock mediaType="text/html" data="abc" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows broken image fallback on load error", async () => {
    render(<ImageBlock mediaType="image/png" data="invalid-data" />);
    const img = screen.getByRole("img");
    // Simulate image load error
    img.dispatchEvent(new Event("error"));
    expect(await screen.findByText(/could not be displayed/i)).toBeDefined();
  });
});
