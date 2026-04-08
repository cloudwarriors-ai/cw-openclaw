import { Type } from "@sinclair/typebox";
import { listQueue } from "../storage.js";

export const taskListQueueSchema = Type.Object({
  agent: Type.Optional(Type.String({ description: "Filter by agent name (optional)" })),
});

export function executeTaskListQueue(
  _id: string,
  params: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const { agent } = params as { agent?: string };
  const tasks = listQueue(agent);

  const header = "| Task ID | Agent | Project | Config | Problem | Assigned By | Created |";
  const sep = "|---------|-------|---------|--------|---------|-------------|---------|";
  const rows = tasks.map((t) => {
    const cfg = t.configProfile ?? "—";
    return `| ${t.taskId} | ${t.agent.name} | ${t.project.name} | ${cfg} | ${t.assignment.problem} | ${t.assignedBy} | ${t.createdAt} |`;
  });

  const table = tasks.length ? [header, sep, ...rows].join("\n") : "No queued tasks.";

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: true, tasks, table }),
      },
    ],
  };
}
