import type { ConsumerPermissionRequest } from "../types/consumer-messages.js";

/**
 * Manages permission request cards in the UI.
 * Shows tool name + input preview with Approve / Deny buttons.
 */
export class PermissionUI {
  private container: HTMLElement;
  private activeCards = new Map<string, HTMLElement>();

  constructor(container: HTMLElement) {
    this.container = container;
  }

  showRequest(
    request: ConsumerPermissionRequest,
    onRespond: (approved: boolean) => void,
  ): HTMLElement {
    const card = document.createElement("div");
    card.className = "permission-card";
    card.dataset.requestId = request.request_id;

    const header = document.createElement("div");
    header.className = "perm-header";
    header.textContent = "Permission Request";
    card.appendChild(header);

    const tool = document.createElement("div");
    tool.className = "perm-tool";
    tool.textContent = request.tool_name;
    if (request.description) {
      const desc = document.createElement("span");
      desc.className = "perm-desc";
      desc.textContent = ` — ${request.description}`;
      tool.appendChild(desc);
    }
    card.appendChild(tool);

    const inputPreview = document.createElement("pre");
    inputPreview.className = "perm-input";
    const inputStr = JSON.stringify(request.input, null, 2);
    inputPreview.textContent = inputStr.length > 500 ? `${inputStr.slice(0, 500)}…` : inputStr;
    card.appendChild(inputPreview);

    const actions = document.createElement("div");
    actions.className = "perm-actions";

    const approve = document.createElement("button");
    approve.className = "btn btn-approve";
    approve.textContent = "Approve";
    approve.addEventListener("click", () => {
      onRespond(true);
      this.removeRequest(request.request_id);
    });

    const deny = document.createElement("button");
    deny.className = "btn btn-deny";
    deny.textContent = "Deny";
    deny.addEventListener("click", () => {
      onRespond(false);
      this.removeRequest(request.request_id);
    });

    actions.appendChild(approve);
    actions.appendChild(deny);
    card.appendChild(actions);

    this.activeCards.set(request.request_id, card);
    this.container.appendChild(card);
    return card;
  }

  removeRequest(requestId: string): void {
    const card = this.activeCards.get(requestId);
    if (card) {
      card.remove();
      this.activeCards.delete(requestId);
    }
  }
}
