import { Type } from "@sinclair/typebox";
import { deleteProject, appendEvent } from "../storage.js";

export const projectDeleteSchema = Type.Object({
  projectId: Type.String({ description: "Project ID to delete (e.g. proj_a1b2c3d4)" }),
});

export function executeProjectDelete(
  _id: string,
  params: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const { projectId } = params as { projectId: string };

  appendEvent(projectId, {
    projectId,
    timestamp: new Date().toISOString(),
    type: "deleted",
    actor: "team_lead",
    data: {},
  });

  const deleted = deleteProject(projectId);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: deleted, deleted, projectId }),
      },
    ],
  };
}
