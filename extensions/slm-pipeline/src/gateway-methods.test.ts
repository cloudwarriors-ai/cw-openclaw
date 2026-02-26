import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { registerSlmPipelineGatewayMethods } from "./gateway-methods.js";
import type { PipelineAppService } from "./app-service.js";

type RegisteredHandler = (context: {
  params?: unknown;
  client?: { connect?: unknown };
  respond: (ok: boolean, payload: unknown) => void;
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

describe("registerSlmPipelineGatewayMethods", () => {
  it("registers only slm.control.* methods", () => {
    const app = {
      listQa: vi.fn(),
      getQa: vi.fn(),
      updateQa: vi.fn(),
      enqueueTraining: vi.fn(),
    } as unknown as PipelineAppService;
    const { api, handlers } = createApi();

    registerSlmPipelineGatewayMethods(api, app);

    expect([...handlers.keys()].sort()).toEqual([
      "slm.control.qa.get",
      "slm.control.qa.list",
      "slm.control.qa.update",
      "slm.control.training.enqueue",
    ]);
    expect(handlers.has(["slm", "dashboard", "qa", "list"].join("."))).toBe(false);
    expect(handlers.has(["slm", "dashboard", "qa", "get"].join("."))).toBe(false);
    expect(handlers.has(["slm", "dashboard", "qa", "update"].join("."))).toBe(false);
    expect(handlers.has(["slm", "dashboard", "training", "enqueue"].join("."))).toBe(false);
  });

  it("forwards valid qa list requests to the app service", async () => {
    const app = {
      listQa: vi.fn(async () => ({ records: [], next_cursor: null })),
      getQa: vi.fn(),
      updateQa: vi.fn(),
      enqueueTraining: vi.fn(),
    } as unknown as PipelineAppService;
    const { api, handlers } = createApi();
    registerSlmPipelineGatewayMethods(api, app);

    const handler = handlers.get("slm.control.qa.list");
    expect(handler).toBeTruthy();

    const respond = vi.fn();
    await handler?.({
      params: {
        tenant_id: "tenant-a",
        limit: 25,
      },
      respond,
    });

    expect(app.listQa).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      cursor: undefined,
      limit: 25,
      query: undefined,
    });
    expect(respond).toHaveBeenCalledWith(true, { records: [], next_cursor: null });
  });

  it("returns validation errors for malformed params", async () => {
    const app = {
      listQa: vi.fn(),
      getQa: vi.fn(),
      updateQa: vi.fn(),
      enqueueTraining: vi.fn(),
    } as unknown as PipelineAppService;
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
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      error: expect.stringContaining("tenant_id"),
    });
  });
});
