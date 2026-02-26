import { describe, expect, test } from "vitest";
import { DatasetBuilderService } from "./dataset-builder.js";
import { InMemoryQaSource } from "./qa-ingest.js";
import {
  ForgeCliTrainingExecutor,
  parseForgeAdapterPath,
  resolveTrainingExecutorFromEnv,
  StubTrainingExecutor,
  TrainingOrchestratorService,
  type TrainingExecutor,
} from "./training-orchestrator.js";

async function buildDataset() {
  const source = new InMemoryQaSource();
  source.add({
    tenant_id: "tenant-a",
    source_channel: "zoom",
    source_message_ids: ["m1"],
    question: "How do I set up SSO?",
    answer: "Configure SAML metadata in admin settings.",
    citations: ["https://docs.example/sso"],
    approved_by: "reviewer",
    approved_at: "2026-02-23T00:00:00.000Z",
  });
  const approvedQa = await source.listApprovedQa("tenant-a", "zoom");
  return new DatasetBuilderService().build({
    tenantId: "tenant-a",
    splitSeed: 7,
    approvedQa,
  });
}

describe("training orchestrator", () => {
  test("marks run failed after non-retryable executor failure", async () => {
    const dataset = await buildDataset();
    const executor: TrainingExecutor = {
      run: async () => ({
        ok: false,
        errorMessage: "invalid training config",
        retryable: false,
      }),
    };
    const orchestrator = new TrainingOrchestratorService(executor, 3);

    const output = await orchestrator.startRun({
      tenantId: "tenant-a",
      dataset,
      baseModel: "forge/slm-base",
      now: () => new Date("2026-02-23T12:00:00.000Z"),
    });

    expect(output.attempts).toBe(1);
    expect(output.run.status).toBe("failed");
    expect(output.run.error_message).toContain("invalid training config");
    expect(output.evalItems).toHaveLength(0);
  });

  test("retries transient failures and succeeds", async () => {
    const dataset = await buildDataset();
    let attempts = 0;
    const executor: TrainingExecutor = {
      run: async () => {
        attempts += 1;
        if (attempts < 2) {
          return {
            ok: false,
            errorMessage: "temporary unavailable",
            retryable: true,
          };
        }
        return {
          ok: true,
          adapterPath: "adapters/tenant-a/run-1/forge-slm-base",
        };
      },
    };
    const orchestrator = new TrainingOrchestratorService(executor, 3);

    const output = await orchestrator.startRun({
      tenantId: "tenant-a",
      dataset,
      baseModel: "forge/slm-base",
      now: () => new Date("2026-02-23T12:00:00.000Z"),
    });

    expect(output.attempts).toBe(2);
    expect(output.run.status).toBe("succeeded");
    expect(output.run.adapter_path).toBe("adapters/tenant-a/run-1/forge-slm-base");
  });

  test("uses stub executor by default", async () => {
    const dataset = await buildDataset();
    const orchestrator = new TrainingOrchestratorService(new StubTrainingExecutor(), 1);
    const output = await orchestrator.startRun({
      tenantId: "tenant-a",
      dataset,
      baseModel: "forge/slm-base",
      now: () => new Date("2026-02-23T12:00:00.000Z"),
    });
    expect(output.run.status).toBe("succeeded");
    expect(output.evalItems.length).toBeGreaterThan(0);
  });

  test("retries when executor throws transient errors", async () => {
    const dataset = await buildDataset();
    let calls = 0;
    const executor: TrainingExecutor = {
      run: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("temporary unavailable");
        }
        return {
          ok: true,
          adapterPath: "adapters/tenant-a/recovered",
        };
      },
    };
    const orchestrator = new TrainingOrchestratorService(executor, 2);
    const output = await orchestrator.startRun({
      tenantId: "tenant-a",
      dataset,
      baseModel: "forge/slm-base",
      now: () => new Date("2026-02-23T12:00:00.000Z"),
    });

    expect(output.run.status).toBe("succeeded");
    expect(output.attempts).toBe(2);
  });

  test("builds forge cli args with supported flags", async () => {
    const dataset = await buildDataset();
    let capturedArgs: string[] = [];
    const executor = new ForgeCliTrainingExecutor({
      bin: "/usr/local/bin/forge",
      domain: "support",
      configPath: "/tmp/forge.json",
      adapterPath: "/tmp/adapter",
      timeoutMs: 5_000,
      runCommand: async (params) => {
        capturedArgs = params.args;
        return {
          code: 0,
          stdout: '{"adapter_path":"/tmp/adapter/final"}',
          stderr: "",
        };
      },
    });

    const result = await executor.run({
      tenantId: "tenant-a",
      dataset,
      baseModel: "forge/slm-base",
      runId: "run-1",
      attempt: 1,
    });

    expect(capturedArgs).toEqual([
      "train",
      "--domain",
      "support",
      "--customer-id",
      "tenant-a",
      "--config",
      "/tmp/forge.json",
      "--adapter-path",
      "/tmp/adapter",
    ]);
    expect(result.ok).toBe(true);
    expect(result.adapterPath).toBe("/tmp/adapter/final");
  });

  test("parses forge adapter path from json output", () => {
    const parsed = parseForgeAdapterPath(
      [
        "status: running",
        '{"run_id":"r1","result":{"artifact":{"adapter_path":"adapters/tenant-a/r1"}}}',
      ].join("\n"),
    );
    expect(parsed).toBe("adapters/tenant-a/r1");
  });

  test("falls back to stub executor when forge domain is missing", () => {
    const resolved = resolveTrainingExecutorFromEnv({
      OPENCLAW_SLM_FORGE_BIN: "/usr/local/bin/forge",
    });
    expect(resolved).toBeInstanceOf(StubTrainingExecutor);
  });
});
