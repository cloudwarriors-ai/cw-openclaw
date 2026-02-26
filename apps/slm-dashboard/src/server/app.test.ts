import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
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
        role: "operator",
      },
    ],
    ...overrides,
  };
}

function createGatewayMock() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const request: GatewayMethodClient["request"] = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => {
    calls.push({ method, params });
    const handler = handlers.get(method);
    if (!handler) {
      throw new Error(`unexpected gateway method: ${method}`);
    }
    return (await handler(params)) as T;
  };
  const client: GatewayMethodClient = {
    request: vi.fn(request) as GatewayMethodClient["request"],
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

async function loginAs(harness: Awaited<ReturnType<typeof createHarness>>, username = "operator") {
  const login = await harness.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "pass123" }),
  });
  expect(login.status).toBe(200);
  return login;
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

  it("supports login/logout and includes role in identity", async () => {
    const harness = await createHarness({
      config: {
        users: [
          {
            username: "trainer",
            passwordHash: createPasswordHash("pass123"),
            tenantId: "tenant-a",
            role: "trainer",
          },
        ],
      },
    });
    teardown.push(harness.close);

    const login = await loginAs(harness, "trainer");
    await expect(login.json()).resolves.toMatchObject({
      ok: true,
      data: {
        username: "trainer",
        tenant_id: "tenant-a",
        role: "trainer",
      },
    });

    const me = await harness.request("/api/auth/me");
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({
      ok: true,
      data: {
        username: "trainer",
        tenant_id: "tenant-a",
        role: "trainer",
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

  it("passes extended QA list filters and keeps session practice lane available to operators", async () => {
    const sessionId = "6ab2df52-c6f6-42fc-84d1-a38e29659f03";
    const categoryId = "7fb67f70-08a7-4c63-a3f3-2d22be66c4b8";
    const gateway = createGatewayMock();
    gateway.handlers.set("slm.control.qa.list", async () => ({ records: [], next_cursor: null }));
    gateway.handlers.set("slm.control.session.start", async () => ({ session: { session_id: sessionId } }));
    gateway.handlers.set("slm.control.session.turn", async () => ({
      session: { session_id: sessionId },
      turn: { turn_id: "turn-1" },
      supervisor: { final_answer: "answer" },
    }));
    gateway.handlers.set("slm.control.session.finish", async () => ({
      session: { session_id: sessionId, status: "finished" },
    }));

    const harness = await createHarness({ gateway });
    teardown.push(harness.close);

    await loginAs(harness);

    const listed = await harness.request(
      `/api/slm/qa?provider_key=zoom&channel_key=support&category_id=${categoryId}&status=validated&query=token&cursor=abc&limit=25`,
    );
    expect(listed.status).toBe(200);

    const started = await harness.request("/api/slm/session/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "How do I rotate tokens?" }),
    });
    expect(started.status).toBe(200);

    const turned = await harness.request(`/api/slm/session/${sessionId}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_prompt: "Try a short answer." }),
    });
    expect(turned.status).toBe(200);

    const finished = await harness.request(`/api/slm/session/${sessionId}/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(finished.status).toBe(200);

    expect(gateway.calls.map((call) => call.method)).toEqual([
      "slm.control.qa.list",
      "slm.control.session.start",
      "slm.control.session.turn",
      "slm.control.session.finish",
    ]);
    expect(gateway.calls[0]?.params).toMatchObject({
      tenant_id: "tenant-a",
      provider_key: "zoom",
      channel_key: "support",
      category_id: categoryId,
      status: "validated",
      query: "token",
      cursor: "abc",
      limit: 25,
    });
  });

  it("blocks factory actions for operator role", async () => {
    const projectionId = "6ab2df52-c6f6-42fc-84d1-a38e29659f03";
    const categoryId = "7fb67f70-08a7-4c63-a3f3-2d22be66c4b8";
    const gateway = createGatewayMock();
    gateway.handlers.set("slm.control.session.start", async () => ({ session: { session_id: projectionId } }));

    const harness = await createHarness({ gateway });
    teardown.push(harness.close);

    await loginAs(harness);

    const createCategory = await harness.request("/api/slm/categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_key: "zoom",
        channel_key: "support",
        category_key: "security",
        display_name: "Security",
      }),
    });
    expect(createCategory.status).toBe(403);

    const updateCategory = await harness.request("/api/slm/categories", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category_id: categoryId, display_name: "Security Ops" }),
    });
    expect(updateCategory.status).toBe(403);

    const createQa = await harness.request("/api/slm/qa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "Q",
        answer: "A",
        provider_key: "zoom",
        channel_key: "support",
        category_id: categoryId,
      }),
    });
    expect(createQa.status).toBe(403);

    const updateQa = await harness.request("/api/slm/qa", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projection_id: projectionId, answer: "Updated" }),
    });
    expect(updateQa.status).toBe(403);

    const legacyUpdate = await harness.request(`/api/slm/qa/${projectionId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "Legacy update" }),
    });
    expect(legacyUpdate.status).toBe(403);

    const enqueue = await harness.request("/api/slm/training/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_model: "forge/slm-base" }),
    });
    expect(enqueue.status).toBe(403);

    const sessionStart = await harness.request("/api/slm/session/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Practice question" }),
    });
    expect(sessionStart.status).toBe(200);

    expect(gateway.calls.map((call) => call.method)).toEqual(["slm.control.session.start"]);
  });

  it("supports category and QA CRUD endpoints for trainer role", async () => {
    const projectionId = "6ab2df52-c6f6-42fc-84d1-a38e29659f03";
    const categoryId = "7fb67f70-08a7-4c63-a3f3-2d22be66c4b8";
    const gateway = createGatewayMock();
    gateway.handlers.set("slm.control.category.list", async () => ({ records: [], next_cursor: null }));
    gateway.handlers.set("slm.control.category.create", async (params) => ({ record: params }));
    gateway.handlers.set("slm.control.category.update", async (params) => ({ record: params }));
    gateway.handlers.set("slm.control.qa.create", async (params) => ({ record: params }));
    gateway.handlers.set("slm.control.qa.updateById", async (params) => ({ record: params }));
    gateway.handlers.set("slm.control.qa.get", async () => ({
      record: {
        projection_id: projectionId,
        question: "How do we deploy safely?",
      },
    }));
    gateway.handlers.set("slm.control.qa.update", async (params) => ({ record: params }));
    gateway.handlers.set("slm.control.training.enqueue", async (params) => ({
      dataset_id: "dataset-1",
      run_id: "run-1",
      status: "queued",
      attempts: 1,
      ...params,
    }));

    const harness = await createHarness({
      gateway,
      config: {
        users: [
          {
            username: "trainer",
            passwordHash: createPasswordHash("pass123"),
            tenantId: "tenant-a",
            role: "trainer",
          },
        ],
      },
    });
    teardown.push(harness.close);

    await loginAs(harness, "trainer");

    const listCategories = await harness.request(
      "/api/slm/categories?provider_key=zoom&channel_key=support&include_inactive=true&cursor=n1&limit=8",
    );
    expect(listCategories.status).toBe(200);

    const createCategory = await harness.request("/api/slm/categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_key: "zoom",
        channel_key: "support",
        category_key: "security",
        display_name: "Security",
        sort_order: 2,
      }),
    });
    expect(createCategory.status).toBe(200);

    const updateCategory = await harness.request("/api/slm/categories", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category_id: categoryId,
        display_name: "Security Ops",
        sort_order: 3,
      }),
    });
    expect(updateCategory.status).toBe(200);

    const updateCategoryByPath = await harness.request(`/api/slm/categories/${categoryId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        display_name: "Security Ops v2",
      }),
    });
    expect(updateCategoryByPath.status).toBe(200);

    const createQa = await harness.request("/api/slm/qa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "How do we ship safely?",
        answer: "Use canaries.",
        provider_key: "zoom",
        channel_key: "support",
        category_id: categoryId,
        status: "validated",
        origin: "manual",
      }),
    });
    expect(createQa.status).toBe(200);

    const updateQa = await harness.request("/api/slm/qa", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projection_id: projectionId,
        answer: "Use staging and smoke tests.",
        category_id: categoryId,
        status: "validated",
      }),
    });
    expect(updateQa.status).toBe(200);

    const legacyUpdate = await harness.request(`/api/slm/qa/${projectionId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "Use staging and smoke tests." }),
    });
    expect(legacyUpdate.status).toBe(200);

    const enqueue = await harness.request("/api/slm/training/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        base_model: "forge/slm-base",
        source: "library",
        provider_key: "zoom",
        channel_key: "support",
        category_id: categoryId,
        status: "validated",
        split_seed: 7,
      }),
    });
    expect(enqueue.status).toBe(200);

    expect(gateway.calls.map((call) => call.method)).toEqual([
      "slm.control.category.list",
      "slm.control.category.create",
      "slm.control.category.update",
      "slm.control.category.update",
      "slm.control.qa.create",
      "slm.control.qa.updateById",
      "slm.control.qa.get",
      "slm.control.qa.update",
      "slm.control.training.enqueue",
    ]);

    expect(gateway.calls[0]?.params).toMatchObject({
      tenant_id: "tenant-a",
      provider_key: "zoom",
      channel_key: "support",
      include_inactive: true,
      cursor: "n1",
      limit: 8,
    });
    expect(gateway.calls[8]?.params).toMatchObject({
      tenant_id: "tenant-a",
      source: "library",
      provider_key: "zoom",
      channel_key: "support",
      category_id: categoryId,
      status: "validated",
      split_seed: 7,
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

    await loginAs(harness);

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
    expect(html).toContain("Q&amp;A Library");
    expect(html).toContain("Category Manager");
    expect(html).toContain("Training Studio");
  });
});
