import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { registerSlmSupervisorGatewayMethods } from "./gateway-methods.js";
import type { SlmSupervisorAppService } from "./app-service.js";

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

describe("registerSlmSupervisorGatewayMethods", () => {
  it("registers only slm.control.session.* methods", () => {
    const app = {
      startTrainingSession: vi.fn(),
      runTrainingTurn: vi.fn(),
      finishTrainingSession: vi.fn(),
    } as unknown as SlmSupervisorAppService;
    const { api, handlers } = createApi();

    registerSlmSupervisorGatewayMethods(api, app);

    expect([...handlers.keys()].sort()).toEqual([
      "slm.control.session.finish",
      "slm.control.session.start",
      "slm.control.session.turn",
    ]);
    expect(handlers.has(["slm", "dashboard", "session", "start"].join("."))).toBe(false);
    expect(handlers.has(["slm", "dashboard", "session", "turn"].join("."))).toBe(false);
    expect(handlers.has(["slm", "dashboard", "session", "finish"].join("."))).toBe(false);
  });

  it("forwards valid session start requests", async () => {
    const app = {
      startTrainingSession: vi.fn(async () => ({
        session_id: "6ab2df52-c6f6-42fc-84d1-a38e29659f03",
      })),
      runTrainingTurn: vi.fn(),
      finishTrainingSession: vi.fn(),
    } as unknown as SlmSupervisorAppService;
    const { api, handlers } = createApi();
    registerSlmSupervisorGatewayMethods(api, app);

    const respond = vi.fn();
    await handlers.get("slm.control.session.start")?.({
      params: {
        tenant_id: "tenant-a",
        question: "How do we reset API tokens?",
      },
      respond,
    });

    expect(app.startTrainingSession).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      question: "How do we reset API tokens?",
      traceId: undefined,
      reviewRefId: undefined,
      actor: undefined,
    });
    expect(respond).toHaveBeenCalledWith(true, {
      session: { session_id: "6ab2df52-c6f6-42fc-84d1-a38e29659f03" },
    });
  });

  it("returns validation errors for malformed session turn params", async () => {
    const app = {
      startTrainingSession: vi.fn(),
      runTrainingTurn: vi.fn(),
      finishTrainingSession: vi.fn(),
    } as unknown as SlmSupervisorAppService;
    const { api, handlers } = createApi();
    registerSlmSupervisorGatewayMethods(api, app);

    const respond = vi.fn();
    await handlers.get("slm.control.session.turn")?.({
      params: {
        tenant_id: "tenant-a",
        session_id: "not-a-uuid",
        user_prompt: "",
      },
      respond,
    });

    expect(app.runTrainingTurn).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      error: expect.stringContaining("session_id"),
    });
  });
});
