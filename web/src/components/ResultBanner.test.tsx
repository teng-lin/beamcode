import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ResultData } from "../../../shared/consumer-types";
import { formatCost, formatDuration, formatTokens } from "../utils/format";
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

  it("displays formatted duration", () => {
    const data = makeResult({ duration_ms: 5000 });
    render(<ResultBanner data={data} />);
    expect(screen.getByText(formatDuration(5000))).toBeInTheDocument();
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

  it("shows error styling", () => {
    const { container } = render(
      <ResultBanner data={makeResult({ is_error: true, subtype: "error_during_execution" })} />,
    );
    expect(container.firstChild).toHaveClass("bg-bc-error/5");
  });
});
