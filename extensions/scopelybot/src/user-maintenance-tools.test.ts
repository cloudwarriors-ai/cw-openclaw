import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Mock the channel sender so staging delivers the confirm prompt to a spy instead
// of hitting Zoom. This is where the real code now lives — never in the tool's
// LLM-facing return value.
const sendScopelyTextMock = vi.fn();
vi.mock("./comfort.js", () => ({
  sendScopelyText: (...args: unknown[]) => sendScopelyTextMock(...args),
  getChannelThreadAnchor: () => "MSG-ANCHOR",
  rememberChannelThreadAnchor: () => {},
  sendComfortMessage: () => {},
}));

import { tryExecuteConfirm } from "./confirm.js";
import { registerUserMaintenanceTools } from "./user-maintenance-tools.js";

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

const noopLogger = () => {};
const CHANNEL = "vipbot@conference.xmpp.zoom.us";

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

// The confirm code now travels ONLY through the deterministic channel send, never
// through the tool's return value. Pull it from the latest sendScopelyText call.
function codeFromDelivery(): string | undefined {
  // sendScopelyText(channel, text, replyTo) — the prompt text is arg index 1.
  const text = sendScopelyTextMock.mock.calls.at(-1)?.[1];
  return String(text ?? "").match(/CONFIRM (\d{4})/)?.[1];
}

describe("user-maintenance-tools", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    sendScopelyTextMock.mockReset();
    process.env.SCOPELYBOT_ZOOM_CHANNEL = CHANNEL;
  });
  afterEach(() => {
    delete process.env.SCOPELYBOT_ZOOM_CHANNEL;
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

  it("staging delivers the code to the channel (threaded) and returns NO code to the model", async () => {
    const tools = buildTools();

    const staged = parse(
      await tools.scopely_reset_user_password.execute("t", {
        user_id: 123,
        email: "matt@example.com",
      }),
    );

    // The model-facing result is code-free — it cannot fabricate/relay/duplicate it.
    expect(staged.staged).toBe(true);
    expect(staged.awaiting_confirmation).toBe(true);
    expect(JSON.stringify(staged)).not.toMatch(/CONFIRM \d{4}/);
    expect(JSON.stringify(staged)).not.toMatch(/\b\d{4}\b/);

    // The real prompt — with the code — was posted to the channel, threaded.
    expect(sendScopelyTextMock).toHaveBeenCalledTimes(1);
    const [channel, text, replyTo] = sendScopelyTextMock.mock.calls[0];
    expect(channel).toBe(CHANNEL);
    expect(text).toMatch(/CONFIRM \d{4}/);
    expect(replyTo).toBe("MSG-ANCHOR");

    // Staging must not touch prod until confirmed.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scopely_update_user stages only the supplied fields and does NOT execute until confirmed", async () => {
    const tools = buildTools();

    const staged = parse(
      await tools.scopely_update_user.execute("t", { user_id: 7, role: "org_admin" }),
    );
    expect(staged.staged).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled(); // staging must not touch prod

    const code = codeFromDelivery();
    expect(code).toBeTruthy();

    fetchMock.mockResolvedValue({ ok: true, status: 200, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "tester",
      conversationId: CHANNEL,
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
    expect(sendScopelyTextMock).not.toHaveBeenCalled();
  });

  it("scopely_create_invite stages email+role and posts to the invite endpoint on confirm", async () => {
    const tools = buildTools();
    await tools.scopely_create_invite.execute("t", {
      email: "new@example.com",
      role: "org_admin",
    });
    const code = codeFromDelivery();

    fetchMock.mockResolvedValue({ ok: true, status: 201, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "tester",
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });

    const [path, opts] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/auth/invites/create/");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ email: "new@example.com", role: "org_admin" });
  });

  it("access-request approve/reject stage and hit the right endpoints on confirm", async () => {
    const tools = buildTools();

    await tools.scopely_approve_access_request.execute("t", { request_id: 3, organization: 9 });
    const approveCode = codeFromDelivery();
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${approveCode}`,
      actor: "t",
      conversationId: CHANNEL,
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

    await tools.scopely_reject_access_request.execute("t", { request_id: 4 });
    const rejectCode = codeFromDelivery();
    await tryExecuteConfirm({
      text: `CONFIRM ${rejectCode}`,
      actor: "t",
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/auth/access-requests/4/reject/",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("a CONFIRM from a DIFFERENT channel cannot fire the staged write", async () => {
    const tools = buildTools();
    await tools.scopely_update_user.execute("t", { user_id: 7, role: "org_admin" });
    const code = codeFromDelivery();

    // Wrong channel: must be refused and must NOT consume the pending action.
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: {} });
    const wrong = await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "attacker",
      conversationId: "someone-elses-channel@conference.xmpp.zoom.us",
      logger: noopLogger as never,
    });
    expect(wrong).toMatch(/different channel|expired|already been used/);
    expect(fetchMock).not.toHaveBeenCalled();

    // Right channel: the action is still there and fires.
    const right = await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    expect(right).toMatch(/✅ Done/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("staging FAILS CLOSED when SCOPELYBOT_ZOOM_CHANNEL is unset", async () => {
    delete process.env.SCOPELYBOT_ZOOM_CHANNEL;
    const tools = buildTools();
    const res = parse(
      await tools.scopely_update_user.execute("t", { user_id: 7, role: "org_admin" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/SCOPELYBOT_ZOOM_CHANNEL/);
    // Nothing staged, nothing delivered, prod untouched.
    expect(sendScopelyTextMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a wrong/expired code executes nothing (fail-closed)", async () => {
    buildTools();
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: {} });
    const reply = await tryExecuteConfirm({
      text: "CONFIRM 0000",
      actor: "t",
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    expect(reply).toMatch(/No pending action/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
