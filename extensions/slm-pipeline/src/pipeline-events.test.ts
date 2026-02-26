import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { JsonlSlmPipelineEventSink } from "./pipeline-events.js";

describe("pipeline events", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) {
        continue;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("writes jsonl events and redacts sensitive metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slm-pipeline-events-"));
    cleanupDirs.push(dir);
    const filePath = path.join(dir, "events.jsonl");
    const sink = new JsonlSlmPipelineEventSink(filePath);

    const event = await sink.emit({
      tenantId: "tenant-a",
      traceId: "trace-1",
      eventType: "training.run_failed",
      input: {
        dataset_id: "dataset-1",
      },
      output: {
        error: "temporary unavailable",
      },
      metadata: {
        auth_token: "secret",
        nested: {
          password: "abc",
          keep: "ok",
        },
      },
    });

    expect(event.input_hash).toHaveLength(64);
    expect(event.output_hash).toHaveLength(64);

    const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as {
      metadata?: {
        auth_token?: string;
        nested?: { password?: string; keep?: string };
      };
    };
    expect(parsed.metadata?.auth_token).toBe("[REDACTED]");
    expect(parsed.metadata?.nested?.password).toBe("[REDACTED]");
    expect(parsed.metadata?.nested?.keep).toBe("ok");
  });

  test("recovers queue writes after one append failure", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slm-pipeline-events-"));
    cleanupDirs.push(dir);
    const filePath = path.join(dir, "events.jsonl");
    const sink = new JsonlSlmPipelineEventSink(filePath);

    const appendOriginal = fs.appendFile.bind(fs);
    const appendSpy = vi.spyOn(fs, "appendFile");
    appendSpy.mockImplementationOnce(async (..._args) => {
      throw new Error("disk full");
    });
    appendSpy.mockImplementation(async (...args) => appendOriginal(...args));

    await expect(
      sink.emit({
        tenantId: "tenant-a",
        eventType: "dataset.build_started",
      }),
    ).rejects.toThrow("disk full");

    await expect(
      sink.emit({
        tenantId: "tenant-a",
        eventType: "dataset.build_succeeded",
      }),
    ).resolves.toBeDefined();

    const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    appendSpy.mockRestore();
  });
});
