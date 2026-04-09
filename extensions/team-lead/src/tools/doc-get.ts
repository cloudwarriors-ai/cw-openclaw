import { Type } from "@sinclair/typebox";
import { getDoc, listDocs, getProject } from "../storage.js";
import type { ArchitectureDoc } from "../types.js";

export const docGetSchema = Type.Object({
  projectId: Type.Optional(
    Type.String({ description: "Filter by project ID. Omit to list docs across all projects." }),
  ),
  slug: Type.Optional(
    Type.String({ description: "Doc slug to retrieve full content. Requires projectId." }),
  ),
  repo: Type.Optional(
    Type.String({
      description:
        "Filter docs by repository (e.g. 'cloudwarriors-ai/myapp'). Returns docs from all projects in that repo.",
    }),
  ),
});

export function executeDocGet(
  _id: string,
  params: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const { projectId, slug, repo } = params as { projectId?: string; slug?: string; repo?: string };

  // Single doc with full content
  if (projectId && slug) {
    const doc = getDoc(projectId, slug);
    if (!doc) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: `Doc '${slug}' not found in project ${projectId}`,
            }),
          },
        ],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, doc }) }],
    };
  }

  // List docs (for one project, one repo, or all)
  let docs = listDocs(projectId);

  // Filter by repo if specified
  if (repo && !projectId) {
    docs = docs.filter((d) => {
      const p = getProject(d.projectId);
      return p && p.project.repo === repo;
    });
  }

  const metadata: Omit<ArchitectureDoc, "content">[] = docs.map(({ content: _, ...rest }) => rest);

  const header = "| Project | Slug | Title | Author | Updated |";
  const sep = "|---------|------|-------|--------|---------|";
  const rows = metadata.map(
    (d) => `| ${d.projectId} | ${d.slug} | ${d.title} | ${d.author} | ${d.updatedAt} |`,
  );
  const table = metadata.length ? [header, sep, ...rows].join("\n") : "No architecture docs found.";

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: true, docs: metadata, table }),
      },
    ],
  };
}
