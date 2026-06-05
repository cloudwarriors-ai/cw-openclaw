import { Type } from "@sinclair/typebox";
import { getAgentHeartbeat, listAgents } from "../storage.js";
import type { AgentHeartbeat } from "../types.js";

export const agentStatusSchema = Type.Object({
  agentName: Type.Optional(
    Type.String({ description: "Agent name to query (optional — omit to list all)" }),
  ),
});

function computeStatus(agent: AgentHeartbeat): AgentHeartbeat {
  const elapsed = Date.now() - new Date(agent.lastHeartbeat).getTime();
  if (elapsed > 180_000 && agent.status !== "unresponsive") {
    return { ...agent, status: "unresponsive" };
  }
  return agent;
}

export function executeAgentStatus(
  _id: string,
  params: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const { agentName } = params as { agentName?: string };

  if (agentName) {
    const agent = getAgentHeartbeat(agentName);
    if (!agent) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: false, error: `Agent ${agentName} not found` }),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ok: true, agent: computeStatus(agent) }),
        },
      ],
    };
  }

  // List all agents
  const agents = listAgents().map(computeStatus);

  const header = "| Agent | Machine | Capacity | Status | Last Heartbeat | Active Projects |";
  const sep = "|-------|---------|----------|--------|----------------|-----------------|";
  const rows = agents.map(
    (a) =>
      `| ${a.agentName} | ${a.machine} | ${a.capacity} | ${a.status} | ${a.lastHeartbeat} | ${a.activeProjects.length} |`,
  );

  const table = agents.length ? [header, sep, ...rows].join("\n") : "No agents registered.";

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: true, agents, table }),
      },
    ],
  };
}
