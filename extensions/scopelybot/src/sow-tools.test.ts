// Contract tests for the Slice 3 SOW pipeline: preview reads immediately and
// bounds its payload; generate stages and DISCARDS the document bytes; the
// external send plane (execute/send/change-signer) stages with summaries that
// name the customer recipient explicitly and enforces required recipients.

import { beforeEach, describe, expect, it, vi } from "vitest";

const scopelyFetchMock = vi.fn();
const stageWriteMock = vi.fn();
vi.mock("./scopely-api.js", async () => {
  const actual = await vi.importActual<typeof import("./scopely-api.js")>("./scopely-api.js");
  return { ...actual, scopelyFetch: (...args: unknown[]) => scopelyFetchMock(...args) };
});
vi.mock("./gated.js", () => ({
  stageWrite: (...args: unknown[]) => {
    stageWriteMock(...args);
    return Promise.resolve({
      content: [
        { type: "text", text: JSON.stringify({ staged: true, awaiting_confirmation: true }) },
      ],
    });
  },
}));

import { registerSowTools } from "./sow-tools.js";

type Tool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

function buildTools() {
  const tools: Record<string, Tool> = {};
  const api = {
    registerTool: (factory: () => Tool) => {
      const tool = factory();
      tools[tool.name] = tool;
    },
  } as never;
  registerSowTools(api, (() => {}) as never);
  return tools;
}

function parse(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

async function runStaged() {
  const run = stageWriteMock.mock.calls.at(-1)?.[1] as () => Promise<{
    ok: boolean;
    status: number;
    data: unknown;
  }>;
  return run();
}

describe("SOW tools", () => {
  beforeEach(() => {
    scopelyFetchMock.mockReset();
    scopelyFetchMock.mockResolvedValue({ ok: true, status: 200, data: {} });
    stageWriteMock.mockReset();
  });

  it("registers the exact five tools", () => {
    expect(Object.keys(buildTools()).sort()).toEqual(
      [
        "scopely_change_sow_signer",
        "scopely_execute_sow",
        "scopely_generate_sow",
        "scopely_send_sow",
        "scopely_sow_preview",
      ].sort(),
    );
  });

  it("preview reads immediately and bounds line items", async () => {
    scopelyFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        company_info: { name: "Example Co" },
        totals: { grand_total: "1000" },
        line_items: Array.from({ length: 80 }, (_, i) => ({ key: `item-${i}` })),
      },
    });
    const result = parse(await buildTools().scopely_sow_preview.execute("x", { session_id: 7 }));
    expect(result.ok).toBe(true);
    expect(result.data.line_item_count).toBe(80);
    expect(result.data.line_items).toHaveLength(50);
    expect(stageWriteMock).not.toHaveBeenCalled();
    expect(scopelyFetchMock).toHaveBeenCalledWith("/api/sessions/7/sow-preview/");
  });

  it("generate stages, and its run discards the document bytes", async () => {
    const tools = buildTools();
    await tools.scopely_generate_sow.execute("x", { session_id: 7 });
    expect(String(stageWriteMock.mock.calls[0][0])).toBe("generate SOW for session 7");
    expect(scopelyFetchMock).not.toHaveBeenCalled();

    scopelyFetchMock.mockResolvedValueOnce({ ok: true, status: 200, data: "BINARY-DOCX-BYTES" });
    const res = await runStaged();
    expect(scopelyFetchMock).toHaveBeenCalledWith("/api/sessions/7/generate-sow/", {
      method: "POST",
      body: "{}",
    });
    // The docx text must not survive into the result.
    expect(res).toEqual({ ok: true, status: 200, data: { generated: true } });
  });

  it("generate run relays backend errors (which are JSON, not bytes)", async () => {
    const tools = buildTools();
    await tools.scopely_generate_sow.execute("x", { session_id: 7 });
    scopelyFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      data: { error: "Pricing not yet calculated" },
    });
    const res = await runStaged();
    expect(res.ok).toBe(false);
    expect(res.data).toEqual({ error: "Pricing not yet calculated" });
  });

  it("execute_sow names the DocuSign recipient in the staged summary", async () => {
    const tools = buildTools();
    await tools.scopely_execute_sow.execute("x", {
      session_id: 7,
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
    });
    expect(String(stageWriteMock.mock.calls[0][0])).toBe(
      "send SOW for session 7 for SIGNATURE via DocuSign to Ada Lovelace <ada@example.com>",
    );
    await runStaged();
    expect(scopelyFetchMock).toHaveBeenCalledWith("/api/sessions/7/execute-sow/", {
      method: "POST",
      body: JSON.stringify({ first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" }),
    });
  });

  it("send_sow requires an explicit recipient — no implicit external emails", async () => {
    const tools = buildTools();
    const result = parse(await tools.scopely_send_sow.execute("x", { session_id: 7 }));
    expect(result.ok).toBe(false);
    expect(stageWriteMock).not.toHaveBeenCalled();

    await tools.scopely_send_sow.execute("x", {
      session_id: 7,
      recipient_email: "cto@example.com",
    });
    expect(String(stageWriteMock.mock.calls[0][0])).toBe(
      "EMAIL the SOW for session 7 to cto@example.com",
    );
  });

  it("change_sow_signer requires a reason and names the new recipient", async () => {
    const tools = buildTools();
    const missingReason = parse(
      await tools.scopely_change_sow_signer.execute("x", {
        session_id: 7,
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
      }),
    );
    expect(missingReason.ok).toBe(false);
    expect(stageWriteMock).not.toHaveBeenCalled();

    await tools.scopely_change_sow_signer.execute("x", {
      session_id: 7,
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
      reason: "original signer left the company",
    });
    expect(String(stageWriteMock.mock.calls[0][0])).toBe(
      "CHANGE SOW SIGNER on session 7 to Ada Lovelace <ada@example.com> " +
        "(voids current envelope; reason: original signer left the company)",
    );
    await runStaged();
    expect(scopelyFetchMock).toHaveBeenCalledWith("/api/sessions/7/docusign/change-signer/", {
      method: "POST",
      body: JSON.stringify({
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
        reason: "original signer left the company",
      }),
    });
  });
});
