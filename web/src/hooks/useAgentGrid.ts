import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useStore } from "../store";
import type { TaskToolInput } from "../utils/team-styles";
import { EMPTY_MEMBERS, EMPTY_MESSAGES } from "../utils/team-styles";

export interface AgentGridItem {
  /** The tool_use block ID -- used to filter child messages */
  blockId: string;
  name: string;
  type: string;
  status: "active" | "idle" | "shutdown";
}

export function useAgentGrid(sessionId: string) {
  const messages = useStore(
    useShallow((s) => s.sessionData[sessionId]?.messages ?? EMPTY_MESSAGES),
  );
  const teamMembers = useStore(
    useShallow((s) => s.sessionData[sessionId]?.state?.team?.members ?? EMPTY_MEMBERS),
  );

  const agents = useMemo(() => {
    const membersByName = new Map(teamMembers.map((m) => [m.name, m]));
    const seen = new Set<string>();
    const items: AgentGridItem[] = [];

    for (const msg of messages) {
      if (msg.type !== "assistant" || msg.parent_tool_use_id) continue;
      for (const block of msg.message.content) {
        if (block.type !== "tool_use" || block.name !== "Task" || seen.has(block.id)) continue;
        seen.add(block.id);
        const input = block.input as TaskToolInput;
        const name = input.name ?? "Agent";
        const member = membersByName.get(name);
        items.push({
          blockId: block.id,
          name,
          type: input.subagent_type ?? "",
          status: member?.status ?? "active",
        });
      }
    }
    return items;
  }, [messages, teamMembers]);

  const shouldShowGrid = agents.length > 0;

  return { agents, shouldShowGrid };
}
