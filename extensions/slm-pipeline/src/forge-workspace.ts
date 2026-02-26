import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatasetArtifact } from "./types.js";

export type ForgeWorkspaceExport = {
  datasetPath: string;
  manifestPath: string;
  adapterPath: string;
};

export class ForgeWorkspaceAdapter {
  constructor(private readonly rootDir: string) {}

  async exportDataset(params: {
    domain: string;
    tenantId: string;
    runId: string;
    dataset: DatasetArtifact;
  }): Promise<ForgeWorkspaceExport> {
    const domainSegment = sanitizeSegment(params.domain);
    const tenantSegment = sanitizeSegment(params.tenantId);
    const manifestSegment = sanitizeSegment(params.dataset.manifest_hash);
    const datasetDir = path.join(
      this.rootDir,
      "domains",
      domainSegment,
      "customers",
      tenantSegment,
      "datasets",
      manifestSegment,
    );
    const runDir = path.join(
      this.rootDir,
      "domains",
      domainSegment,
      "customers",
      tenantSegment,
      "runs",
      params.runId,
    );
    const datasetPath = path.join(datasetDir, "dataset.jsonl");
    const manifestPath = path.join(datasetDir, "manifest.json");
    const adapterPath = path.join(runDir, "adapter");

    await mkdir(datasetDir, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(datasetPath, serializeDatasetJsonl(params.dataset), "utf8");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          dataset_id: params.dataset.dataset_id,
          tenant_id: params.dataset.tenant_id,
          split_seed: params.dataset.split_seed,
          manifest_hash: params.dataset.manifest_hash,
          train_count: params.dataset.train.length,
          eval_count: params.dataset.eval.length,
          created_at: params.dataset.created_at,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    return {
      datasetPath,
      manifestPath,
      adapterPath,
    };
  }
}

export function resolveForgeWorkspaceRootFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | null {
  const configured = env.OPENCLAW_SLM_FORGE_WORKSPACE_DIR?.trim();
  if (!configured) {
    return null;
  }
  return path.resolve(cwd, configured);
}

function sanitizeSegment(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-");
  return normalized.replace(/^-+|-+$/g, "") || "default";
}

function serializeDatasetJsonl(dataset: DatasetArtifact): string {
  const lines: string[] = [];
  for (const example of dataset.train) {
    lines.push(
      JSON.stringify({
        split: "train",
        example_id: example.example_id,
        input: example.input,
        target: example.target,
        citations: example.citations,
        source_ids: example.source_ids,
      }),
    );
  }
  for (const example of dataset.eval) {
    lines.push(
      JSON.stringify({
        split: "eval",
        example_id: example.example_id,
        input: example.input,
        target: example.target,
        citations: example.citations,
        source_ids: example.source_ids,
      }),
    );
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
