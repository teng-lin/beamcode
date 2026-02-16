import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import type { ConsumerMessage } from "../../../shared/consumer-types";
import { useStore } from "../store";
import type { TaskToolInput } from "../utils/team-styles";
import { EMPTY_MEMBERS, EMPTY_MESSAGES } from "../utils/team-styles";

type AssistantMessage = Extract<ConsumerMessage, { type: "assistant" }>;

export interface AgentGridItem {
  /** The tool_use block ID — used to filter child messages */
  blockId: string;
  name: string;
  type: string;
  status: "active" | "idle" | "shutdown";
  messages: AssistantMessage[];
}

export function useAgentGrid(sessionId: string) {
  const messages = useStore(
    useShallow((s) => s.sessionData[sessionId]?.messages ?? EMPTY_MESSAGES),
  );
  const teamMembers = useStore(
    useShallow((s) => s.sessionData[sessionId]?.state?.team?.members ?? EMPTY_MEMBERS),
  );

  const membersByName = useMemo(() => new Map(teamMembers.map((m) => [m.name, m])), [teamMembers]);

  const agents = useMemo(() => {
    const seen = new Set<string>();
    const items: AgentGridItem[] = [];
    // Single pass: discover agents and group their messages
    const msgsByAgent = new Map<string, AssistantMessage[]>();

    for (const msg of messages) {
      if (msg.type !== "assistant") continue;

      // Agent child messages — group by parent_tool_use_id
      if (msg.parent_tool_use_id) {
        let bucket = msgsByAgent.get(msg.parent_tool_use_id);
        if (!bucket) {
          bucket = [];
          msgsByAgent.set(msg.parent_tool_use_id, bucket);
        }
        bucket.push(msg);
        continue;
      }

      // Top-level assistant messages — discover Task tool_use blocks
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
          messages: [], // populated below
        });
      }
    }

    // Attach grouped messages to each agent
    for (const item of items) {
      item.messages = msgsByAgent.get(item.blockId) ?? [];
    }

    return items;
  }, [messages, membersByName]);

  const shouldShowGrid = agents.length > 0;

  return { agents, shouldShowGrid };
}
