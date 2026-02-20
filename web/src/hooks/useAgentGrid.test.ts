import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  makeAssistantContent,
  makeAssistantMessage,
  makeTeamMember,
  makeToolUseBlock,
  resetStore,
  store,
} from "../test/factories";
import { useAgentGrid } from "./useAgentGrid";

const SESSION = "grid-test";

let msgCounter = 0;

function addTaskToolUse(id: string, name: string, subagentType: string) {
  store().addMessage(SESSION, {
    type: "assistant",
    parent_tool_use_id: null,
    message: makeAssistantContent(
      [
        makeToolUseBlock({
          id,
          name: "Task",
          input: { name, subagent_type: subagentType, description: "test" },
        }),
      ],
      { id: `msg-task-${++msgCounter}` },
    ),
  });
}

describe("useAgentGrid", () => {
  beforeEach(() => {
    msgCounter = 0;
    resetStore({ currentSessionId: SESSION });
    store().ensureSessionData(SESSION);
  });

  it("returns empty agents and shouldShowGrid=false when no Task tool_use blocks", () => {
    store().addMessage(SESSION, makeAssistantMessage(null, "msg-1"));
    const { result } = renderHook(() => useAgentGrid(SESSION));
    expect(result.current.agents).toEqual([]);
    expect(result.current.shouldShowGrid).toBe(false);
  });

  it("discovers agents from Task tool_use blocks", () => {
    addTaskToolUse("tu-1", "researcher", "general-purpose");
    addTaskToolUse("tu-2", "tester", "Bash");
    const { result } = renderHook(() => useAgentGrid(SESSION));
    expect(result.current.agents).toHaveLength(2);
    expect(result.current.agents[0]).toMatchObject({
      blockId: "tu-1",
      name: "researcher",
      type: "general-purpose",
      status: "active",
    });
    expect(result.current.agents[1]).toMatchObject({
      blockId: "tu-2",
      name: "tester",
      type: "Bash",
      status: "active",
    });
    expect(result.current.shouldShowGrid).toBe(true);
  });

  it("deduplicates agents by blockId", () => {
    addTaskToolUse("tu-1", "researcher", "general-purpose");
    addTaskToolUse("tu-1", "researcher", "general-purpose");
    const { result } = renderHook(() => useAgentGrid(SESSION));
    expect(result.current.agents).toHaveLength(1);
  });

  it("ignores tool_use blocks from agent messages (parent_tool_use_id set)", () => {
    // Agent messages have parent_tool_use_id — should be skipped as agent discovery
    store().addMessage(SESSION, {
      type: "assistant",
      parent_tool_use_id: "tu-parent",
      message: makeAssistantContent([
        makeToolUseBlock({ id: "tu-nested", name: "Task", input: { name: "nested" } }),
      ]),
    });
    const { result } = renderHook(() => useAgentGrid(SESSION));
    expect(result.current.agents).toHaveLength(0);
  });

  it("resolves status from team members", () => {
    addTaskToolUse("tu-1", "researcher", "general-purpose");
    store().setSessionState(SESSION, {
      session_id: SESSION,
      model: "test",
      cwd: "/tmp",
      total_cost_usd: 0,
      num_turns: 0,
      context_used_percent: 0,
      is_compacting: false,
      team: {
        name: "test-team",
        role: "lead",
        members: [makeTeamMember({ name: "researcher", status: "idle" })],
        tasks: [],
      },
    });
    const { result } = renderHook(() => useAgentGrid(SESSION));
    expect(result.current.agents[0].status).toBe("idle");
  });

  it("defaults name to 'Agent' and type to empty when input is missing", () => {
    store().addMessage(SESSION, {
      type: "assistant",
      parent_tool_use_id: null,
      message: makeAssistantContent([makeToolUseBlock({ id: "tu-bare", name: "Task", input: {} })]),
    });
    const { result } = renderHook(() => useAgentGrid(SESSION));
    expect(result.current.agents[0].name).toBe("Agent");
    expect(result.current.agents[0].type).toBe("");
  });

  it("groups child messages by parent_tool_use_id", () => {
    addTaskToolUse("tu-1", "researcher", "general-purpose");
    addTaskToolUse("tu-2", "tester", "Bash");
    // Add messages for agent tu-1
    store().addMessage(SESSION, makeAssistantMessage("tu-1", "msg-a1"));
    store().addMessage(SESSION, makeAssistantMessage("tu-1", "msg-a2"));
    // Add a message for agent tu-2
    store().addMessage(SESSION, makeAssistantMessage("tu-2", "msg-b1"));

    const { result } = renderHook(() => useAgentGrid(SESSION));
    expect(result.current.agents[0].messages).toHaveLength(2);
    expect(result.current.agents[0].messages[0].message.id).toBe("msg-a1");
    expect(result.current.agents[0].messages[1].message.id).toBe("msg-a2");
    expect(result.current.agents[1].messages).toHaveLength(1);
    expect(result.current.agents[1].messages[0].message.id).toBe("msg-b1");
  });
});
