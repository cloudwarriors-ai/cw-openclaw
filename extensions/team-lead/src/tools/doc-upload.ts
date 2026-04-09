import { Type } from "@sinclair/typebox";
import { getProject, getDoc, saveDoc, generateDocId, appendEvent } from "../storage.js";
import type { ArchitectureDoc } from "../types.js";

export const docUploadSchema = Type.Object({
  projectId: Type.String({ description: "Project ID to attach the doc to (e.g. proj_a1b2c3d4)" }),
  title: Type.String({ description: "Document title (e.g. 'API Architecture', 'Data Flow')" }),
  content: Type.String({ description: "Document content in Markdown" }),
  author: Type.String({ description: "Author name (agent or human)" }),
  branch: Type.Optional(
    Type.String({
      description: "Branch name — appended to slug to prevent collisions across branches",
    }),
  ),
});

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function executeDocUpload(
  _id: string,
  params: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  const { projectId, title, content, author, branch } = params as {
    projectId: string;
    title: string;
    content: string;
    author: string;
    branch?: string;
  };

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

  const slug = branch ? slugify(`${title}-${branch}`) : slugify(title);
  if (!slug) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ok: false, error: "Title produces an empty slug" }),
        },
      ],
    };
  }

  const now = new Date().toISOString();
  const existing = getDoc(projectId, slug);
  const isNew = !existing;

  const doc: ArchitectureDoc = {
    docId: existing?.docId ?? generateDocId(),
    projectId,
    slug,
    title,
    content,
    author,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  saveDoc(doc);

  appendEvent(projectId, {
    projectId,
    timestamp: now,
    type: isNew ? "doc_added" : "doc_updated",
    actor: author,
    data: { docId: doc.docId, slug, title },
  });

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: true, docId: doc.docId, slug, projectId, isNew }),
      },
    ],
  };
}
