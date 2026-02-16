/**
 * PermissionBridge — bridges the Claude Agent SDK's Promise-based canUseTool
 * callback with BeamCode's async-iterable permission request/response model.
 *
 * The SDK calls `canUseTool(toolName, input)` and expects a Promise back.
 * BeamCode broadcasts a `permission_request` UnifiedMessage to consumers,
 * then waits for a `permission_response` to resolve the Promise.
 */

import type { UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingPermission {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  resolve: (decision: PermissionDecision) => void;
}

export interface PermissionDecision {
  behavior: "allow" | "deny";
  updatedInput?: unknown;
  message?: string;
}

// ---------------------------------------------------------------------------
// PermissionBridge
// ---------------------------------------------------------------------------

export class PermissionBridge {
  private pending = new Map<string, PendingPermission>();
  private emitter: (msg: UnifiedMessage) => void;

  constructor(emitter: (msg: UnifiedMessage) => void) {
    this.emitter = emitter;
  }

  /**
   * Called by the SDK's canUseTool callback.
   * Creates a permission_request UnifiedMessage, emits it, and returns
   * a Promise that resolves when respondToPermission() is called.
   */
  async handleToolRequest(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    const requestId = crypto.randomUUID();

    const permissionMsg = createUnifiedMessage({
      type: "permission_request",
      role: "system",
      metadata: {
        requestId,
        toolName,
        input,
        description: `${toolName}: ${JSON.stringify(input).slice(0, 100)}`,
      },
    });

    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(requestId, { requestId, toolName, input, resolve });
      this.emitter(permissionMsg);
    });
  }

  /**
   * Called when a consumer sends a permission_response UnifiedMessage.
   * Resolves the corresponding canUseTool Promise.
   */
  respondToPermission(
    requestId: string,
    behavior: "allow" | "deny",
    updatedInput?: unknown,
  ): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;

    this.pending.delete(requestId);
    pending.resolve({
      behavior,
      updatedInput: updatedInput ?? pending.input,
      message: behavior === "deny" ? "User denied permission" : undefined,
    });
    return true;
  }

  /** Reject all pending permissions (on session close). */
  rejectAll(): void {
    for (const [, pending] of this.pending) {
      pending.resolve({ behavior: "deny", message: "Session closed" });
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
