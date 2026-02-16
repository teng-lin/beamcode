import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContextGauge } from "./ContextGauge";

function getFillElement(container: HTMLElement): Element | null {
  return container.querySelector("[role=progressbar] > div");
}

describe("ContextGauge", () => {
  it("renders a progressbar with correct aria attributes", () => {
    render(<ContextGauge percent={42} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-label", "Context window 42% used");
  });

  it("displays percentage text", () => {
    render(<ContextGauge percent={55} />);
    expect(screen.getByText("55%")).toBeInTheDocument();
  });

  it("clamps values below 0", () => {
    render(<ContextGauge percent={-10} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
  });

  it("clamps values above 100", () => {
    render(<ContextGauge percent={150} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");
  });

  describe("warning thresholds", () => {
    it("shows no warning at 74%", () => {
      render(<ContextGauge percent={74} />);
      expect(screen.queryByText("High usage")).not.toBeInTheDocument();
      expect(screen.queryByText(/Critical/)).not.toBeInTheDocument();
    });

    it("shows high usage at exactly 75%", () => {
      render(<ContextGauge percent={75} />);
      expect(screen.getByText("High usage")).toBeInTheDocument();
    });

    it("shows high usage at 89%", () => {
      render(<ContextGauge percent={89} />);
      expect(screen.getByText("High usage")).toBeInTheDocument();
      expect(screen.queryByText(/Critical/)).not.toBeInTheDocument();
    });

    it("shows critical warning at exactly 90%", () => {
      render(<ContextGauge percent={90} />);
      expect(screen.getByText("Critical — consider compacting")).toBeInTheDocument();
    });
  });

  describe("gauge color", () => {
    it("applies success color below 60%", () => {
      const { container } = render(<ContextGauge percent={50} />);
      expect(getFillElement(container)?.className).toContain("bg-bc-success");
    });

    it("applies warning color at 60-79%", () => {
      const { container } = render(<ContextGauge percent={65} />);
      expect(getFillElement(container)?.className).toContain("bg-bc-warning");
    });

    it("applies error color at 80%+", () => {
      const { container } = render(<ContextGauge percent={80} />);
      expect(getFillElement(container)?.className).toContain("bg-bc-error");
    });
  });
});
