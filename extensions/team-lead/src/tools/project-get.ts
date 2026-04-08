import { Type } from "@sinclair/typebox";
import { getProject, getEventLog } from "../storage.js";

export const projectGetSchema = Type.Object({
  projectId: Type.String({ description: "Project ID to retrieve (e.g. proj_a1b2c3d4)" }),
});

export function executeProjectGet(
  _id: string,
  params: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const { projectId } = params as { projectId: string };
  const project = getProject(projectId);

  if (!project) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ok: false, error: `Project ${projectId} not found` }),
        },
      ],
    };
  }

  const events = getEventLog(projectId);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: true, project, events }),
      },
    ],
  };
}
