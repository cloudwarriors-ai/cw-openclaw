import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { JsonlReviewEventQaSource } from "./qa-ingest.js";

describe("jsonl review-event qa source", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("loads approved events for requested tenant", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "slm-pipeline-source-"));
    cleanupDirs.push(dir);
    const filePath = path.join(dir, "zoom-review-events.jsonl");

    const lines = [
      {
        event_id: "2c73ce3f-f3ca-46dc-969d-13a510f56f5d",
        tenant_id: "tenant-a",
        event_type: "qa.approved",
        created_at: "2026-02-23T01:00:00.000Z",
        ref_id: "approval-1",
        actor_name: "reviewer-a",
        question: "How do we enable SSO?",
        answer: "Configure SAML in admin settings.",
      },
      {
        event_id: "18808f2c-f249-4fd0-aebd-62a1d31a212d",
        tenant_id: "tenant-a",
        event_type: "qa.rejected",
        created_at: "2026-02-23T01:02:00.000Z",
        question: "ignored",
        answer: "ignored",
      },
      {
        event_id: "c7f2f471-b1f2-4611-96cf-a4afab3d4f31",
        tenant_id: "tenant-b",
        event_type: "qa.approved",
        created_at: "2026-02-23T01:03:00.000Z",
        question: "other tenant",
        answer: "other tenant",
      },
    ];

    await fs.writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\nnot-json\n`, "utf8");

    const source = new JsonlReviewEventQaSource(filePath);
    const records = await source.listApprovedQa("tenant-a", "zoom");

    expect(records).toHaveLength(1);
    expect(records[0]?.example_id).toBe(lines[0].event_id);
    expect(records[0]?.question).toContain("SSO");
    expect(records[0]?.source_message_ids).toEqual(["approval-1"]);
  });
});
