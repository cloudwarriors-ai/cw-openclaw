import { describe, expect, it } from "vitest";
import { redactForSupport } from "./ops-api.js";
import { PE_OPS_TOOL_GROUPS, registerPeOpsTools } from "./ops-tools.js";

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
  const api = {
    registerTool: (factory: () => ToolDef) => {
      const tool = factory();
      tools[tool.name] = tool;
    },
  } as never;
  registerPeOpsTools(api, noopLogger as never);
  return tools;
}

function parse(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

describe("presalespebot ops tools", () => {
  it("keeps spoke allowlist groups aligned with registered tools", () => {
    const registeredNames = Object.keys(buildTools()).sort();
    const groupedNames = Object.values(PE_OPS_TOOL_GROUPS).flat().sort();

    expect(new Set(groupedNames).size).toBe(groupedNames.length);
    expect(groupedNames).toEqual(registeredNames);
    expect(PE_OPS_TOOL_GROUPS.observe).toEqual([
      "pe_ops_health",
      "pe_ops_active_engagements",
      "pe_ops_stuck_engagements",
    ]);
  });

  it("uses fixture mode only with the explicit PRESALES_PE_OPS_FIXTURE_MODE opt-in", async () => {
    delete process.env.PRESALES_PE_OPS_BASE_URL;
    process.env.PRESALES_PE_OPS_FIXTURE_MODE = "1";
    try {
      const tools = buildTools();
      const result = parse(await tools.pe_ops_active_engagements.execute("t", {}));
      expect(result.ok).toBe(true);
      expect(result.source).toBe("fixture");
      expect(result.data[0].engagement_id).toBe("pe-fixture-1");
    } finally {
      delete process.env.PRESALES_PE_OPS_FIXTURE_MODE;
    }
  });

  it("reports misconfiguration (not fixture) when base URL is unset without the opt-in", async () => {
    delete process.env.PRESALES_PE_OPS_BASE_URL;
    delete process.env.PRESALES_PE_OPS_FIXTURE_MODE;
    const tools = buildTools();
    const result = parse(await tools.pe_ops_health.execute("t", {}));
    expect(result.ok).toBe(false);
    expect(result.source).toBe("api");
    expect(JSON.stringify(result.data)).toContain("not configured");
  });

  it("redacts secrets, emails, and phone-like values from support payloads", () => {
    const redacted = redactForSupport({
      authorization: "Bearer abc123",
      email: "matt.keuning@cloudwarriors.ai",
      phone: "+1 555 123 4567",
    });
    expect(JSON.stringify(redacted)).not.toContain("abc123");
    expect(JSON.stringify(redacted)).not.toContain("matt.keuning");
    expect(JSON.stringify(redacted)).not.toContain("555 123 4567");
  });
});
