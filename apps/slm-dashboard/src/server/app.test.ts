import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlmDashboardApp } from "./app.js";
import { createPasswordHash } from "./password.js";
import type { Clock, DashboardConfig, GatewayMethodClient } from "./types.js";

function buildConfig(overrides: Partial<DashboardConfig> = {}): DashboardConfig {
  return {
    port: 0,
    cookieName: "slm_dashboard_session",
    cookieSecure: false,
    sessionTtlMs: 30 * 60 * 1000,
    gatewayUrl: "ws://127.0.0.1:18789",
    gatewayToken: "token",
    gatewayPassword: undefined,
    gatewayTimeoutMs: 15_000,
    users: [
      {
        username: "operator",
        passwordHash: createPasswordHash("pass123"),
        tenantId: "tenant-a",
      },
    ],
    ...overrides,
  };
}

function createGatewayMock() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const client: GatewayMethodClient = {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      const handler = handlers.get(method);
      if (!handler) {
        throw new Error(`unexpected gateway method: ${method}`);
      }
      return await handler(params);
    }),
  };
  return { client, calls, handlers };
}

async function createHarness(params?: {
  config?: Partial<DashboardConfig>;
  gateway?: ReturnType<typeof createGatewayMock>;
  clock?: Clock;
}) {
  const gateway = params?.gateway ?? createGatewayMock();
  const config = buildConfig(params?.config);
  const clientDir = fileURLToPath(new URL("../client", import.meta.url));
  const { app } = createSlmDashboardApp({
    config,
    gatewayClient: gateway.client,
    clientDir,
    clock: params?.clock,
  });
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  let cookie = "";

  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (cookie) {
      headers.set("cookie", cookie);
    }
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers,
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const next = setCookie.split(";", 1)[0]?.trim() ?? "";
      cookie = next.endsWith("=") ? "" : next;
    }
    return response;
  };

  return {
    request,
    close: async () => {
      server.close();
      await once(server, "close");
    },
    gateway,
  };
}

describe("slm dashboard server", () => {
  const teardown: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (teardown.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await teardown.pop()?.();
    }
  });

  it("requires login for /api/slm routes", async () => {
    const harness = await createHarness();
    teardown.push(harness.close);
    const response = await harness.request("/api/slm/qa");
    expect(response.status).toBe(401);
  });

  it("supports login/logout and session identity endpoint", async () => {
    const harness = await createHarness();
    teardown.push(harness.close);

    const login = await harness.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "operator", password: "pass123" }),
    });
    expect(login.status).toBe(200);

    const me = await harness.request("/api/auth/me");
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({
      ok: true,
      data: {
        username: "operator",
        tenant_id: "tenant-a",
      },
    });

    const logout = await harness.request("/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(logout.status).toBe(200);

    const meAfterLogout = await harness.request("/api/auth/me");
    expect(meAfterLogout.status).toBe(401);
  });

  it("routes BFF operations through slm.control.* with tenant-scoped params", async () => {
    const gateway = createGatewayMock();
    gateway.handlers.set("slm.control.qa.list", async () => ({ records: [], next_cursor: null }));
    gateway.handlers.set("slm.control.session.start", async () => ({
      session: { session_id: "6ab2df52-c6f6-42fc-84d1-a38e29659f03" },
    }));
    gateway.handlers.set("slm.control.session.turn", async () => ({
      session: { session_id: "6ab2df52-c6f6-42fc-84d1-a38e29659f03" },
      turn: { turn_id: "turn-1" },
      supervisor: { final_answer: "answer" },
    }));
    gateway.handlers.set("slm.control.session.finish", async () => ({
      session: { session_id: "6ab2df52-c6f6-42fc-84d1-a38e29659f03", status: "finished" },
    }));
    gateway.handlers.set("slm.control.training.enqueue", async () => ({
      dataset_id: "dataset-1",
      run_id: "run-1",
      status: "queued",
      attempts: 1,
    }));

    const harness = await createHarness({ gateway });
    teardown.push(harness.close);

    await harness.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "operator", password: "pass123" }),
    });

    await harness.request("/api/slm/qa");
    await harness.request("/api/slm/session/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "How do I rotate tokens?" }),
    });
    await harness.request("/api/slm/session/6ab2df52-c6f6-42fc-84d1-a38e29659f03/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_prompt: "Try a short answer." }),
    });
    await harness.request("/api/slm/session/6ab2df52-c6f6-42fc-84d1-a38e29659f03/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await harness.request("/api/slm/training/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_model: "forge/slm-base", split_seed: 7 }),
    });

    expect(gateway.calls.map((call) => call.method)).toEqual([
      "slm.control.qa.list",
      "slm.control.session.start",
      "slm.control.session.turn",
      "slm.control.session.finish",
      "slm.control.training.enqueue",
    ]);
    for (const call of gateway.calls) {
      expect(call.params.tenant_id).toBe("tenant-a");
    }
  });

  it("fills missing question in qa update flow using slm.control.qa.get", async () => {
    const projectionId = "6ab2df52-c6f6-42fc-84d1-a38e29659f03";
    const gateway = createGatewayMock();
    gateway.handlers.set("slm.control.qa.get", async () => ({
      record: {
        projection_id: projectionId,
        question: "How do we deploy safely?",
      },
    }));
    gateway.handlers.set("slm.control.qa.update", async (params) => ({
      record: {
        projection_id: projectionId,
        question: params.question,
        answer: params.answer,
      },
    }));

    const harness = await createHarness({ gateway });
    teardown.push(harness.close);

    await harness.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "operator", password: "pass123" }),
    });

    const update = await harness.request(`/api/slm/qa/${projectionId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "Use staging and smoke tests." }),
    });
    expect(update.status).toBe(200);

    expect(gateway.calls.map((call) => call.method)).toEqual([
      "slm.control.qa.get",
      "slm.control.qa.update",
    ]);
    expect(gateway.calls[1]?.params).toMatchObject({
      tenant_id: "tenant-a",
      question: "How do we deploy safely?",
      answer: "Use staging and smoke tests.",
    });
  });

  it("expires sessions based on configured TTL", async () => {
    let nowMs = 1_735_000_000_000;
    const clock: Clock = { now: () => nowMs };
    const harness = await createHarness({
      config: { sessionTtlMs: 1_000 },
      clock,
    });
    teardown.push(harness.close);

    await harness.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "operator", password: "pass123" }),
    });

    nowMs += 2_000;
    const me = await harness.request("/api/auth/me");
    expect(me.status).toBe(401);
  });

  it("serves standalone dashboard page with all control sections", async () => {
    const harness = await createHarness();
    teardown.push(harness.close);

    const response = await harness.request("/");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Q&amp;A Registry");
    expect(html).toContain("Answer Update / Training");
    expect(html).toContain("Training Studio");
  });
});
