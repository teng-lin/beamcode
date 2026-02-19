import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeBlock } from "./CodeBlock";

describe("CodeBlock", () => {
  it("renders code content", () => {
    render(<CodeBlock language="typescript" code="const x = 1;" />);
    expect(screen.getByText("const x = 1;")).toBeDefined();
  });

  it("shows language label", () => {
    render(<CodeBlock language="python" code="print('hi')" />);
    expect(screen.getByText("python")).toBeDefined();
  });

  it("renders without language", () => {
    render(<CodeBlock language="" code="hello world" />);
    expect(screen.getByText("hello world")).toBeDefined();
  });

  it("copies code to clipboard on button click", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<CodeBlock language="bash" code="echo hi" />);
    await user.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("echo hi");
  });

  it("does not throw when clipboard access is denied", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    render(<CodeBlock language="bash" code="echo hi" />);
    await expect(user.click(screen.getByRole("button", { name: /copy/i }))).resolves.not.toThrow();
    // Button label stays "Copy" — no crash, no state change
    expect(screen.getByRole("button", { name: /copy code/i })).toBeDefined();
  });
});
