import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { registerSlmPipelineGatewayMethods } from "./gateway-methods.js";
import type { PipelineAppService } from "./app-service.js";

type RegisteredHandler = (context: {
  params?: unknown;
  client?: { connect?: unknown };
  respond: (
    ok: boolean,
    payload?: unknown,
    error?: { code: string; message: string },
  ) => void;
}) => Promise<void>;

function createApi() {
  const handlers = new Map<string, RegisteredHandler>();
  const api = {
    registerGatewayMethod(method: string, handler: RegisteredHandler) {
      handlers.set(method, handler);
    },
  } as unknown as OpenClawPluginApi;
  return { api, handlers };
}

function createAppMock(): PipelineAppService {
  return {
    listCategories: vi.fn(async () => ({ records: [], next_cursor: null })),
    createCategory: vi.fn(async () => ({
      category_id: "30fbbf15-4f3f-4ba9-b8f3-d77e00fef3b2",
      tenant_id: "tenant-a",
      provider_key: "zoom",
      channel_key: "phone",
      category_key: "billing",
      display_name: "Billing",
      is_active: true,
      sort_order: 1,
      created_at: "2026-02-25T00:00:00.000Z",
      updated_at: "2026-02-25T00:00:00.000Z",
    })),
    updateCategory: vi.fn(async () => null),
    listQa: vi.fn(async () => ({ records: [], next_cursor: null })),
    getQa: vi.fn(async () => null),
    createQa: vi.fn(async () => ({
      projection_id: "56a6a4a7-b7c7-4f64-b2c6-5d741f6e1ef6",
      tenant_id: "tenant-a",
      question: "Q",
      answer: "A",
      status: "draft",
      origin: "manual",
      approved_at: "2026-02-25T00:00:00.000Z",
      updated_at: "2026-02-25T00:00:00.000Z",
    })),
    updateQa: vi.fn(async () => ({
      projection_id: "56a6a4a7-b7c7-4f64-b2c6-5d741f6e1ef6",
      tenant_id: "tenant-a",
      question: "Q",
      answer: "A",
      status: "validated",
      origin: "import",
      approved_at: "2026-02-25T00:00:00.000Z",
      updated_at: "2026-02-25T00:00:00.000Z",
    })),
    updateQaById: vi.fn(async () => null),
    enqueueTraining: vi.fn(async () => ({
      dataset_id: "c58f8937-0ae9-410e-8d0d-d674b3f2f866",
      run_id: "75f30f85-d09a-4404-9eeb-dd891266c20f",
      status: "queued",
      attempts: 1,
    })),
  } as unknown as PipelineAppService;
}

describe("registerSlmPipelineGatewayMethods", () => {
  it("registers slm.control category, qa, and training methods", () => {
    const app = createAppMock();
    const { api, handlers } = createApi();

    registerSlmPipelineGatewayMethods(api, app);

    expect([...handlers.keys()].sort()).toEqual([
      "slm.control.category.create",
      "slm.control.category.list",
      "slm.control.category.update",
      "slm.control.qa.create",
      "slm.control.qa.get",
      "slm.control.qa.list",
      "slm.control.qa.update",
      "slm.control.qa.updateById",
      "slm.control.training.enqueue",
    ]);
  });

  it("forwards category create payload to app service", async () => {
    const app = createAppMock();
    const { api, handlers } = createApi();
    registerSlmPipelineGatewayMethods(api, app);

    const handler = handlers.get("slm.control.category.create");
    expect(handler).toBeTruthy();

    const respond = vi.fn();
    await handler?.({
      params: {
        tenant_id: "tenant-a",
        provider_key: "zoom",
        channel_key: "phone",
        category_key: "billing",
        display_name: "Billing",
      },
      respond,
    });

    expect(app.createCategory).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      providerKey: "zoom",
      channelKey: "phone",
      categoryKey: "billing",
      displayName: "Billing",
      sortOrder: undefined,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        record: expect.objectContaining({ category_key: "billing" }),
      }),
    );
  });

  it("returns validation errors for malformed params", async () => {
    const app = createAppMock();
    const { api, handlers } = createApi();
    registerSlmPipelineGatewayMethods(api, app);

    const respond = vi.fn();
    await handlers.get("slm.control.training.enqueue")?.({
      params: { tenant_id: "", base_model: "" },
      respond,
    });

    expect(app.enqueueTraining).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[1]).toBeUndefined();
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("tenant_id"),
    });
  });

  it("returns not-found when updateById target is missing", async () => {
    const app = createAppMock();
    const { api, handlers } = createApi();
    registerSlmPipelineGatewayMethods(api, app);

    const respond = vi.fn();
    await handlers.get("slm.control.qa.updateById")?.({
      params: {
        tenant_id: "tenant-a",
        projection_id: "56a6a4a7-b7c7-4f64-b2c6-5d741f6e1ef6",
        answer: "Updated",
      },
      respond,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "not_found", message: "qa record not found" }),
    );
  });

  it("rejects qa.updateById payloads without mutable fields", async () => {
    const app = createAppMock();
    const { api, handlers } = createApi();
    registerSlmPipelineGatewayMethods(api, app);

    const respond = vi.fn();
    await handlers.get("slm.control.qa.updateById")?.({
      params: {
        tenant_id: "tenant-a",
        projection_id: "56a6a4a7-b7c7-4f64-b2c6-5d741f6e1ef6",
      },
      respond,
    });

    expect(app.updateQaById).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "invalid_request",
        message: expect.stringContaining("at least one QA field"),
      }),
    );
  });
});
