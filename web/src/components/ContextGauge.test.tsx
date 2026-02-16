import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContextGauge } from "./ContextGauge";

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

  it("shows high usage warning at 75%+", () => {
    render(<ContextGauge percent={75} />);
    expect(screen.getByText("High usage")).toBeInTheDocument();
  });

  it("shows critical warning at 90%+", () => {
    render(<ContextGauge percent={92} />);
    expect(screen.getByText("Critical — consider compacting")).toBeInTheDocument();
  });

  it("shows no warning below 75%", () => {
    render(<ContextGauge percent={50} />);
    expect(screen.queryByText("High usage")).not.toBeInTheDocument();
    expect(screen.queryByText(/Critical/)).not.toBeInTheDocument();
  });
});
