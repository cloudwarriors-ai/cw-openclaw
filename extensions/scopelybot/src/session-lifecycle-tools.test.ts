// Contract tests for the Slice 3 lifecycle/approval/discount verbs: every
// mutation stages (never executes at call time), staged runs hit the verified
// backend paths with the right method/body, summaries carry the facts an
// approver needs, and the discount id-resolution read runs immediately.

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

import { registerSessionLifecycleTools } from "./session-lifecycle-tools.js";

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
  registerSessionLifecycleTools(api, (() => {}) as never);
  return tools;
}

function parse(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

// Runs the staged closure captured by the last stageWrite call.
async function runStaged() {
  const run = stageWriteMock.mock.calls.at(-1)?.[1] as () => Promise<unknown>;
  return run();
}

describe("session lifecycle tools", () => {
  beforeEach(() => {
    scopelyFetchMock.mockReset();
    scopelyFetchMock.mockResolvedValue({ ok: true, status: 200, data: {} });
    stageWriteMock.mockReset();
  });

  it("registers the exact eleven tools", () => {
    expect(Object.keys(buildTools()).sort()).toEqual(
      [
        "scopely_add_session_discount",
        "scopely_approve_session",
        "scopely_archive_session",
        "scopely_cancel_session",
        "scopely_clone_session",
        "scopely_list_session_discounts",
        "scopely_reject_session",
        "scopely_remove_session_discount",
        "scopely_reopen_session",
        "scopely_request_session_approval",
        "scopely_revise_session",
      ].sort(),
    );
  });

  it("every mutation stages without touching the backend at call time", async () => {
    const tools = buildTools();
    await tools.scopely_cancel_session.execute("x", { session_id: 7 });
    await tools.scopely_archive_session.execute("x", { session_id: 7 });
    await tools.scopely_reopen_session.execute("x", { session_id: 7 });
    await tools.scopely_revise_session.execute("x", { session_id: 7 });
    await tools.scopely_clone_session.execute("x", { session_id: 7 });
    await tools.scopely_request_session_approval.execute("x", { session_id: 7 });
    await tools.scopely_approve_session.execute("x", { session_id: 7 });
    await tools.scopely_reject_session.execute("x", { session_id: 7 });
    await tools.scopely_add_session_discount.execute("x", {
      session_id: 7,
      discount_type: "percent",
      value: 10,
    });
    await tools.scopely_remove_session_discount.execute("x", { session_id: 7, discount_id: 3 });
    expect(stageWriteMock).toHaveBeenCalledTimes(10);
    expect(scopelyFetchMock).not.toHaveBeenCalled();
  });

  it("staged lifecycle runs POST the verified paths with reason bodies", async () => {
    const tools = buildTools();
    await tools.scopely_cancel_session.execute("x", { session_id: 42, reason: "dup deal" });
    expect(String(stageWriteMock.mock.calls[0][0])).toBe("CANCEL session 42 (reason: dup deal)");
    await runStaged();
    expect(scopelyFetchMock).toHaveBeenCalledWith("/api/sessions/42/cancel/", {
      method: "POST",
      body: JSON.stringify({ reason: "dup deal" }),
    });

    await tools.scopely_reopen_session.execute("x", { session_id: 42 });
    await runStaged();
    expect(scopelyFetchMock).toHaveBeenLastCalledWith("/api/sessions/42/reopen/", {
      method: "POST",
      body: "{}",
    });
  });

  it("approve/reject carry comments in summary and body", async () => {
    const tools = buildTools();
    await tools.scopely_reject_session.execute("x", { session_id: 9, comments: "price too low" });
    expect(String(stageWriteMock.mock.calls[0][0])).toBe(
      "REJECT approval request on session 9 (comments: price too low)",
    );
    await runStaged();
    expect(scopelyFetchMock).toHaveBeenCalledWith("/api/sessions/9/reject/", {
      method: "POST",
      body: JSON.stringify({ comments: "price too low" }),
    });
  });

  it("add discount validates value and stages a fully-described summary", async () => {
    const tools = buildTools();
    const bad = parse(
      await tools.scopely_add_session_discount.execute("x", {
        session_id: 7,
        discount_type: "fixed",
        value: -5,
      }),
    );
    expect(bad.ok).toBe(false);
    expect(stageWriteMock).not.toHaveBeenCalled();

    await tools.scopely_add_session_discount.execute("x", {
      session_id: 7,
      discount_type: "percent",
      value: 15,
      label: "Partner rate",
      category: "ucaas",
    });
    expect(String(stageWriteMock.mock.calls[0][0])).toBe(
      'add discount "Partner rate" (15%, category ucaas) to session 7',
    );
    await runStaged();
    expect(scopelyFetchMock).toHaveBeenCalledWith("/api/sessions/7/discounts/", {
      method: "POST",
      body: JSON.stringify({
        discount_type: "percent",
        value: "15",
        label: "Partner rate",
        category: "ucaas",
      }),
    });
  });

  it("remove discount DELETEs the verified path", async () => {
    const tools = buildTools();
    await tools.scopely_remove_session_discount.execute("x", { session_id: 7, discount_id: 3 });
    await runStaged();
    expect(scopelyFetchMock).toHaveBeenCalledWith("/api/sessions/7/discounts/3/", {
      method: "DELETE",
    });
  });

  it("discount list is a direct read (id-resolution dependency)", async () => {
    scopelyFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: [{ id: 3, discount_type: "percent", value: "10.00" }],
    });
    const result = parse(
      await buildTools().scopely_list_session_discounts.execute("x", { session_id: 7 }),
    );
    expect(result.ok).toBe(true);
    expect(result.data[0].id).toBe(3);
    expect(stageWriteMock).not.toHaveBeenCalled();
    expect(scopelyFetchMock).toHaveBeenCalledWith("/api/sessions/7/discounts/");
  });

  it("rejects a non-positive session id before staging", async () => {
    const result = parse(await buildTools().scopely_cancel_session.execute("x", { session_id: 0 }));
    expect(result.ok).toBe(false);
    expect(stageWriteMock).not.toHaveBeenCalled();
  });
});
