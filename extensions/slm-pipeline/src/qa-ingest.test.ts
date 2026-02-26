import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { MemoryServerClient } from "./memory-client.js";
import { InMemoryQaSource, JsonlReviewEventQaSource, MemoryProjectionQaSource } from "./qa-ingest.js";

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
    const records = await source.listApprovedQa({
      tenantId: "tenant-a",
      source: "zoom",
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.example_id).toBe(lines[0].event_id);
    expect(records[0]?.question).toContain("SSO");
    expect(records[0]?.source_message_ids).toEqual(["approval-1"]);
  });

  test("library source defaults to validated status and applies filters", async () => {
    const source = new InMemoryQaSource();
    source.add({
      example_id: "6ab34e18-0e43-4b9f-a814-cc2b3d5fd108",
      tenant_id: "tenant-a",
      source_channel: "library",
      source_message_ids: ["r-1"],
      question: "How do we rotate API keys?",
      answer: "Rotate quarterly and revoke old keys.",
      citations: [],
      approved_by: "reviewer",
      approved_at: "2026-02-24T00:00:00.000Z",
      provider_key: "zoom",
      channel_key: "support",
      category_id: "db08eb3f-8d4f-4ae9-a2d5-bbe29ed3afee",
      status: "validated",
      origin: "manual",
    });
    source.add({
      example_id: "0c5760cf-2f73-4dc9-bd7e-f8ad87fe15d8",
      tenant_id: "tenant-a",
      source_channel: "library",
      source_message_ids: ["r-2"],
      question: "Draft answer",
      answer: "Still pending review.",
      citations: [],
      approved_by: "reviewer",
      approved_at: "2026-02-24T00:01:00.000Z",
      provider_key: "zoom",
      channel_key: "support",
      category_id: "db08eb3f-8d4f-4ae9-a2d5-bbe29ed3afee",
      status: "draft",
      origin: "manual",
    });

    const defaults = await source.listApprovedQa({
      tenantId: "tenant-a",
      source: "library",
      providerKey: "zoom",
      channelKey: "support",
      categoryId: "db08eb3f-8d4f-4ae9-a2d5-bbe29ed3afee",
    });
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.status).toBe("validated");

    const drafts = await source.listApprovedQa({
      tenantId: "tenant-a",
      source: "library",
      status: "draft",
      providerKey: "zoom",
      channelKey: "support",
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.example_id).toBe("0c5760cf-2f73-4dc9-bd7e-f8ad87fe15d8");
  });

  test("memory projection source paginates until all tenant records are collected", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        records: [
          {
            id: "0d8ec4ad-bf32-4891-b20a-f5f0f07ea7b0",
            tenant_id: "tenant-b",
            namespace: "slm.qa.current",
            kind: "qa_projection",
            content: "Q\n\nA",
            metadata: {
              question: "Q tenant-b",
              answer: "A tenant-b",
              status: "validated",
            },
            created_at: "2026-02-25T00:00:00.000Z",
            updated_at: "2026-02-25T00:00:00.000Z",
          },
        ],
        next_cursor: "page-2",
      })
      .mockResolvedValueOnce({
        records: [
          {
            id: "d2359e6d-f25f-4792-b628-7eb6f1129d30",
            tenant_id: "tenant-a",
            namespace: "slm.qa.current",
            kind: "qa_projection",
            content: "Q\n\nA",
            metadata: {
              question: "Q tenant-a",
              answer: "A tenant-a",
              provider_key: "zoom",
              channel_key: "support",
              category_id: "75e04589-c956-4c7c-9e2e-f3ec607894f6",
              status: "validated",
              origin: "manual",
            },
            created_at: "2026-02-25T00:00:00.000Z",
            updated_at: "2026-02-25T00:00:00.000Z",
          },
        ],
        next_cursor: null,
      });
    const memoryClient = {
      enabled: true,
      create: vi.fn(),
      upsert: vi.fn(),
      get: vi.fn(),
      list,
      search: vi.fn(),
    } as unknown as MemoryServerClient;
    const source = new MemoryProjectionQaSource(memoryClient);

    const records = await source.listApprovedQa({
      tenantId: "tenant-a",
      source: "library",
      status: "validated",
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.tenant_id).toBe("tenant-a");
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        limit: 200,
      }),
    );
  });
});
