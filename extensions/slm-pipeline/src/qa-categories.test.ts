import { describe, expect, it, vi } from "vitest";
import { SlmPipelineError } from "./errors.js";
import type { MemoryServerClient, MemoryRecord } from "./memory-client.js";
import { QaCategoryService, qaTaxonomyNamespace } from "./qa-categories.js";

function makeMemoryClient(overrides: Partial<MemoryServerClient> = {}): MemoryServerClient {
  return {
    enabled: true,
    create: vi.fn(),
    upsert: vi.fn(),
    get: vi.fn(async () => null),
    list: vi.fn(async () => ({ records: [], next_cursor: null })),
    search: vi.fn(async () => ({ records: [], scores: [] })),
    ...overrides,
  } as unknown as MemoryServerClient;
}

function makeCategoryRecord(params: {
  id: string;
  tenantId: string;
  providerKey?: string;
  channelKey?: string;
  categoryKey?: string;
  displayName?: string;
  namespace?: string;
  kind?: string;
}): MemoryRecord {
  return {
    id: params.id,
    tenant_id: params.tenantId,
    namespace: params.namespace ?? qaTaxonomyNamespace(),
    kind: params.kind ?? "qa_category",
    content: params.displayName ?? "Category",
    metadata: {
      provider_key: params.providerKey ?? "zoom",
      channel_key: params.channelKey ?? "support",
      category_key: params.categoryKey ?? "billing",
      display_name: params.displayName ?? "Billing",
      is_active: "true",
      sort_order: "1000",
      created_at: "2026-02-25T00:00:00.000Z",
      updated_at: "2026-02-25T00:00:00.000Z",
    },
    created_at: "2026-02-25T00:00:00.000Z",
    updated_at: "2026-02-25T00:00:00.000Z",
  };
}

describe("QaCategoryService", () => {
  it("continues scanning pages until tenant records are found", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        records: [
          makeCategoryRecord({
            id: "8ddf0f6e-a1d8-4411-8d84-8ab8fa745fe8",
            tenantId: "tenant-b",
          }),
        ],
        next_cursor: "page-2",
      })
      .mockResolvedValueOnce({
        records: [
          makeCategoryRecord({
            id: "8df95fb8-4364-459f-ad95-f9566675ee07",
            tenantId: "tenant-a",
            categoryKey: "security",
            displayName: "Security",
          }),
        ],
        next_cursor: null,
      });
    const service = new QaCategoryService(
      makeMemoryClient({
        list,
      }),
    );

    const listed = await service.list({
      tenantId: "tenant-a",
      limit: 1,
    });

    expect(listed.records).toHaveLength(1);
    expect(listed.records[0]?.tenant_id).toBe("tenant-a");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("throws conflict when deterministic category key already exists", async () => {
    const service = new QaCategoryService(
      makeMemoryClient({
        get: vi.fn(async (id: string) =>
          makeCategoryRecord({
            id,
            tenantId: "tenant-a",
          }),
        ),
      }),
    );

    await expect(
      service.create({
        tenantId: "tenant-a",
        providerKey: "zoom",
        channelKey: "support",
        categoryKey: "billing",
        displayName: "Billing",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "category_conflict",
    } satisfies Partial<SlmPipelineError>);
  });

  it("guards getById by tenant and taxonomy namespace/kind", async () => {
    const client = makeMemoryClient({
      get: vi.fn(async () =>
        makeCategoryRecord({
          id: "3cfa7d4f-f996-43d7-a686-661cf6db5f31",
          tenantId: "tenant-a",
          namespace: "slm.qa.current",
          kind: "qa_projection",
        }),
      ),
    });
    const service = new QaCategoryService(client);

    const record = await service.getById({
      tenantId: "tenant-a",
      categoryId: "3cfa7d4f-f996-43d7-a686-661cf6db5f31",
    });

    expect(record).toBeNull();
  });
});
