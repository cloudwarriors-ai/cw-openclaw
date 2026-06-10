import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Auth is mocked so cfApi never fetches a real Firebase token.
vi.mock("./cf-auth.js", () => ({
  getFirebaseIdToken: async () => "test-token",
  getApiBaseUrl: () => "https://cf.test",
  clearFirebaseToken: () => {},
}));

vi.mock("./helpers.js", () => ({
  jsonResult: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
  errorResult: (err: unknown) => ({
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }],
  }),
}));

// Channel sender spy: staging delivers the confirm prompt (WITH the code) here,
// never through the tool's LLM-facing return value.
// Hoisted so it is initialized before Vitest lifts the vi.mock factory above it.
const FALLBACK_CHANNEL = vi.hoisted(() => "cf-default@conference.xmpp.zoom.us");
const sendCfTextMock = vi.fn();
vi.mock("./comfort.js", () => ({
  sendCfText: (...args: unknown[]) => sendCfTextMock(...args),
  getChannelThreadAnchor: () => "MSG-ANCHOR",
  rememberChannelThreadAnchor: () => {},
  sendComfortMessage: () => {},
  CF_CHANNEL: FALLBACK_CHANNEL,
}));

import { registerCfOpsTools } from "./cf-ops-tools.js";
import { tryExecuteConfirm } from "./confirm.js";

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

const noopLogger = () => {};
const CHANNEL = "cloudflow@conference.xmpp.zoom.us";
const fetchMock = vi.fn();

function buildTools(): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = {};
  const api = {
    registerTool: (factory: () => ToolDef) => {
      const t = factory();
      tools[t.name] = t;
    },
  } as never;
  registerCfOpsTools(api, noopLogger as never);
  return tools;
}

function parse(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

function codeFromDelivery(): string | undefined {
  const text = sendCfTextMock.mock.calls.at(-1)?.[1];
  return String(text ?? "").match(/CONFIRM (\d{4})/)?.[1];
}

describe("cloudflow cf_execute_op is confirm-gated", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    sendCfTextMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.CF_ZOOM_CHANNEL = CHANNEL;
  });
  afterEach(() => {
    delete process.env.CF_ZOOM_CHANNEL;
    vi.unstubAllGlobals();
  });

  it("dedicated read tools (cf_list_tickets) execute immediately and stage nothing", async () => {
    const tools = buildTools();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ rows: [] }) });
    await tools.cf_list_tickets.execute("t", {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendCfTextMock).not.toHaveBeenCalled();
  });

  it("cf_execute_op stages: code to channel, code-free model result, no API call", async () => {
    const tools = buildTools();
    const staged = parse(
      await tools.cf_execute_op.execute("t", {
        operationId: "resetTenant",
        payload: { tenantId: "x" },
      }),
    );
    expect(staged.staged).toBe(true);
    expect(staged.awaiting_confirmation).toBe(true);
    expect(JSON.stringify(staged)).not.toMatch(/CONFIRM \d{4}/);
    expect(fetchMock).not.toHaveBeenCalled(); // deferred until confirm
    expect(sendCfTextMock).toHaveBeenCalledTimes(1);
    const [channel, text, replyTo] = sendCfTextMock.mock.calls[0];
    expect(channel).toBe(CHANNEL);
    expect(text).toMatch(/CONFIRM \d{4}/);
    expect(replyTo).toBe("MSG-ANCHOR");
  });

  it("cf_execute_op POSTs /api/internal/ops/execute only after a human CONFIRM", async () => {
    const tools = buildTools();
    await tools.cf_execute_op.execute("t", { operationId: "resetTenant", payload: {} });
    expect(fetchMock).not.toHaveBeenCalled();

    const code = codeFromDelivery();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ done: true }) });
    const reply = await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/internal/ops/execute");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(reply).toMatch(/✅ Done/);
  });

  it("unset or compose-injected empty channel env fails closed (no inline prompt, nothing staged)", async () => {
    const stageWithBrokenEnv = async () => {
      const tools = buildTools();
      return parse(
        await tools.cf_execute_op.execute("t", { operationId: "resetTenant", payload: {} }),
      );
    };
    // Compose passes `CF_ZOOM_CHANNEL=${CF_ZOOM_CHANNEL}`: an unset host
    // var arrives as "" in the container. Both "" and unset must refuse to stage.
    process.env.CF_ZOOM_CHANNEL = "";
    const emptyStaged = await stageWithBrokenEnv();
    delete process.env.CF_ZOOM_CHANNEL;
    const unsetStaged = await stageWithBrokenEnv();
    for (const staged of [emptyStaged, unsetStaged]) {
      expect(staged.ok).toBe(false);
      expect(String(staged.error)).toContain("CF_ZOOM_CHANNEL");
      expect(JSON.stringify(staged)).not.toMatch(/CONFIRM \d{4}/);
    }
    expect(sendCfTextMock).not.toHaveBeenCalled();
  });

  it("a wrong/expired code executes nothing (fail-closed)", async () => {
    buildTools();
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
