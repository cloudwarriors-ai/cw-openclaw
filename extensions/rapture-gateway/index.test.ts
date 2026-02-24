import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, { __setRaptureGatewayOrgProvisionerForTests } from "./index.js";

type RegisteredTool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

function fakeToolContext(
  overrides?: Partial<OpenClawPluginToolContext>,
): OpenClawPluginToolContext {
  return {
    config: {},
    workspaceDir: "/tmp",
    agentDir: "/tmp",
    agentId: "main",
    sessionKey: "main",
    messageChannel: undefined,
    agentAccountId: undefined,
    senderId: undefined,
    senderName: undefined,
    senderUsername: undefined,
    senderEmail: undefined,
    senderE164: undefined,
    sandboxed: false,
    ...overrides,
  };
}

function registerTools(
  contextOverrides?: Partial<OpenClawPluginToolContext>,
): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const api = {
    id: "rapture-gateway",
    name: "rapture-gateway",
    source: "test",
    config: {},
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool(tool) {
      if (typeof tool === "function") {
        const resolved = tool(fakeToolContext(contextOverrides));
        if (resolved) {
          tools.set(resolved.name, resolved as RegisteredTool);
        }
        return;
      }
      tools.set(tool.name, tool as RegisteredTool);
    },
    on() {},
    registerHook() {},
    registerHttpHandler() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    resolvePath: (input: string) => input,
  } satisfies OpenClawPluginApi;

  plugin.register?.(api);
  return tools;
}

function parseToolJson(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  const text = result.content[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("rapture-gateway plugin tools", () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;
  const envSnapshot = {
    RAPTURE_API_URL: process.env.RAPTURE_API_URL,
    RAPTURE_USERNAME: process.env.RAPTURE_USERNAME,
    RAPTURE_PASSWORD: process.env.RAPTURE_PASSWORD,
    RAPTURE_FRONTEND_USERNAME: process.env.RAPTURE_FRONTEND_USERNAME,
    RAPTURE_FRONTEND_PASSWORD: process.env.RAPTURE_FRONTEND_PASSWORD,
    RAPTURE_FRONTEND_BEARER_TOKEN: process.env.RAPTURE_FRONTEND_BEARER_TOKEN,
    RAPTURE_GROUP_ID: process.env.RAPTURE_GROUP_ID,
    RAPTURE_JOBS_STATUS_URL: process.env.RAPTURE_JOBS_STATUS_URL,
    RAPTURE_TENANT_NAME: process.env.RAPTURE_TENANT_NAME,
    RAPTURE_ALLOWED_TENANTS: process.env.RAPTURE_ALLOWED_TENANTS,
    RAPTURE_ALLOWED_ORG_DOMAINS: process.env.RAPTURE_ALLOWED_ORG_DOMAINS,
    RAPTURE_ALLOWED_ORG_EMAILS: process.env.RAPTURE_ALLOWED_ORG_EMAILS,
    RAPTURE_ORG_AUTH_ENABLED: process.env.RAPTURE_ORG_AUTH_ENABLED,
    RAPTURE_ENFORCE_ORG_EMAIL: process.env.RAPTURE_ENFORCE_ORG_EMAIL,
    RAPTURE_ORG_EMAIL_ENFORCED_CHANNELS: process.env.RAPTURE_ORG_EMAIL_ENFORCED_CHANNELS,
    RAPTURE_FRONTEND_URL: process.env.RAPTURE_FRONTEND_URL,
    RAPTURE_FRONTEND_SESSION_COOKIE: process.env.RAPTURE_FRONTEND_SESSION_COOKIE,
    RAPTURE_GATEWAY_REDIS_URL: process.env.RAPTURE_GATEWAY_REDIS_URL,
    RAPTURE_ZOOM_GATEWAY_URL: process.env.RAPTURE_ZOOM_GATEWAY_URL,
  };

  beforeEach(() => {
    fetchMock.mockReset();
    // oxlint-disable-next-line no-global-assign
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    process.env.RAPTURE_API_URL = envSnapshot.RAPTURE_API_URL;
    process.env.RAPTURE_USERNAME = envSnapshot.RAPTURE_USERNAME;
    process.env.RAPTURE_PASSWORD = envSnapshot.RAPTURE_PASSWORD;
    process.env.RAPTURE_FRONTEND_USERNAME = envSnapshot.RAPTURE_FRONTEND_USERNAME;
    process.env.RAPTURE_FRONTEND_PASSWORD = envSnapshot.RAPTURE_FRONTEND_PASSWORD;
    process.env.RAPTURE_FRONTEND_BEARER_TOKEN = envSnapshot.RAPTURE_FRONTEND_BEARER_TOKEN;
    process.env.RAPTURE_GROUP_ID = envSnapshot.RAPTURE_GROUP_ID;
    process.env.RAPTURE_JOBS_STATUS_URL = envSnapshot.RAPTURE_JOBS_STATUS_URL;
    process.env.RAPTURE_TENANT_NAME = envSnapshot.RAPTURE_TENANT_NAME;
    process.env.RAPTURE_ALLOWED_TENANTS = envSnapshot.RAPTURE_ALLOWED_TENANTS;
    process.env.RAPTURE_ALLOWED_ORG_DOMAINS = envSnapshot.RAPTURE_ALLOWED_ORG_DOMAINS;
    process.env.RAPTURE_ALLOWED_ORG_EMAILS = envSnapshot.RAPTURE_ALLOWED_ORG_EMAILS;
    process.env.RAPTURE_ORG_AUTH_ENABLED = envSnapshot.RAPTURE_ORG_AUTH_ENABLED;
    process.env.RAPTURE_ENFORCE_ORG_EMAIL = envSnapshot.RAPTURE_ENFORCE_ORG_EMAIL;
    process.env.RAPTURE_ORG_EMAIL_ENFORCED_CHANNELS =
      envSnapshot.RAPTURE_ORG_EMAIL_ENFORCED_CHANNELS;
    process.env.RAPTURE_FRONTEND_URL = envSnapshot.RAPTURE_FRONTEND_URL;
    process.env.RAPTURE_FRONTEND_SESSION_COOKIE = envSnapshot.RAPTURE_FRONTEND_SESSION_COOKIE;
    process.env.RAPTURE_GATEWAY_REDIS_URL = envSnapshot.RAPTURE_GATEWAY_REDIS_URL;
    process.env.RAPTURE_ZOOM_GATEWAY_URL = envSnapshot.RAPTURE_ZOOM_GATEWAY_URL;
    __setRaptureGatewayOrgProvisionerForTests(undefined);
  });

  afterAll(() => {
    // oxlint-disable-next-line no-global-assign
    globalThis.fetch = originalFetch;
  });

  it("filters request_id across user_jobs and group_jobs", async () => {
    process.env.RAPTURE_JOBS_STATUS_URL = "https://jobs.example.com/status";

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user_jobs: [{ job_id: "job-user-1", status: "running" }],
          group_jobs: [{ request_id: "req-123", status: "completed" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const tools = registerTools();
    const getJobsStatus = tools.get("rapture_get_jobs_status");
    expect(getJobsStatus).toBeDefined();

    const result = await getJobsStatus!.execute("call-1", { request_id: "req-123" });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(true);
    expect(payload.request_id).toBe("req-123");
    expect(payload.counts).toMatchObject({
      user_jobs_filtered: 0,
      group_jobs_filtered: 1,
    });
    expect(payload.group_jobs).toEqual([{ request_id: "req-123", status: "completed" }]);
    expect(payload.user_jobs).toEqual([]);
    expect(payload.counts).toMatchObject({
      by_status: { completed: 1 },
    });
  });

  it("uses RAPTURE_GROUP_ID as default workflow group_id", async () => {
    process.env.RAPTURE_API_URL = "https://rapture.example.com";
    process.env.RAPTURE_USERNAME = "test-user";
    process.env.RAPTURE_PASSWORD = "test-pass";
    process.env.RAPTURE_GROUP_ID = "42";

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: "token-abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tools = registerTools();
    const submitWorkflow = tools.get("rapture_submit_workflow");
    expect(submitWorkflow).toBeDefined();

    await submitWorkflow!.execute("call-2", {
      workflow_name: "create_user",
      platform: "zoom",
      sequence_data_json: JSON.stringify([{ step: "create" }]),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const submitCall = fetchMock.mock.calls[1];
    const submitInit = submitCall?.[1] as RequestInit | undefined;
    expect(submitInit?.method).toBe("POST");
    const bodyRaw = submitInit?.body;
    const bodyText =
      typeof bodyRaw === "string" ? bodyRaw : bodyRaw instanceof URLSearchParams ? bodyRaw.toString() : "{}";
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    expect(body.group_id).toBe("42");
  });

  it("rejects gateway tenant overrides outside RAPTURE_ALLOWED_TENANTS", async () => {
    process.env.RAPTURE_TENANT_NAME = "cloudwarriors";
    process.env.RAPTURE_ALLOWED_TENANTS = "cloudwarriors";

    const tools = registerTools();
    const connect = tools.get("rapture_gateway_connect");
    expect(connect).toBeDefined();

    const result = await connect!.execute("call-3", {
      gateway: "zoom",
      tenant: "other-tenant",
    });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(false);
    expect(String(payload.error)).toContain("is not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries connect after org provisioning when provider is missing", async () => {
    __setRaptureGatewayOrgProvisionerForTests(async () => true);
    process.env.RAPTURE_ZOOM_GATEWAY_URL = "https://zoom-gateway.example.com";

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Provider 'zoom' not found for tenant=cloudwarriors" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { session_id: "sess-abc" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tools = registerTools();
    const connect = tools.get("rapture_gateway_connect");
    expect(connect).toBeDefined();

    const result = await connect!.execute("call-4", { gateway: "zoom", force_reconnect: true });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(true);
    expect(payload.session_id).toBe("sess-abc");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a clear error when provider is missing and org provisioning is unavailable", async () => {
    __setRaptureGatewayOrgProvisionerForTests(async () => false);
    process.env.RAPTURE_ZOOM_GATEWAY_URL = "https://zoom-gateway.example.com";

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Provider 'zoom' not found for tenant=cloudwarriors" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    const tools = registerTools();
    const connect = tools.get("rapture_gateway_connect");
    expect(connect).toBeDefined();

    const result = await connect!.execute("call-5", { gateway: "zoom", force_reconnect: true });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(false);
    expect(String(payload.error)).toContain("Provider 'zoom' not found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("denies zoom credential tools when requester email is outside the org", async () => {
    process.env.RAPTURE_ZOOM_GATEWAY_URL = "https://zoom-gateway.example.com";
    process.env.RAPTURE_ALLOWED_ORG_DOMAINS = "cloudwarriors.ai";
    process.env.RAPTURE_ORG_EMAIL_ENFORCED_CHANNELS = "zoom";
    process.env.RAPTURE_ENFORCE_ORG_EMAIL = "true";

    const tools = registerTools({
      messageChannel: "zoom",
      senderEmail: "blocked@example.com",
    });
    const connect = tools.get("rapture_gateway_connect");
    expect(connect).toBeDefined();

    const result = await connect!.execute("call-6", { gateway: "zoom" });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(false);
    expect(String(payload.error)).toContain("not authorized");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows senderUsername fallback when it looks like an email", async () => {
    process.env.RAPTURE_ZOOM_GATEWAY_URL = "https://zoom-gateway.example.com";
    process.env.RAPTURE_ALLOWED_ORG_DOMAINS = "cloudwarriors.ai";
    process.env.RAPTURE_ORG_EMAIL_ENFORCED_CHANNELS = "zoom";
    process.env.RAPTURE_ENFORCE_ORG_EMAIL = "true";
    __setRaptureGatewayOrgProvisionerForTests(async () => ({
      provisioned: true,
      credentialId: "cred-username-fallback",
    }));

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { session_id: "sess-username-fallback" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tools = registerTools({
      messageChannel: "zoom",
      senderUsername: "trent.charlton@cloudwarriors.ai",
      senderEmail: undefined,
    });
    const connect = tools.get("rapture_gateway_connect");
    expect(connect).toBeDefined();

    const result = await connect!.execute("call-6b", { gateway: "zoom", force_reconnect: true });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(true);
    expect(payload.session_id).toBe("sess-username-fallback");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not enforce org email on webchat channel by default", async () => {
    process.env.RAPTURE_ZOOM_GATEWAY_URL = "https://zoom-gateway.example.com";
    process.env.RAPTURE_ALLOWED_ORG_DOMAINS = "cloudwarriors.ai";
    process.env.RAPTURE_ORG_EMAIL_ENFORCED_CHANNELS = "zoom";
    process.env.RAPTURE_ENFORCE_ORG_EMAIL = "true";

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { session_id: "sess-webchat" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tools = registerTools({
      messageChannel: "webchat",
      senderUsername: undefined,
      senderEmail: undefined,
    });
    const connect = tools.get("rapture_gateway_connect");
    expect(connect).toBeDefined();

    const result = await connect!.execute("call-6c", { gateway: "zoom", force_reconnect: true });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(true);
    expect(payload.session_id).toBe("sess-webchat");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows zoom credential tools for org email", async () => {
    process.env.RAPTURE_ZOOM_GATEWAY_URL = "https://zoom-gateway.example.com";
    process.env.RAPTURE_ALLOWED_ORG_DOMAINS = "cloudwarriors.ai";
    process.env.RAPTURE_ORG_EMAIL_ENFORCED_CHANNELS = "zoom";
    process.env.RAPTURE_ENFORCE_ORG_EMAIL = "true";
    __setRaptureGatewayOrgProvisionerForTests(async () => ({
      provisioned: true,
      credentialId: "cred-allowed",
    }));

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { session_id: "sess-allowed" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tools = registerTools({
      messageChannel: "zoom",
      senderEmail: "trent.charlton@cloudwarriors.ai",
    });
    const connect = tools.get("rapture_gateway_connect");
    expect(connect).toBeDefined();

    const result = await connect!.execute("call-7", { gateway: "zoom", force_reconnect: true });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(true);
    expect(payload.credential_id).toBe("cred-allowed");
    expect(payload.session_id).toBe("sess-allowed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires credential selection when multiple org accounts exist for a platform", async () => {
    process.env.RAPTURE_ZOOM_GATEWAY_URL = "https://zoom-gateway.example.com";
    process.env.RAPTURE_FRONTEND_URL = "https://rapture.example.com";
    process.env.RAPTURE_FRONTEND_SESSION_COOKIE = "sessionid=test";
    process.env.RAPTURE_ALLOWED_ORG_DOMAINS = "cloudwarriors.ai";
    process.env.RAPTURE_ORG_EMAIL_ENFORCED_CHANNELS = "zoom";
    process.env.RAPTURE_ENFORCE_ORG_EMAIL = "true";

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          credentials: [
            { id: "cred-1", account_label: "Primary", account_id: "acct-1" },
            { id: "cred-2", account_label: "Secondary", account_id: "acct-2" },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const tools = registerTools({
      messageChannel: "zoom",
      senderEmail: "trent.charlton@cloudwarriors.ai",
    });
    const connect = tools.get("rapture_gateway_connect");
    expect(connect).toBeDefined();

    const result = await connect!.execute("call-8", { gateway: "zoom", force_reconnect: true });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(false);
    expect(String(payload.error)).toContain("Multiple active zoom credentials");
    expect(String(payload.error)).toContain("credential_id");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/credentials/");
  });

  it("logs into frontend with env credentials when no cookie or bearer is configured", async () => {
    process.env.RAPTURE_ZOOM_GATEWAY_URL = "https://zoom-gateway.example.com";
    process.env.RAPTURE_FRONTEND_URL = "http://localhost:8199";
    process.env.RAPTURE_FRONTEND_SESSION_COOKIE = "";
    process.env.RAPTURE_FRONTEND_BEARER_TOKEN = "";
    process.env.RAPTURE_FRONTEND_USERNAME = "trent.charlton@cloudwarriors.ai";
    process.env.RAPTURE_FRONTEND_PASSWORD = "pw-test";
    process.env.RAPTURE_ALLOWED_ORG_DOMAINS = "cloudwarriors.ai";
    process.env.RAPTURE_ORG_EMAIL_ENFORCED_CHANNELS = "zoom";
    process.env.RAPTURE_ENFORCE_ORG_EMAIL = "true";

    fetchMock.mockResolvedValueOnce(
      new Response(
        '<form method="POST"><input type="hidden" name="csrfmiddlewaretoken" value="csrf-html" /></form>',
        {
          status: 200,
          headers: {
            "content-type": "text/html",
            "set-cookie": "csrftoken=csrf-cookie; Path=/; SameSite=Lax",
          },
        },
      ),
    );
    fetchMock.mockResolvedValueOnce(
      new Response("redirect", {
        status: 302,
        headers: {
          location: "/dashboard/",
          "set-cookie":
            "sessionid=sess-login; Path=/; HttpOnly; SameSite=Lax, csrftoken=csrf-after; Path=/; SameSite=Lax",
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          credentials: [
            { id: "cred-1", account_label: "Primary", account_id: "acct-1" },
            { id: "cred-2", account_label: "Secondary", account_id: "acct-2" },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const tools = registerTools({
      messageChannel: "zoom",
      senderEmail: "trent.charlton@cloudwarriors.ai",
    });
    const connect = tools.get("rapture_gateway_connect");
    expect(connect).toBeDefined();

    const result = await connect!.execute("call-9-login", {
      gateway: "zoom",
      force_reconnect: true,
    });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(false);
    expect(String(payload.error)).toContain("Multiple active zoom credentials");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("http://localhost:8199/accounts/login/");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("http://localhost:8199/accounts/login/");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/api/credentials/");
    const postInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    const postBodyRaw = postInit?.body;
    const postBody =
      typeof postBodyRaw === "string"
        ? postBodyRaw
        : postBodyRaw instanceof URLSearchParams
          ? postBodyRaw.toString()
          : "";
    expect(postBody).toContain("login=trent.charlton%40cloudwarriors.ai");
    expect(postBody).toContain("password=pw-test");
    const listInit = fetchMock.mock.calls[2]?.[1] as RequestInit | undefined;
    const listHeaders = (listInit?.headers ?? {}) as Record<string, string>;
    expect(String(listHeaders.cookie)).toContain("sessionid=sess-login");
  });

  it("passes explicit credential selection through org provisioning flow", async () => {
    process.env.RAPTURE_ZOOM_GATEWAY_URL = "https://zoom-gateway.example.com";
    process.env.RAPTURE_ALLOWED_ORG_DOMAINS = "cloudwarriors.ai";
    process.env.RAPTURE_ORG_EMAIL_ENFORCED_CHANNELS = "zoom";
    process.env.RAPTURE_ENFORCE_ORG_EMAIL = "true";

    __setRaptureGatewayOrgProvisionerForTests(async (_target, selection) => {
      expect(selection?.credentialId).toBe("cred-123");
      expect(selection?.requesterEmail).toBe("trent.charlton@cloudwarriors.ai");
      return { provisioned: true, credentialId: "cred-123" };
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { session_id: "sess-explicit" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const tools = registerTools({
      messageChannel: "zoom",
      senderEmail: "trent.charlton@cloudwarriors.ai",
    });
    const connect = tools.get("rapture_gateway_connect");
    expect(connect).toBeDefined();

    const result = await connect!.execute("call-9", {
      gateway: "zoom",
      force_reconnect: true,
      credential_id: "cred-123",
    });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(true);
    expect(payload.credential_id).toBe("cred-123");
    expect(payload.session_id).toBe("sess-explicit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
