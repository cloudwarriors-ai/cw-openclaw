import { Type } from "@sinclair/typebox";
import { getTask, deleteTask, generateProjectId, saveProject, appendEvent } from "../storage.js";
import type { StoredProject } from "../types.js";

export const taskStartSchema = Type.Object({
  taskId: Type.String({ description: "Task ID to promote from queue to active project" }),
});

export function executeTaskStart(
  _id: string,
  params: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const { taskId } = params as { taskId: string };
  const task = getTask(taskId);

  if (!task) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ok: false, error: `Task ${taskId} not found in queue` }),
        },
      ],
    };
  }

  const now = new Date().toISOString();
  const projectId = generateProjectId();

  const project: StoredProject = {
    projectId,
    agent: task.agent,
    project: task.project,
    currentStatus: "in_progress",
    currentSummary: task.assignment.summary,
    problem: task.assignment.problem,
    history: [
      {
        timestamp: task.createdAt,
        status: "queued",
        summary: `Queued by ${task.assignedBy}`,
        details: task.assignment.details,
      },
      {
        timestamp: now,
        status: "in_progress",
        summary: task.assignment.summary,
        details: "Promoted from queue — work started",
      },
    ],
    createdAt: task.createdAt,
    updatedAt: now,
    ...(task.configProfile && { configProfile: task.configProfile }),
  };

  saveProject(project);
  deleteTask(taskId);

  appendEvent(projectId, {
    projectId,
    timestamp: task.createdAt,
    type: "created",
    actor: task.assignedBy,
    data: {
      source: "queue",
      taskId,
      assignment: task.assignment,
      ...(task.configProfile && { configProfile: task.configProfile }),
    },
  });

  appendEvent(projectId, {
    projectId,
    timestamp: now,
    type: "status_changed",
    actor: task.agent.name,
    data: {
      prevStatus: "queued",
      status: "in_progress",
      ...(task.configProfile && { configProfile: task.configProfile }),
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
          taskId,
          ...(task.configProfile && { configProfile: task.configProfile }),
        }),
      },
    ],
  };
}
