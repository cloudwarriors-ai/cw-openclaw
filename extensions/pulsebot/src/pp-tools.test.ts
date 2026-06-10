import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the prod HTTP layer so no real network call is ever made and we can
// assert exactly which path/method each write tool would hit on confirm.
const fetchMock = vi.fn();
vi.mock("./pp-api.js", () => ({
  ppFetch: (...args: unknown[]) => fetchMock(...args),
  jsonResult: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
  errorResult: (err: unknown) => ({
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }],
  }),
}));

// Mock the channel sender: staging delivers the confirm prompt (WITH the code)
// to this spy instead of Zoom. The code lives ONLY here, never in the tool's
// LLM-facing return value.
// Hoisted so it is initialized before Vitest lifts the vi.mock factory above it.
const FALLBACK_CHANNEL = vi.hoisted(() => "pulsebot-default@conference.xmpp.zoom.us");
const sendPulseTextMock = vi.fn();
vi.mock("./comfort.js", () => ({
  sendPulseText: (...args: unknown[]) => sendPulseTextMock(...args),
  getChannelThreadAnchor: () => "MSG-ANCHOR",
  rememberChannelThreadAnchor: () => {},
  sendComfortMessage: () => {},
  PULSEBOT_CHANNEL: FALLBACK_CHANNEL,
}));

import { tryExecuteConfirm } from "./confirm.js";
import { registerPpTools } from "./pp-tools.js";

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

const noopLogger = () => {};
const CHANNEL = "pulsebot@conference.xmpp.zoom.us";

function buildTools(): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = {};
  const api = {
    registerTool: (factory: () => ToolDef) => {
      const t = factory();
      tools[t.name] = t;
    },
  } as never;
  registerPpTools(api, noopLogger as never);
  return tools;
}

function parse(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

// The confirm code travels ONLY through the deterministic channel send.
function codeFromDelivery(): string | undefined {
  const text = sendPulseTextMock.mock.calls.at(-1)?.[1];
  return String(text ?? "").match(/CONFIRM (\d{4})/)?.[1];
}

describe("pulsebot confirm-gated writes", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    sendPulseTextMock.mockReset();
    process.env.PULSEBOT_ZOOM_CHANNEL = CHANNEL;
  });
  afterEach(() => {
    delete process.env.PULSEBOT_ZOOM_CHANNEL;
  });

  it("read-only tools execute immediately and stage nothing", async () => {
    const tools = buildTools();
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: [] });
    await tools.pp_list_projects.execute("t", {});
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/projects");
    expect(sendPulseTextMock).not.toHaveBeenCalled();
  });

  it("create_ticket stages: code delivered to channel (threaded), NO code to the model, no prod write", async () => {
    const tools = buildTools();
    const staged = parse(
      await tools.pp_create_ticket.execute("t", { title: "Boom", projectId: "p1" }),
    );

    // Model-facing result is code-free — it cannot fabricate/relay/duplicate it.
    expect(staged.staged).toBe(true);
    expect(staged.awaiting_confirmation).toBe(true);
    expect(JSON.stringify(staged)).not.toMatch(/CONFIRM \d{4}/);
    expect(JSON.stringify(staged)).not.toMatch(/\b\d{4}\b/);

    // The real prompt — with the code — was posted to the channel, threaded.
    expect(sendPulseTextMock).toHaveBeenCalledTimes(1);
    const [channel, text, replyTo] = sendPulseTextMock.mock.calls[0];
    expect(channel).toBe(CHANNEL);
    expect(text).toMatch(/CONFIRM \d{4}/);
    expect(replyTo).toBe("MSG-ANCHOR");

    // Staging must not touch prod until confirmed.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("create_ticket POSTs /api/v1/tickets only after a human CONFIRM", async () => {
    const tools = buildTools();
    await tools.pp_create_ticket.execute("t", {
      title: "Boom",
      projectId: "p1",
      priority: "high",
    });
    const code = codeFromDelivery();
    expect(code).toBeTruthy();

    fetchMock.mockResolvedValue({ ok: true, status: 201, data: { id: "t1" } });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/tickets",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("update_ticket stages, then PATCHes the right id on confirm", async () => {
    const tools = buildTools();
    await tools.pp_update_ticket.execute("t", { id: "t9", status: "closed" });
    expect(fetchMock).not.toHaveBeenCalled();

    const code = codeFromDelivery();
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/tickets/t9",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("unset or compose-injected empty channel env fails closed (no inline prompt, nothing staged)", async () => {
    const stageWithBrokenEnv = async () => {
      const tools = buildTools();
      return parse(await tools.pp_create_ticket.execute("t", { title: "Boom", projectId: "p1" }));
    };
    // Compose passes `PULSEBOT_ZOOM_CHANNEL=${PULSEBOT_ZOOM_CHANNEL}`: an unset host
    // var arrives as "" in the container. Both "" and unset must refuse to stage.
    process.env.PULSEBOT_ZOOM_CHANNEL = "";
    const emptyStaged = await stageWithBrokenEnv();
    delete process.env.PULSEBOT_ZOOM_CHANNEL;
    const unsetStaged = await stageWithBrokenEnv();
    for (const staged of [emptyStaged, unsetStaged]) {
      expect(staged.ok).toBe(false);
      expect(String(staged.error)).toContain("PULSEBOT_ZOOM_CHANNEL");
      expect(JSON.stringify(staged)).not.toMatch(/CONFIRM \d{4}/);
    }
    expect(sendPulseTextMock).not.toHaveBeenCalled();
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
