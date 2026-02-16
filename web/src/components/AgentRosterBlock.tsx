import { useMemo, useState } from "react";
import { useShallow } from "zustand/shallow";
import type { ConsumerTeamMember } from "../../../shared/consumer-types";
import { useStore } from "../store";
import type { TaskToolInput } from "../utils/team-styles";
import { memberStatusDotClass, shortAgentType } from "../utils/team-styles";

const EMPTY_MEMBERS: ConsumerTeamMember[] = [];

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AgentRosterBlockProps {
  blocks: ToolUseBlock[];
  sessionId?: string;
}

export function AgentRosterBlock({ blocks }: AgentRosterBlockProps) {
  const [expanded, setExpanded] = useState(true);
  const teamMembers = useStore(
    useShallow((s) => {
      const data = s.currentSessionId ? s.sessionData[s.currentSessionId] : null;
      return data?.state?.team?.members ?? EMPTY_MEMBERS;
    }),
  );
  const inspectedAgentId = useStore((s) => s.inspectedAgentId);
  const setInspectedAgent = useStore((s) => s.setInspectedAgent);

  const teamMembersByName = useMemo(
    () => new Map(teamMembers.map((m) => [m.name, m])),
    [teamMembers],
  );

  if (blocks.length === 0) return null;

  return (
    <div className="rounded-lg border border-bc-border/60 bg-bc-surface transition-colors hover:border-bc-border">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          className="flex-shrink-0"
          aria-hidden="true"
        >
          <circle
            cx="6"
            cy="4"
            r="2"
            stroke="var(--color-bc-accent)"
            strokeWidth="1.2"
            opacity="0.7"
          />
          <path
            d="M2 10c0-2.2 1.8-4 4-4s4 1.8 4 4"
            stroke="var(--color-bc-accent)"
            strokeWidth="1.2"
            opacity="0.5"
          />
        </svg>
        <span className="font-medium text-bc-accent">Agent Team</span>
        <span className="rounded-full bg-bc-accent/15 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-bc-accent">
          {blocks.length}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="currentColor"
          className={`ml-auto flex-shrink-0 text-bc-text-muted/50 transition-transform ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        >
          <path d="M3.5 2L7 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-bc-border/50">
          {blocks.map((block) => {
            const taskInput = block.input as TaskToolInput;
            const name = taskInput.name ?? "Agent";
            const type = taskInput.subagent_type ?? "";
            const desc = taskInput.description ?? "";
            const member = teamMembersByName.get(name);
            const dotClass = memberStatusDotClass(member?.status ?? "shutdown");
            const isInspected = inspectedAgentId === block.id;

            return (
              <button
                key={block.id}
                type="button"
                onClick={() => setInspectedAgent(isInspected ? null : block.id)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-bc-hover ${
                  isInspected ? "bg-bc-accent/10" : ""
                }`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`}
                  title={`Status: ${member?.status ?? "unknown"}`}
                />
                <span className="truncate font-medium text-bc-text">{name}</span>
                {type && (
                  <span className="truncate text-bc-text-muted">{shortAgentType(type)}</span>
                )}
                {desc && (
                  <span className="ml-auto truncate text-bc-text-muted/60" title={desc}>
                    {desc}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
