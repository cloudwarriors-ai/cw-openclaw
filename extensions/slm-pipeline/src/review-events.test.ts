import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emitPipelineReviewEvent } from "./review-events.js";

describe("pipeline review events", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("writes approved review events to jsonl", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slm-review-events-"));
    cleanupDirs.push(dir);
    const filePath = path.join(dir, "review-events.jsonl");

    const event = await emitPipelineReviewEvent({
      tenantId: "tenant-a",
      eventType: "qa.approved",
      traceId: "7d6614bc-fde7-40df-b15a-45cf6979f66a",
      refId: "review-1",
      actorId: "reviewer-1",
      actorName: "Reviewer",
      sourceChannelJid: "zoom:ops",
      question: "How do we reset voicemail PINs?",
      answer: "Use admin reset workflow and force rotation.",
      metadata: { source: "unit-test" },
      storePath: filePath,
      now: () => new Date("2026-02-24T12:00:00.000Z"),
    });

    expect(event.event_type).toBe("qa.approved");
    expect(event.created_at).toBe("2026-02-24T12:00:00.000Z");

    const raw = await fs.readFile(filePath, "utf8");
    const [line] = raw.trim().split("\n");
    const parsed = JSON.parse(line ?? "{}") as { tenant_id?: string; question?: string };
    expect(parsed.tenant_id).toBe("tenant-a");
    expect(parsed.question).toContain("voicemail");
  });
});
