import { Type } from "@sinclair/typebox";
import { saveAgentHeartbeat } from "../storage.js";
import type { AgentHeartbeat } from "../types.js";

export const heartbeatSchema = Type.Object({
  agentName: Type.String({ description: "Agent name" }),
  machine: Type.String({ description: "Machine hostname" }),
  capacity: Type.Union([Type.Literal("idle"), Type.Literal("busy"), Type.Literal("at_capacity")], {
    description: "Current agent capacity",
  }),
  activeProjects: Type.Array(Type.String(), {
    description: "List of active project IDs",
  }),
});

export function executeHeartbeat(
  _id: string,
  params: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const p = params as {
    agentName: string;
    machine: string;
    capacity: "idle" | "busy" | "at_capacity";
    activeProjects: string[];
  };

  const hb: AgentHeartbeat = {
    agentName: p.agentName,
    machine: p.machine,
    capacity: p.capacity,
    lastHeartbeat: new Date().toISOString(),
    status: "active",
    activeProjects: p.activeProjects,
  };

  saveAgentHeartbeat(hb);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: true, acknowledged: true, agentName: p.agentName }),
      },
    ],
  };
}
