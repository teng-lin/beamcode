import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsumerPermissionRequest } from "../../../shared/consumer-types";
import { makePermission, resetStore, store } from "../test/factories";
import * as ws from "../ws";
import { PermissionBanner } from "./PermissionBanner";

vi.mock("../ws", () => ({
  send: vi.fn(),
}));

const SESSION_ID = "perm-test-session";

function renderWithPermission(
  ...permissions: ConsumerPermissionRequest[]
): ReturnType<typeof render> {
  store().ensureSessionData(SESSION_ID);
  for (const perm of permissions) {
    store().addPermission(SESSION_ID, perm);
  }
  return render(<PermissionBanner sessionId={SESSION_ID} />);
}

describe("PermissionBanner", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("renders nothing when no permissions pending", () => {
    store().ensureSessionData(SESSION_ID);
    const { container } = render(<PermissionBanner sessionId={SESSION_ID} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when session data does not exist", () => {
    const { container } = render(<PermissionBanner sessionId="nonexistent" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders permission request with tool name", () => {
    renderWithPermission(makePermission());

    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("Run a command")).toBeInTheDocument();
  });

  it("shows Bash command preview", () => {
    renderWithPermission(makePermission());

    expect(screen.getByText("$ ls")).toBeInTheDocument();
  });

  it("shows Edit tool preview with old/new strings", () => {
    renderWithPermission(
      makePermission({
        request_id: "req-2",
        tool_use_id: "tu-2",
        tool_name: "Edit",
        description: "Edit a file",
        input: { file_path: "/tmp/test.ts", old_string: "foo", new_string: "bar" },
      }),
    );

    expect(screen.getByText("/tmp/test.ts")).toBeInTheDocument();
    expect(screen.getByText(/foo/)).toBeInTheDocument();
    expect(screen.getByText(/bar/)).toBeInTheDocument();
  });

  it("sends allow response and removes permission on Allow click", async () => {
    const user = userEvent.setup();
    renderWithPermission(makePermission({ request_id: "req-1" }));

    await user.click(screen.getByRole("button", { name: /approve bash/i }));

    expect(ws.send).toHaveBeenCalledWith({
      type: "permission_response",
      request_id: "req-1",
      behavior: "allow",
    });
    expect(store().sessionData[SESSION_ID].pendingPermissions["req-1"]).toBeUndefined();
  });

  it("sends deny response and removes permission on Deny click", async () => {
    const user = userEvent.setup();
    renderWithPermission(makePermission({ request_id: "req-1" }));

    await user.click(screen.getByRole("button", { name: /deny bash/i }));

    expect(ws.send).toHaveBeenCalledWith({
      type: "permission_response",
      request_id: "req-1",
      behavior: "deny",
    });
    expect(store().sessionData[SESSION_ID].pendingPermissions["req-1"]).toBeUndefined();
  });

  it("renders multiple permission requests", () => {
    renderWithPermission(
      makePermission(),
      makePermission({
        request_id: "req-2",
        tool_use_id: "tu-2",
        tool_name: "Edit",
        description: "Edit a file",
        input: { file_path: "/tmp/test.ts", old_string: "foo", new_string: "bar" },
      }),
    );

    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });
});
