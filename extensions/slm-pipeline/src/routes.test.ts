import { describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { InMemoryQaSource, type QaSource } from "./qa-ingest.js";
import { createSlmPipelineRouter } from "./routes.js";
import {
  createInitialSlmPipelineState,
  JsonFileSlmPipelineStateStore,
  type SlmPipelineStateStore,
} from "./state-store.js";
import type { TrainingExecutor } from "./training-orchestrator.js";

function authHeader(tenantId: string): Record<string, string> {
  return { authorization: `Bearer tenant:${tenantId}` };
}

describe("slm pipeline routes", () => {
  test("runs import -> dataset -> training -> review -> feedback flow", async () => {
    const qaSource = new InMemoryQaSource();
    qaSource.add({
      tenant_id: "tenant-a",
      source_channel: "zoom",
      source_message_ids: ["m1"],
      question: "How do I enable SSO?",
      answer: "Enable SAML and configure your IdP metadata.",
      citations: ["https://docs.example/sso"],
      approved_by: "reviewer",
      approved_at: "2026-02-23T00:00:00.000Z",
    });
    qaSource.add({
      tenant_id: "tenant-a",
      source_channel: "zoom",
      source_message_ids: ["m2"],
      question: "How do we route support calls?",
      answer: "Use call queues and assign overflow routing.",
      citations: ["https://docs.example/queue"],
      approved_by: "reviewer",
      approved_at: "2026-02-23T00:01:00.000Z",
    });

    const router = createSlmPipelineRouter({ qaSource });

    const imported = await router.handle({
      method: "POST",
      path: "/v1/slm/qa-events/import",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        source: "zoom",
        idempotency_key: "import-key-001",
      },
    });
    expect(imported.status).toBe(202);
    expect((imported.body as { imported_count: number }).imported_count).toBe(2);

    const built = await router.handle({
      method: "POST",
      path: "/v1/slm/datasets/build",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        split_seed: 7,
        idempotency_key: "build-key-001",
      },
    });
    expect(built.status).toBe(202);
    const datasetId = (built.body as { dataset_id: string }).dataset_id;

    const started = await router.handle({
      method: "POST",
      path: "/v1/slm/training/runs",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        dataset_id: datasetId,
        base_model: "forge/slm-base",
        idempotency_key: "train-key-001",
      },
    });
    expect(started.status).toBe(202);
    const runId = (started.body as { run_id: string }).run_id;

    const run = await router.handle({
      method: "GET",
      path: `/v1/slm/training/runs/${runId}`,
      headers: authHeader("tenant-a"),
    });
    expect(run.status).toBe(200);

    const queue = await router.handle({
      method: "GET",
      path: "/v1/slm/eval/review-queue?tenant_id=tenant-a&limit=10",
      headers: authHeader("tenant-a"),
      query: new URL("http://localhost/v1/slm/eval/review-queue?tenant_id=tenant-a&limit=10")
        .searchParams,
    });
    expect(queue.status).toBe(200);
    const firstItem = (queue.body as { items: Array<{ item_id: string }> }).items[0];
    expect(firstItem).toBeDefined();

    const reviewed = await router.handle({
      method: "POST",
      path: `/v1/slm/eval/review/${firstItem?.item_id}`,
      headers: authHeader("tenant-a"),
      body: {
        score_accuracy: 0.9,
        score_grounding: 0.95,
        score_actionability: 0.9,
        corrected_answer: "Use queue overflow and after-hours routing.",
      },
    });
    expect(reviewed.status).toBe(200);

    const applied = await router.handle({
      method: "POST",
      path: "/v1/slm/feedback/apply",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        run_id: runId,
        item_ids: [firstItem?.item_id],
        max_ratio: 1,
        idempotency_key: "feedback-key-001",
      },
    });
    expect(applied.status).toBe(202);
    expect((applied.body as { applied_count: number }).applied_count).toBe(1);
  });

  test("rejects tenant mismatch", async () => {
    const router = createSlmPipelineRouter();
    const response = await router.handle({
      method: "POST",
      path: "/v1/slm/qa-events/import",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-b",
        source: "zoom",
        idempotency_key: "import-key-002",
      },
    });
    expect(response.status).toBe(403);
  });

  test("preserves idempotency and state across router instances", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slm-pipeline-routes-"));
    const filePath = path.join(dir, "pipeline-state.json");
    const stateStore = new JsonFileSlmPipelineStateStore(filePath);
    const qaSource = new InMemoryQaSource();
    qaSource.add({
      tenant_id: "tenant-a",
      source_channel: "zoom",
      source_message_ids: ["m1"],
      question: "Q1",
      answer: "A1",
      citations: [],
      approved_by: "reviewer",
      approved_at: "2026-02-23T00:00:00.000Z",
    });

    const routerA = createSlmPipelineRouter({ qaSource, stateStore });
    const first = await routerA.handle({
      method: "POST",
      path: "/v1/slm/qa-events/import",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        source: "zoom",
        idempotency_key: "import-persist-1",
      },
    });
    expect(first.status).toBe(202);
    expect((first.body as { imported_count: number }).imported_count).toBe(1);

    const routerB = createSlmPipelineRouter({ qaSource, stateStore });
    const second = await routerB.handle({
      method: "POST",
      path: "/v1/slm/qa-events/import",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        source: "zoom",
        idempotency_key: "import-persist-1",
      },
    });
    expect(second.status).toBe(202);
    expect((second.body as { deduped: boolean }).deduped).toBe(true);

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("dedupes concurrent requests with the same idempotency key", async () => {
    let release: (records: Awaited<ReturnType<QaSource["listApprovedQa"]>>) => void = () => {};
    const waitForRelease = new Promise<Awaited<ReturnType<QaSource["listApprovedQa"]>>>((resolve) => {
      release = resolve;
    });
    const qaSource: QaSource = {
      listApprovedQa: async () => waitForRelease,
    };
    const router = createSlmPipelineRouter({ qaSource });
    const body = {
      tenant_id: "tenant-a",
      source: "zoom" as const,
      idempotency_key: "import-concurrent-001",
    };

    const first = router.handle({
      method: "POST",
      path: "/v1/slm/qa-events/import",
      headers: authHeader("tenant-a"),
      body,
    });

    await Promise.resolve();

    const second = router.handle({
      method: "POST",
      path: "/v1/slm/qa-events/import",
      headers: authHeader("tenant-a"),
      body,
    });

    release([
      {
        example_id: "a9e0df4e-f1b2-42b0-af69-f788df2ae9de",
        tenant_id: "tenant-a",
        source_channel: "zoom",
        source_message_ids: ["ref-1"],
        question: "Q1",
        answer: "A1",
        citations: [],
        approved_by: "reviewer",
        approved_at: "2026-02-23T00:00:00.000Z",
      },
    ]);

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(202);
    expect((firstResponse.body as { imported_count: number }).imported_count).toBe(1);
    expect(secondResponse.status).toBe(202);
    expect((secondResponse.body as { deduped: boolean }).deduped).toBe(true);

    const third = await router.handle({
      method: "POST",
      path: "/v1/slm/qa-events/import",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        source: "zoom",
        idempotency_key: "import-concurrent-002",
      },
    });
    expect((third.body as { imported_count: number }).imported_count).toBe(0);
  });

  test("does not burn dataset idempotency key when build fails", async () => {
    const qaSource = new InMemoryQaSource();
    const router = createSlmPipelineRouter({ qaSource });

    const failedBuild = await router.handle({
      method: "POST",
      path: "/v1/slm/datasets/build",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        split_seed: 7,
        idempotency_key: "build-failure-key",
      },
    });
    expect(failedBuild.status).toBe(409);

    qaSource.add({
      tenant_id: "tenant-a",
      source_channel: "zoom",
      source_message_ids: ["m1"],
      question: "How do I set up SSO?",
      answer: "Enable SAML settings.",
      citations: [],
      approved_by: "reviewer",
      approved_at: "2026-02-23T00:00:00.000Z",
    });

    const imported = await router.handle({
      method: "POST",
      path: "/v1/slm/qa-events/import",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        source: "zoom",
        idempotency_key: "import-after-failed-build",
      },
    });
    expect(imported.status).toBe(202);

    const secondBuild = await router.handle({
      method: "POST",
      path: "/v1/slm/datasets/build",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        split_seed: 7,
        idempotency_key: "build-failure-key",
      },
    });
    expect(secondBuild.status).toBe(202);
    expect((secondBuild.body as { deduped?: boolean }).deduped).not.toBe(true);
  });

  test("returns failed run status when training executor fails", async () => {
    const qaSource = new InMemoryQaSource();
    qaSource.add({
      tenant_id: "tenant-a",
      source_channel: "zoom",
      source_message_ids: ["m1"],
      question: "Q1",
      answer: "A1",
      citations: [],
      approved_by: "reviewer",
      approved_at: "2026-02-23T00:00:00.000Z",
    });

    const failingExecutor: TrainingExecutor = {
      run: async () => ({
        ok: false,
        errorMessage: "forge unavailable",
        retryable: false,
      }),
    };
    const router = createSlmPipelineRouter({
      qaSource,
      trainingExecutor: failingExecutor,
    });

    await router.handle({
      method: "POST",
      path: "/v1/slm/qa-events/import",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        source: "zoom",
        idempotency_key: "import-failing-train",
      },
    });

    const built = await router.handle({
      method: "POST",
      path: "/v1/slm/datasets/build",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        split_seed: 11,
        idempotency_key: "build-failing-train",
      },
    });
    const datasetId = (built.body as { dataset_id: string }).dataset_id;

    const started = await router.handle({
      method: "POST",
      path: "/v1/slm/training/runs",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        dataset_id: datasetId,
        base_model: "forge/slm-base",
        idempotency_key: "train-failing-key",
      },
    });
    expect(started.status).toBe(202);
    expect((started.body as { status: string }).status).toBe("failed");

    const queue = await router.handle({
      method: "GET",
      path: "/v1/slm/eval/review-queue?tenant_id=tenant-a&limit=10",
      headers: authHeader("tenant-a"),
      query: new URL("http://localhost/v1/slm/eval/review-queue?tenant_id=tenant-a&limit=10")
        .searchParams,
    });
    expect((queue.body as { items: unknown[] }).items).toHaveLength(0);
  });

  test("keeps training idempotency key when persistence fails after execution", async () => {
    const qaSource = new InMemoryQaSource();
    qaSource.add({
      tenant_id: "tenant-a",
      source_channel: "zoom",
      source_message_ids: ["m1"],
      question: "Q1",
      answer: "A1",
      citations: [],
      approved_by: "reviewer",
      approved_at: "2026-02-23T00:00:00.000Z",
    });

    let saveCalls = 0;
    const state = createInitialSlmPipelineState();
    const stateStore: SlmPipelineStateStore = {
      getState: async () => state,
      saveState: async () => {
        saveCalls += 1;
        if (saveCalls === 3) {
          throw new Error("disk full");
        }
      },
    };

    const router = createSlmPipelineRouter({ qaSource, stateStore });
    await router.handle({
      method: "POST",
      path: "/v1/slm/qa-events/import",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        source: "zoom",
        idempotency_key: "import-persist-failure",
      },
    });

    const built = await router.handle({
      method: "POST",
      path: "/v1/slm/datasets/build",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        split_seed: 5,
        idempotency_key: "build-persist-failure",
      },
    });
    const datasetId = (built.body as { dataset_id: string }).dataset_id;

    const firstTrain = await router.handle({
      method: "POST",
      path: "/v1/slm/training/runs",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        dataset_id: datasetId,
        base_model: "forge/slm-base",
        idempotency_key: "train-persist-failure",
      },
    });
    expect(firstTrain.status).toBe(500);

    const retryTrain = await router.handle({
      method: "POST",
      path: "/v1/slm/training/runs",
      headers: authHeader("tenant-a"),
      body: {
        tenant_id: "tenant-a",
        dataset_id: datasetId,
        base_model: "forge/slm-base",
        idempotency_key: "train-persist-failure",
      },
    });
    expect(retryTrain.status).toBe(202);
    expect((retryTrain.body as { deduped: boolean }).deduped).toBe(true);
  });
});
