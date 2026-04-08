import { Type } from "@sinclair/typebox";
import { listProjects } from "../storage.js";
import type { DashboardProject } from "../types.js";

export const projectListSchema = Type.Object({
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("queued"),
        Type.Literal("assigned"),
        Type.Literal("in_progress"),
        Type.Literal("blocked"),
        Type.Literal("needs_review"),
        Type.Literal("completed"),
        Type.Literal("cancelled"),
      ],
      { description: "Filter by status (optional)" },
    ),
  ),
  agent: Type.Optional(Type.String({ description: "Filter by agent name (optional)" })),
  group: Type.Optional(Type.String({ description: "Filter by group/initiative (optional)" })),
});

export function executeProjectList(
  _id: string,
  params: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const { status, agent, group } = params as { status?: string; agent?: string; group?: string };
  const projects = listProjects({ status, agent, group });

  const dashboard: DashboardProject[] = projects.map((p) => ({
    projectId: p.projectId,
    agent: p.agent.name,
    projectName: p.project.name,
    group: p.project.group ?? null,
    branch: p.project.branch,
    pr: p.project.pr,
    problem: p.problem,
    status: p.currentStatus,
    lastUpdate: p.updatedAt,
    ...(p.configProfile && { configProfile: p.configProfile }),
  }));

  const header = "| Agent | Group | Project | Config | Branch / PR | Problem | Status |";
  const sep = "|-------|-------|---------|--------|-------------|---------|--------|";
  const rows = dashboard.map((d) => {
    const branchPr = d.pr ? `${d.branch} ${d.pr}` : d.branch;
    const grp = d.group ?? "—";
    const cfg = d.configProfile ?? "—";
    return `| ${d.agent} | ${grp} | ${d.projectName} | ${cfg} | ${branchPr} | ${d.problem} | ${d.status} |`;
  });

  const table = projects.length ? [header, sep, ...rows].join("\n") : "No tracked projects.";

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: true, projects: dashboard, table }),
      },
    ],
  };
}
