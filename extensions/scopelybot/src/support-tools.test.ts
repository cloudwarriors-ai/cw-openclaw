/** Contract tests for the eleven bounded support tools and staged writes. */

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
vi.mock("./devtools-client.js", () => ({
  listScopelyServices: vi.fn().mockResolvedValue({ ok: true, services: [] }),
  traceScopelyLogs: vi.fn().mockResolvedValue({ ok: true, results: [] }),
}));

import { registerSupportTools } from "./support-tools.js";

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
  registerSupportTools(api, (() => {}) as never, {
    serviceContainers: ["scopely-scopely-backend-1"],
    writeApproverIds: ["approver"],
  });
  return tools;
}

function parse(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("Scopely support tools", () => {
  beforeEach(() => {
    scopelyFetchMock.mockReset();
    stageWriteMock.mockReset();
  });

  it("registers the exact eleven support tools", () => {
    expect(Object.keys(buildTools()).sort()).toEqual(
      [
        "scopely_compare_session_versions",
        "scopely_list_services",
        "scopely_list_session_versions",
        "scopely_reassign_session",
        "scopely_refresh_docusign_status",
        "scopely_resend_docusign",
        "scopely_resend_user_verification",
        "scopely_session_status_counts",
        "scopely_support_session",
        "scopely_trace_logs",
        "scopely_unlock_user",
      ].sort(),
    );
  });

  it("shapes a session support bundle and omits direct PII/answers", async () => {
    const tools = buildTools();
    scopelyFetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          id: 7,
          company_name: "Example",
          status: "in_progress",
          contact_email: "person@example.com",
          answers: { password: "secret" },
          pricing_snapshot: { grand_total: "100", currency_code: "USD", internal: "omit" },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          session_id: "7",
          timeline: [
            {
              wizard_step: "company",
              "@timestamp": "2026-07-18T00:00:00Z",
              duration_to_next_ms: 1,
            },
          ],
        },
      });
    const result = parse(await tools.scopely_support_session.execute("x", { session_id: 7 }));
    expect(result.detail).not.toHaveProperty("contact_email");
    expect(result.detail).not.toHaveProperty("answers");
    expect(result.detail.pricing_snapshot).toEqual({ grand_total: "100", currency_code: "USD" });
    expect(result.timeline.timeline[0]).toHaveProperty("@timestamp");
  });

  it("stages every new mutation without calling the backend", async () => {
    const tools = buildTools();
    await tools.scopely_unlock_user.execute("x", { user_id: 1 });
    await tools.scopely_resend_user_verification.execute("x", { user_id: 1 });
    await tools.scopely_reassign_session.execute("x", { session_id: 1, organization_id: 2 });
    await tools.scopely_refresh_docusign_status.execute("x", { session_id: 1 });
    await tools.scopely_resend_docusign.execute("x", { session_id: 1 });
    expect(stageWriteMock).toHaveBeenCalledTimes(5);
    expect(scopelyFetchMock).not.toHaveBeenCalled();
  });
});
