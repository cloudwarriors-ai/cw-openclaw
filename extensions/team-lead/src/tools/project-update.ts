import { Type } from "@sinclair/typebox";
import { getProject, saveProject, generateProjectId, appendEvent } from "../storage.js";
import type { ProjectUpdatePayload, StoredProject, PullRequestInfo } from "../types.js";

export const projectUpdateSchema = Type.Object({
  projectId: Type.Union([Type.String(), Type.Null()], {
    description: "Existing project ID to update, or null to create a new project",
  }),
  agent: Type.Object({
    name: Type.String({ description: "Agent name (e.g. daniel-dev)" }),
    machine: Type.String({ description: "Machine hostname" }),
  }),
  project: Type.Object({
    name: Type.String({ description: "Project name" }),
    repo: Type.String({ description: "Repository (org/repo)" }),
    branch: Type.String({ description: "Current branch" }),
    pr: Type.Union([Type.String(), Type.Null()], {
      description: "PR number (e.g. #267) or null",
    }),
    group: Type.Optional(
      Type.String({ description: "Parent initiative/program (e.g. Tesseract, Bighead)" }),
    ),
  }),
  update: Type.Object({
    status: Type.Union(
      [
        Type.Literal("queued"),
        Type.Literal("assigned"),
        Type.Literal("in_progress"),
        Type.Literal("blocked"),
        Type.Literal("needs_review"),
        Type.Literal("completed"),
        Type.Literal("cancelled"),
      ],
      { description: "Current project status" },
    ),
    summary: Type.String({ description: "Short summary of current work" }),
    problem: Type.String({ description: "Problem being solved" }),
    details: Type.String({ description: "Detailed description of changes" }),
  }),
  timestamp: Type.Optional(Type.String({ description: "ISO timestamp — auto-set if omitted" })),
  configProfile: Type.Optional(
    Type.String({
      pattern: "^(_standards|(personal|projects|templates)/[a-zA-Z0-9_-]+)$",
      description: "Config profile to set or update on this project",
    }),
  ),
  pullRequest: Type.Optional(
    Type.Object({
      url: Type.String({
        description: "Full GitHub PR URL (e.g. https://github.com/org/repo/pull/42)",
      }),
      number: Type.Integer({ description: "PR number" }),
      status: Type.Union([Type.Literal("open"), Type.Literal("merged"), Type.Literal("closed")], {
        description: "Current PR status",
      }),
      checksStatus: Type.Optional(
        Type.Union([
          Type.Literal("pending"),
          Type.Literal("passing"),
          Type.Literal("failing"),
          Type.Null(),
        ]),
      ),
      title: Type.Optional(Type.String({ description: "PR title" })),
    }),
  ),
});

export function executeProjectUpdate(
  _id: string,
  params: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const payload = params as unknown as ProjectUpdatePayload;
  const now = payload.timestamp || new Date().toISOString();

  let projectId = payload.projectId;
  let isNew = false;
  let existing = projectId ? getProject(projectId) : null;

  if (!projectId || !existing) {
    projectId = generateProjectId();
    isNew = true;

    const project: StoredProject = {
      projectId,
      agent: payload.agent,
      project: payload.project,
      currentStatus: payload.update.status,
      currentSummary: payload.update.summary,
      problem: payload.update.problem,
      history: [
        {
          timestamp: now,
          status: payload.update.status,
          summary: payload.update.summary,
          details: payload.update.details,
        },
      ],
      createdAt: now,
      updatedAt: now,
      ...(payload.configProfile && { configProfile: payload.configProfile }),
      ...(payload.pullRequest && {
        pullRequest: { ...payload.pullRequest, updatedAt: now } as PullRequestInfo,
      }),
    };

    // Backfill project.pr from pullRequest if not already set
    if (payload.pullRequest && !project.project.pr) {
      project.project.pr = `#${payload.pullRequest.number}`;
    }

    saveProject(project);

    appendEvent(projectId, {
      projectId,
      timestamp: now,
      type: "created",
      actor: payload.agent.name,
      data: {
        status: payload.update.status,
        summary: payload.update.summary,
        ...(payload.configProfile && { configProfile: payload.configProfile }),
      },
    });

    if (payload.pullRequest) {
      appendEvent(projectId, {
        projectId,
        timestamp: now,
        type: "pr_updated",
        actor: payload.agent.name,
        data: { ...payload.pullRequest },
      });
    }
  } else {
    const prevStatus = existing.currentStatus;
    existing.agent = payload.agent;
    existing.project = payload.project;
    existing.currentStatus = payload.update.status;
    existing.currentSummary = payload.update.summary;
    existing.problem = payload.update.problem;
    if (payload.configProfile !== undefined) {
      const prevConfig = existing.configProfile;
      existing.configProfile = payload.configProfile;
      if (prevConfig !== payload.configProfile) {
        appendEvent(projectId!, {
          projectId: projectId!,
          timestamp: now,
          type: "config_changed",
          actor: payload.agent.name,
          data: { prevConfig: prevConfig ?? null, configProfile: payload.configProfile },
        });
      }
    }
    if (payload.pullRequest) {
      const prevPR = existing.pullRequest;
      existing.pullRequest = { ...payload.pullRequest, updatedAt: now } as PullRequestInfo;
      if (!existing.project.pr) {
        existing.project.pr = `#${payload.pullRequest.number}`;
      }
      if (
        !prevPR ||
        prevPR.status !== payload.pullRequest.status ||
        prevPR.url !== payload.pullRequest.url
      ) {
        appendEvent(projectId!, {
          projectId: projectId!,
          timestamp: now,
          type: "pr_updated",
          actor: payload.agent.name,
          data: { prevStatus: prevPR?.status ?? null, ...payload.pullRequest },
        });
      }
    }
    existing.updatedAt = now;
    existing.history.push({
      timestamp: now,
      status: payload.update.status,
      summary: payload.update.summary,
      details: payload.update.details,
    });
    saveProject(existing);

    const eventType = prevStatus !== payload.update.status ? "status_changed" : "updated";
    appendEvent(projectId, {
      projectId,
      timestamp: now,
      type: eventType,
      actor: payload.agent.name,
      data: {
        prevStatus,
        status: payload.update.status,
        summary: payload.update.summary,
        ...(payload.configProfile && { configProfile: payload.configProfile }),
      },
    });
  }

  const saved = getProject(projectId)!;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: true,
          projectId,
          acknowledged: true,
          isNew,
          totalUpdates: saved.history.length,
        }),
      },
    ],
  };
}
