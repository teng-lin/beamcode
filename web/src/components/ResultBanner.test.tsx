import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ResultData } from "../../../shared/consumer-types";
import { formatCost, formatTokens } from "../utils/format";
import { ResultBanner } from "./ResultBanner";

function makeResult(overrides?: Partial<ResultData>): ResultData {
  return {
    subtype: "success",
    is_error: false,
    duration_ms: 5000,
    total_cost_usd: 0.05,
    stop_reason: "end_turn",
    num_turns: 3,
    duration_api_ms: 4500,
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  };
}

describe("ResultBanner", () => {
  it('renders "Done" for successful result', () => {
    render(<ResultBanner data={makeResult()} />);
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it('renders "Error" for error result', () => {
    render(
      <ResultBanner data={makeResult({ is_error: true, subtype: "error_during_execution" })} />,
    );
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("renders first error detail line when provided", () => {
    render(
      <ResultBanner
        data={makeResult({
          is_error: true,
          subtype: "error_during_execution",
          errors: ["permission denied: sandbox"],
        })}
      />,
    );
    expect(screen.getByText("permission denied: sandbox")).toBeInTheDocument();
  });

  it("displays formatted duration", () => {
    const data = makeResult({ duration_ms: 5000 });
    render(<ResultBanner data={data} />);
    expect(screen.getByText(/5\.0s/)).toBeInTheDocument();
  });

  it("displays formatted cost", () => {
    const data = makeResult({ total_cost_usd: 0.05 });
    render(<ResultBanner data={data} />);
    expect(screen.getByText(formatCost(0.05))).toBeInTheDocument();
  });

  it("displays formatted token count", () => {
    const data = makeResult({
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    render(<ResultBanner data={data} />);
    expect(screen.getByText(`${formatTokens(1500)} tokens`)).toBeInTheDocument();
  });

  it("shows success styling", () => {
    const { container } = render(<ResultBanner data={makeResult()} />);
    expect(container.firstChild).toHaveClass("bg-bc-success/5");
  });

  it("displays lines added and removed when present", () => {
    const data = makeResult({ total_lines_added: 15, total_lines_removed: 3 });
    render(<ResultBanner data={data} />);
    expect(screen.getByText("+15")).toBeInTheDocument();
    expect(screen.getByText("-3")).toBeInTheDocument();
  });

  it("does not display lines when absent", () => {
    render(<ResultBanner data={makeResult()} />);
    expect(screen.queryByText(/^\+\d/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^-\d/)).not.toBeInTheDocument();
  });

  it("shows error styling", () => {
    const { container } = render(
      <ResultBanner data={makeResult({ is_error: true, subtype: "error_during_execution" })} />,
    );
    expect(container.firstChild).toHaveClass("bg-bc-error/5");
  });

  // ── Latency breakdown ─────────────────────────────────────────────────

  it("renders API breakdown when duration_api_ms is present", () => {
    render(<ResultBanner data={makeResult({ duration_ms: 2300, duration_api_ms: 1900 })} />);
    expect(screen.getByText(/API/)).toBeInTheDocument();
    expect(screen.getByText(/1\.9s/)).toBeInTheDocument();
  });

  it("omits API breakdown when duration_api_ms is 0", () => {
    render(<ResultBanner data={makeResult({ duration_ms: 2300, duration_api_ms: 0 })} />);
    expect(screen.queryByText(/API/)).not.toBeInTheDocument();
  });

  it("omits API breakdown when duration_api_ms is absent", () => {
    render(
      <ResultBanner
        data={makeResult({ duration_ms: 2300, duration_api_ms: undefined as unknown as number })}
      />,
    );
    expect(screen.queryByText(/API/)).not.toBeInTheDocument();
  });

  it("highlights slow turns (> 5s) with warning color", () => {
    const { container } = render(<ResultBanner data={makeResult({ duration_ms: 6000 })} />);
    const durationEl = container.querySelector(".text-bc-warning");
    expect(durationEl).toBeInTheDocument();
  });

  it("does not highlight fast turns (< 5s)", () => {
    const { container } = render(<ResultBanner data={makeResult({ duration_ms: 3000 })} />);
    const durationEl = container.querySelector(".text-bc-warning");
    expect(durationEl).not.toBeInTheDocument();
  });

  it("handles clock skew (api_ms > duration_ms) by clamping", () => {
    render(<ResultBanner data={makeResult({ duration_ms: 2000, duration_api_ms: 3000 })} />);
    // Should show API time clamped to duration_ms
    expect(screen.getByText(/API 2\.0s/)).toBeInTheDocument();
  });
});
