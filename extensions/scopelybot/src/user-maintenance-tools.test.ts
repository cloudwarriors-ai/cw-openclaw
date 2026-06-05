import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the prod HTTP layer so no real network call is ever made and we can
// assert exactly which path/method each tool would hit.
const fetchMock = vi.fn();
vi.mock("./scopely-api.js", () => ({
  scopelyFetch: (...args: unknown[]) => fetchMock(...args),
  jsonResult: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
  errorResult: (err: unknown) => ({
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }],
  }),
  buildQuery: () => "",
}));

import { registerUserMaintenanceTools, tryExecuteConfirm } from "./user-maintenance-tools.js";

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

const noopLogger = () => {};

function buildTools(): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = {};
  // The plugin api only needs registerTool for this suite; each call passes a
  // factory returning the (audit-wrapped) tool definition.
  const api = {
    registerTool: (factory: () => ToolDef) => {
      const t = factory();
      tools[t.name] = t;
    },
  } as never;
  registerUserMaintenanceTools(api, noopLogger as never);
  return tools;
}

function parse(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

describe("user-maintenance-tools", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("read-only tools execute immediately against the correct BFF paths", async () => {
    const tools = buildTools();
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: [] });

    await tools.scopely_get_user.execute("t", { user_id: 42 });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/users/42/detail/");

    await tools.scopely_list_invites.execute("t", {});
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/invites/");

    await tools.scopely_list_access_requests.execute("t", {});
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/access-requests/");
  });

  it("scopely_update_user stages only the supplied fields and does NOT execute until confirmed", async () => {
    const tools = buildTools();

    const staged = parse(
      await tools.scopely_update_user.execute("t", { user_id: 7, role: "org_admin" }),
    );
    expect(staged.staged).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled(); // staging must not touch prod

    const code = staged.message.match(/CONFIRM (\d{4})/)?.[1];
    expect(code).toBeTruthy();

    fetchMock.mockResolvedValue({ ok: true, status: 200, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "tester",
      logger: noopLogger as never,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, opts] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/auth/users/7/");
    expect(opts.method).toBe("PATCH");
    expect(JSON.parse(opts.body)).toEqual({ role: "org_admin" }); // is_active/other fields not blanked
  });

  it("scopely_update_user rejects an empty update without staging", async () => {
    const tools = buildTools();
    const res = parse(await tools.scopely_update_user.execute("t", { user_id: 7 }));
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scopely_create_invite stages email+role and posts to the invite endpoint on confirm", async () => {
    const tools = buildTools();
    const staged = parse(
      await tools.scopely_create_invite.execute("t", {
        email: "new@example.com",
        role: "org_admin",
      }),
    );
    const code = staged.message.match(/CONFIRM (\d{4})/)?.[1];

    fetchMock.mockResolvedValue({ ok: true, status: 201, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "tester",
      logger: noopLogger as never,
    });

    const [path, opts] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/auth/invites/create/");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ email: "new@example.com", role: "org_admin" });
  });

  it("access-request approve/reject stage and hit the right endpoints on confirm", async () => {
    const tools = buildTools();

    const approve = parse(
      await tools.scopely_approve_access_request.execute("t", { request_id: 3, organization: 9 }),
    );
    const approveCode = approve.message.match(/CONFIRM (\d{4})/)?.[1];
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${approveCode}`,
      actor: "t",
      logger: noopLogger as never,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/auth/access-requests/3/approve/",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toEqual({
      organization: 9,
      role: "user",
    });

    const reject = parse(await tools.scopely_reject_access_request.execute("t", { request_id: 4 }));
    const rejectCode = reject.message.match(/CONFIRM (\d{4})/)?.[1];
    await tryExecuteConfirm({
      text: `CONFIRM ${rejectCode}`,
      actor: "t",
      logger: noopLogger as never,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/auth/access-requests/4/reject/",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
