import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { JsonFileSlmPipelineStateStore } from "./state-store.js";

describe("slm pipeline state store", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("persists and reloads state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slm-pipeline-state-"));
    cleanupDirs.push(dir);
    const filePath = path.join(dir, "state.json");

    const storeA = new JsonFileSlmPipelineStateStore(filePath);
    const stateA = await storeA.getState();
    stateA.idempotency.add("tenant-a:import:key-1");
    stateA.approvedQa.push({
      example_id: "a9e0df4e-f1b2-42b0-af69-f788df2ae9de",
      tenant_id: "tenant-a",
      source_channel: "zoom",
      source_message_ids: ["ref-1"],
      question: "Q",
      answer: "A",
      citations: [],
      approved_by: "reviewer",
      approved_at: "2026-02-23T00:00:00.000Z",
    });
    await storeA.saveState(stateA);

    const storeB = new JsonFileSlmPipelineStateStore(filePath);
    const stateB = await storeB.getState();

    expect(stateB.idempotency.has("tenant-a:import:key-1")).toBe(true);
    expect(stateB.approvedQa).toHaveLength(1);
    expect(stateB.approvedQa[0]?.tenant_id).toBe("tenant-a");
  });
});
