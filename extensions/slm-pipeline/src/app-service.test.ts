import { describe, expect, it, vi } from "vitest";
import type { QaProjectionRecord } from "./types.js";
import { PipelineAppService } from "./app-service.js";

function makeProjection(params: {
  projectionId: string;
  tenantId: string;
  question: string;
  answer: string;
}): QaProjectionRecord {
  return {
    projection_id: params.projectionId,
    tenant_id: params.tenantId,
    question: params.question,
    answer: params.answer,
    status: "validated",
    origin: "manual",
    approved_at: "2026-02-24T00:00:00.000Z",
    updated_at: "2026-02-24T00:00:00.000Z",
  };
}

describe("PipelineAppService", () => {
  it("filters qa list results to the requested tenant", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        records: [
          makeProjection({
            projectionId: "c83e2f7d-75fe-4b24-a5c3-6a17de2f78f1",
            tenantId: "tenant-a",
            question: "Q1",
            answer: "A1",
          }),
          makeProjection({
            projectionId: "d77d4f8e-b813-4e39-9991-e356f72a6b8b",
            tenantId: "tenant-b",
            question: "Q2",
            answer: "A2",
          }),
        ],
        next_cursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        records: [
          makeProjection({
            projectionId: "f489af8e-7f52-4db5-a5f7-6c13b1269f31",
            tenantId: "tenant-a",
            question: "Q3",
            answer: "A3",
          }),
        ],
        next_cursor: null,
      });
    const app = new PipelineAppService(
      {
        state: {} as never,
        handle: vi.fn(),
      },
      {
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        getById: vi.fn(),
      } as never,
      {
        list,
        getById: vi.fn(),
        upsertCurrentAnswer: vi.fn(),
      } as never,
      {
        emitApprovedEvent: vi.fn(),
      },
    );

    const listed = await app.listQa({
      tenantId: "tenant-a",
      limit: 2,
    });

    expect(listed.records).toHaveLength(2);
    expect(listed.records.every((record) => record.tenant_id === "tenant-a")).toBe(true);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("rejects update when projection write returns a different tenant", async () => {
    const app = new PipelineAppService(
      {
        state: {} as never,
        handle: vi.fn(),
      },
      {
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        getById: vi.fn(),
      } as never,
      {
        list: vi.fn(),
        getById: vi.fn(),
        upsertCurrentAnswer: vi.fn(async () =>
          makeProjection({
            projectionId: "91336eff-48ce-4e31-b4f4-dd57af0fef9c",
            tenantId: "tenant-b",
            question: "Q1",
            answer: "A1",
          }),
        ),
      } as never,
      {
        emitApprovedEvent: vi.fn(async () => ({
          traceId: "719f8f3d-c6fd-4da1-bf9d-c4a0ef8f4a15",
          refId: "review-ref-1",
        })),
      },
    );

    await expect(
      app.updateQa({
        tenantId: "tenant-a",
        question: "Q1",
        answer: "A1",
      }),
    ).rejects.toThrow("qa projection tenant mismatch");
  });

  it("enqueues training by chaining import, dataset build, and run start", async () => {
    const handle = vi
      .fn()
      .mockResolvedValueOnce({ status: 202, body: { imported_count: 1 } })
      .mockResolvedValueOnce({
        status: 202,
        body: { dataset_id: "2c2ecf14-e19f-4a7a-98f5-003e80fd8f7f" },
      })
      .mockResolvedValueOnce({
        status: 202,
        body: {
          run_id: "b539e29c-e132-4de3-9c1f-cf66e8158cfd",
          status: "queued",
          attempts: 1,
        },
      });

    const app = new PipelineAppService(
      {
        state: {} as never,
        handle,
      },
      {
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        getById: vi.fn(),
      } as never,
      {
        list: vi.fn(),
        getById: vi.fn(),
        upsertCurrentAnswer: vi.fn(),
      } as never,
      {
        emitApprovedEvent: vi.fn(),
      },
    );

    const result = await app.enqueueTraining({
      tenantId: "tenant-a",
      baseModel: "forge/slm-base",
      idempotencyKey: "key-12345678",
      splitSeed: 9,
    });

    expect(result.dataset_id).toBe("2c2ecf14-e19f-4a7a-98f5-003e80fd8f7f");
    expect(result.run_id).toBe("b539e29c-e132-4de3-9c1f-cf66e8158cfd");
    expect(handle).toHaveBeenCalledTimes(3);
    expect(handle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        path: "/v1/slm/qa-events/import",
      }),
    );
    expect(handle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        path: "/v1/slm/datasets/build",
      }),
    );
    expect(handle).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        path: "/v1/slm/training/runs",
      }),
    );
  });

  it("rejects createQa when category does not exist for tenant", async () => {
    const app = new PipelineAppService(
      {
        state: {} as never,
        handle: vi.fn(),
      },
      {
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        getById: vi.fn(async () => null),
      } as never,
      {
        create: vi.fn(),
      } as never,
      {
        emitApprovedEvent: vi.fn(),
      },
    );

    await expect(
      app.createQa({
        tenantId: "tenant-a",
        question: "Q",
        answer: "A",
        providerKey: "zoom",
        channelKey: "support",
        categoryId: "bf3534bc-f6de-4a38-b506-2edcbf827666",
      }),
    ).rejects.toThrow("category not found");
  });

  it("rejects updateQaById when target category does not exist", async () => {
    const app = new PipelineAppService(
      {
        state: {} as never,
        handle: vi.fn(),
      },
      {
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        getById: vi.fn(async () => null),
      } as never,
      {
        getById: vi.fn(async () =>
          makeProjection({
            projectionId: "9c42f9a2-8eda-4cb4-947a-62eb69f7b742",
            tenantId: "tenant-a",
            question: "Q",
            answer: "A",
          }),
        ),
      } as never,
      {
        emitApprovedEvent: vi.fn(),
      },
    );

    await expect(
      app.updateQaById({
        tenantId: "tenant-a",
        projectionId: "9c42f9a2-8eda-4cb4-947a-62eb69f7b742",
        categoryId: "8ff5af4d-031e-4134-ae86-1525dcbcc0f7",
        answer: "Updated",
      }),
    ).rejects.toThrow("category not found");
  });
});
