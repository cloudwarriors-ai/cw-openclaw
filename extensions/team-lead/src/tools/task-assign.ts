import { Type } from "@sinclair/typebox";
import {
  generateTaskId,
  generateProjectId,
  saveTask,
  saveProject,
  getAgentHeartbeat,
  appendEvent,
} from "../storage.js";
import type { QueuedTask, StoredProject } from "../types.js";

export const taskAssignSchema = Type.Object({
  agent: Type.Object({
    name: Type.String({ description: "Target agent name" }),
    machine: Type.String({ description: "Target machine hostname" }),
  }),
  project: Type.Object({
    name: Type.String({ description: "Project name" }),
    repo: Type.String({ description: "Repository (org/repo)" }),
    branch: Type.String({ description: "Target branch" }),
    pr: Type.Union([Type.String(), Type.Null()], { description: "PR number or null" }),
    group: Type.Optional(
      Type.String({ description: "Parent initiative/program (e.g. Tesseract, Bighead)" }),
    ),
  }),
  assignment: Type.Object({
    summary: Type.String({ description: "Task summary" }),
    problem: Type.String({ description: "Problem to solve" }),
    details: Type.String({ description: "Detailed instructions" }),
  }),
  startMode: Type.Union([Type.Literal("now"), Type.Literal("queued")], {
    description: '"now" to start immediately, "queued" to add to agent inbox (default: queued)',
  }),
  assignedBy: Type.String({ description: "Name of the person/agent assigning the task" }),
  configProfile: Type.Optional(
    Type.String({
      pattern: "^(_standards|(personal|projects|templates)/[a-zA-Z0-9_-]+)$",
      description:
        "Config bundle from cw-ai-configs repo for the agent to apply " +
        '(e.g. "personal/chad", "templates/django", "projects/zoomwarriors", "_standards")',
    }),
  ),
});

export function executeTaskAssign(
  _id: string,
  params: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const p = params as {
    agent: { name: string; machine: string };
    project: { name: string; repo: string; branch: string; pr: string | null };
    assignment: { summary: string; problem: string; details: string };
    startMode: "now" | "queued";
    assignedBy: string;
    configProfile?: string;
  };

  const CONFIG_PROFILE_RE = /^(_standards|(personal|projects|templates)\/[a-zA-Z0-9_-]+)$/;
  if (p.configProfile && !CONFIG_PROFILE_RE.test(p.configProfile)) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            error: "invalid_config_profile",
            message:
              "configProfile must match category/name format. Valid categories: personal, projects, templates, _standards",
          }),
        },
      ],
    };
  }

  const now = new Date().toISOString();

  if (p.startMode === "queued") {
    const taskId = generateTaskId();
    const task: QueuedTask = {
      taskId,
      projectId: null,
      agent: p.agent,
      project: p.project,
      assignment: p.assignment,
      startMode: p.startMode,
      createdAt: now,
      assignedBy: p.assignedBy,
      ...(p.configProfile && { configProfile: p.configProfile }),
    };
    saveTask(task);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            taskId,
            queued: true,
            ...(p.configProfile && { configProfile: p.configProfile }),
          }),
        },
      ],
    };
  }

  // startMode === "now" — check capacity first
  const heartbeat = getAgentHeartbeat(p.agent.name);
  if (heartbeat?.capacity === "at_capacity") {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            error: "agent_at_capacity",
            agent: p.agent.name,
            capacity: heartbeat.capacity,
          }),
        },
      ],
    };
  }

  // Create project directly with status "assigned"
  const projectId = generateProjectId();
  const project: StoredProject = {
    projectId,
    agent: p.agent,
    project: p.project,
    currentStatus: "assigned",
    currentSummary: p.assignment.summary,
    problem: p.assignment.problem,
    history: [
      {
        timestamp: now,
        status: "assigned",
        summary: p.assignment.summary,
        details: p.assignment.details,
      },
    ],
    createdAt: now,
    updatedAt: now,
    ...(p.configProfile && { configProfile: p.configProfile }),
  };
  saveProject(project);

  appendEvent(projectId, {
    projectId,
    timestamp: now,
    type: "created",
    actor: p.assignedBy,
    data: {
      startMode: "now",
      assignment: p.assignment,
      ...(p.configProfile && { configProfile: p.configProfile }),
    },
  });

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: true,
          projectId,
          started: true,
          ...(p.configProfile && { configProfile: p.configProfile }),
        }),
      },
    ],
  };
}
