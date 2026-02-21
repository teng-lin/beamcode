/**
 * PermissionBridge — converts the Agent SDK's Promise-based `canUseTool`
 * callback into BeamCode's message-based permission_request / permission_response
 * UnifiedMessage flow.
 *
 * The bridge receives an `emit` callback that enqueues permission_request
 * UnifiedMessages into the session's AsyncMessageQueue. When the consumer
 * responds with a permission_response, the bridge resolves the pending
 * promise so the SDK can continue (or abort) tool execution.
 */

import type { UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";

interface PendingRequest {
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PermissionDecision {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
}

const PERMISSION_TIMEOUT_MS = 120_000; // 2 minutes

export class PermissionBridge {
  private pending = new Map<string, PendingRequest>();
  private readonly emit: (msg: UnifiedMessage) => void;

  constructor(emit: (msg: UnifiedMessage) => void) {
    this.emit = emit;
  }

  /**
   * Called by the Agent SDK's `canUseTool` callback.
   * Emits a permission_request UnifiedMessage and returns a Promise
   * that resolves when the consumer responds.
   */
  async handleToolRequest(
    toolName: string,
    input: Record<string, unknown>,
    options: {
      toolUseId: string;
      agentId?: string;
      suggestions?: unknown[];
      blockedPath?: string;
      decisionReason?: string;
    },
  ): Promise<PermissionDecision> {
    const requestId = options.toolUseId;

    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ behavior: "deny", message: "Permission request timed out" });
      }, PERMISSION_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, timer });

      this.emit(
        createUnifiedMessage({
          type: "permission_request",
          role: "system",
          metadata: {
            subtype: "can_use_tool",
            request_id: requestId,
            tool_name: toolName,
            input,
            permission_suggestions: options.suggestions,
            description: options.decisionReason,
            tool_use_id: options.toolUseId,
            agent_id: options.agentId,
            blocked_path: options.blockedPath,
          },
        }),
      );
    });
  }

  /**
   * Called when consumer responds to a permission_request.
   * Resolves the pending promise for the matching request.
   */
  resolve(response: UnifiedMessage): void {
    const requestId = response.metadata?.request_id as string | undefined;
    if (!requestId) return;

    const pending = this.pending.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(requestId);

    const approved = response.metadata?.approved === true;
    const updatedInput = response.metadata?.updated_input as Record<string, unknown> | undefined;

    if (approved) {
      pending.resolve({ behavior: "allow", updatedInput });
    } else {
      const message = (response.metadata?.message as string) ?? "Permission denied by user";
      pending.resolve({ behavior: "deny", message });
    }
  }

  /**
   * Cancel all pending requests (called on session close).
   * Denies all outstanding permission requests.
   */
  cancelAll(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ behavior: "deny", message: "Session closed" });
    }
    this.pending.clear();
  }

  /** Number of currently pending permission requests. */
  get pendingCount(): number {
    return this.pending.size;
  }
}
