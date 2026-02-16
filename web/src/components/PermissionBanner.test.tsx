import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsumerPermissionRequest } from "../../../shared/consumer-types";
import { useStore } from "../store";
import * as ws from "../ws";
import { PermissionBanner } from "./PermissionBanner";

vi.mock("../ws", () => ({
  send: vi.fn(),
}));

const SESSION_ID = "perm-test-session";

function makePermission(
  overrides?: Partial<ConsumerPermissionRequest>,
): ConsumerPermissionRequest {
  return {
    request_id: "req-1",
    tool_use_id: "tu-1",
    tool_name: "Bash",
    description: "Run a command",
    input: { command: "ls -la" },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("PermissionBanner", () => {
  beforeEach(() => {
    useStore.setState({
      sessionData: {},
      sessions: {},
      currentSessionId: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when no permissions pending", () => {
    useStore.getState().ensureSessionData(SESSION_ID);
    const { container } = render(<PermissionBanner sessionId={SESSION_ID} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when session data does not exist", () => {
    const { container } = render(<PermissionBanner sessionId="nonexistent" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders permission request with tool name", () => {
    useStore.getState().ensureSessionData(SESSION_ID);
    useStore.getState().addPermission(SESSION_ID, makePermission());
    render(<PermissionBanner sessionId={SESSION_ID} />);

    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("Run a command")).toBeInTheDocument();
  });

  it("shows Bash command preview", () => {
    useStore.getState().ensureSessionData(SESSION_ID);
    useStore.getState().addPermission(SESSION_ID, makePermission());
    render(<PermissionBanner sessionId={SESSION_ID} />);

    expect(screen.getByText("$ ls -la")).toBeInTheDocument();
  });

  it("shows Edit tool preview with old/new strings", () => {
    useStore.getState().ensureSessionData(SESSION_ID);
    useStore.getState().addPermission(
      SESSION_ID,
      makePermission({
        request_id: "req-2",
        tool_use_id: "tu-2",
        tool_name: "Edit",
        description: "Edit a file",
        input: { file_path: "/tmp/test.ts", old_string: "foo", new_string: "bar" },
      }),
    );
    render(<PermissionBanner sessionId={SESSION_ID} />);

    expect(screen.getByText("/tmp/test.ts")).toBeInTheDocument();
    expect(screen.getByText(/foo/)).toBeInTheDocument();
    expect(screen.getByText(/bar/)).toBeInTheDocument();
  });

  it("sends allow response and removes permission on Allow click", async () => {
    const user = userEvent.setup();
    useStore.getState().ensureSessionData(SESSION_ID);
    useStore.getState().addPermission(SESSION_ID, makePermission());
    render(<PermissionBanner sessionId={SESSION_ID} />);

    await user.click(screen.getByRole("button", { name: /approve bash/i }));

    expect(ws.send).toHaveBeenCalledWith({
      type: "permission_response",
      request_id: "req-1",
      behavior: "allow",
    });
    expect(
      useStore.getState().sessionData[SESSION_ID].pendingPermissions["req-1"],
    ).toBeUndefined();
  });

  it("sends deny response and removes permission on Deny click", async () => {
    const user = userEvent.setup();
    useStore.getState().ensureSessionData(SESSION_ID);
    useStore.getState().addPermission(SESSION_ID, makePermission());
    render(<PermissionBanner sessionId={SESSION_ID} />);

    await user.click(screen.getByRole("button", { name: /deny bash/i }));

    expect(ws.send).toHaveBeenCalledWith({
      type: "permission_response",
      request_id: "req-1",
      behavior: "deny",
    });
    expect(
      useStore.getState().sessionData[SESSION_ID].pendingPermissions["req-1"],
    ).toBeUndefined();
  });

  it("renders multiple permission requests", () => {
    useStore.getState().ensureSessionData(SESSION_ID);
    useStore.getState().addPermission(SESSION_ID, makePermission());
    useStore.getState().addPermission(
      SESSION_ID,
      makePermission({
        request_id: "req-2",
        tool_use_id: "tu-2",
        tool_name: "Edit",
        description: "Edit a file",
        input: { file_path: "/tmp/test.ts", old_string: "foo", new_string: "bar" },
      }),
    );
    render(<PermissionBanner sessionId={SESSION_ID} />);

    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });
});
