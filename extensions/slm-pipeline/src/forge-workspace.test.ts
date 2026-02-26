import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { DatasetArtifact } from "./types.js";
import { ForgeWorkspaceAdapter, resolveForgeWorkspaceRootFromEnv } from "./forge-workspace.js";

const fixtureDataset: DatasetArtifact = {
  dataset_id: "8e3f9d88-9b38-40e4-bec2-a2f154d58f64",
  tenant_id: "tenant-a",
  split_seed: 7,
  manifest_hash: "sha256:abc123",
  train: [
    {
      example_id: "2f4e6901-f2bc-4ea0-b5cb-4d80a9e1f0ef",
      tenant_id: "tenant-a",
      input: "How do I set up SSO?",
      target: "Configure SAML metadata in admin settings.",
      citations: ["https://docs.example/sso"],
      source_ids: ["msg-1"],
    },
  ],
  eval: [
    {
      example_id: "2cd916b6-d292-43a6-b8f8-893e6ec89dd8",
      tenant_id: "tenant-a",
      input: "How do I revoke a key?",
      target: "Rotate secrets in settings and reissue clients.",
      citations: ["https://docs.example/keys"],
      source_ids: ["msg-2"],
    },
  ],
  created_at: "2026-02-23T12:00:00.000Z",
};

describe("forge workspace adapter", () => {
  test("exports dataset and returns deterministic workspace paths", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "forge-workspace-"));
    const adapter = new ForgeWorkspaceAdapter(workspaceRoot);

    const first = await adapter.exportDataset({
      domain: "Support Cases",
      tenantId: "tenant-a",
      runId: "run-123",
      dataset: fixtureDataset,
    });
    const second = await adapter.exportDataset({
      domain: "Support Cases",
      tenantId: "tenant-a",
      runId: "run-123",
      dataset: fixtureDataset,
    });

    expect(first).toEqual(second);
    expect(first.datasetPath).toContain(
      path.join("domains", "support-cases", "customers", "tenant-a", "datasets", "sha256-abc123"),
    );
    expect(first.adapterPath).toContain(
      path.join("domains", "support-cases", "customers", "tenant-a", "runs", "run-123", "adapter"),
    );

    const datasetRaw = await readFile(first.datasetPath, "utf8");
    const manifestRaw = await readFile(first.manifestPath, "utf8");
    expect(datasetRaw).toContain('"split":"train"');
    expect(datasetRaw).toContain('"split":"eval"');
    expect(manifestRaw).toContain(`"manifest_hash": "${fixtureDataset.manifest_hash}"`);
  });

  test("resolves workspace root from env", () => {
    const root = resolveForgeWorkspaceRootFromEnv(
      { OPENCLAW_SLM_FORGE_WORKSPACE_DIR: "relative/path" },
      "/tmp/cwd",
    );
    expect(root).toBe("/tmp/cwd/relative/path");
    expect(resolveForgeWorkspaceRootFromEnv({})).toBeNull();
  });
});
