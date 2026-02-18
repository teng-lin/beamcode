import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStore, store } from "../test/factories";
import { AuthBanner } from "./AuthBanner";

const SESSION = "auth-test";

describe("AuthBanner", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders nothing when authStatus is null", () => {
    store().ensureSessionData(SESSION);
    const { container } = render(<AuthBanner sessionId={SESSION} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when not authenticating and no error", () => {
    store().ensureSessionData(SESSION);
    store().setAuthStatus(SESSION, { isAuthenticating: false, output: [] });
    const { container } = render(<AuthBanner sessionId={SESSION} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows authenticating banner with output", () => {
    store().ensureSessionData(SESSION);
    store().setAuthStatus(SESSION, {
      isAuthenticating: true,
      output: ["Opening browser..."],
    });
    render(<AuthBanner sessionId={SESSION} />);
    expect(screen.getByText("Authenticating...")).toBeInTheDocument();
    expect(screen.getByText("Opening browser...")).toBeInTheDocument();
  });

  it("shows error state", () => {
    store().ensureSessionData(SESSION);
    store().setAuthStatus(SESSION, {
      isAuthenticating: false,
      output: [],
      error: "Token expired",
    });
    render(<AuthBanner sessionId={SESSION} />);
    expect(screen.getByText("Authentication failed")).toBeInTheDocument();
    expect(screen.getByText("Token expired")).toBeInTheDocument();
  });

  it("has alert role for accessibility", () => {
    store().ensureSessionData(SESSION);
    store().setAuthStatus(SESSION, {
      isAuthenticating: true,
      output: [],
    });
    render(<AuthBanner sessionId={SESSION} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
