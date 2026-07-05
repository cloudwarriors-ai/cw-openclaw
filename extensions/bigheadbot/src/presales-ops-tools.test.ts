import { describe, expect, it, vi } from "vitest";
import { redactForSupport } from "./presales-ops-api.js";
import { BIGHEAD_PRESALES_TOOL_GROUPS, registerPresalesOpsTools } from "./presales-ops-tools.js";

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
  registerPresalesOpsTools(api, noopLogger as never);
  return tools;
}

function parse(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

describe("bigheadbot presales ops tools", () => {
  it("keeps spoke allowlist groups aligned with registered presales tools", () => {
    const registeredNames = Object.keys(buildTools()).sort();
    const groupedNames = Object.values(BIGHEAD_PRESALES_TOOL_GROUPS).flat().sort();

    expect(new Set(groupedNames).size).toBe(groupedNames.length);
    expect(groupedNames).toEqual(registeredNames);
    expect(BIGHEAD_PRESALES_TOOL_GROUPS.audio).toEqual([
      "bh_presales_audio_status",
      "bh_presales_transcript_status",
      "bh_presales_transcript_text",
    ]);
  });

  it("uses fixture mode only with the explicit BIGHEAD_OPS_FIXTURE_MODE opt-in", async () => {
    delete process.env.BIGHEAD_OPS_BASE_URL;
    delete process.env.BIGHEAD_API_URL;
    process.env.BIGHEAD_OPS_FIXTURE_MODE = "1";
    try {
      const tools = buildTools();
      const result = parse(await tools.bh_presales_active_sessions.execute("t", {}));
      expect(result.ok).toBe(true);
      expect(result.source).toBe("fixture");
      expect(result.data[0].session_id).toBe("bh-fixture-1");
    } finally {
      delete process.env.BIGHEAD_OPS_FIXTURE_MODE;
    }
  });

  it("reports misconfiguration (not fixture) when base URL is unset without the opt-in", async () => {
    delete process.env.BIGHEAD_OPS_BASE_URL;
    delete process.env.BIGHEAD_API_URL;
    delete process.env.BIGHEAD_OPS_FIXTURE_MODE;
    const tools = buildTools();
    const result = parse(await tools.bh_presales_ops_health.execute("t", {}));
    expect(result.ok).toBe(false);
    expect(result.source).toBe("api");
    expect(JSON.stringify(result.data)).toContain("not configured");
  });

  it("refuses to call Bighead ops without a bearer token", async () => {
    process.env.BIGHEAD_OPS_BASE_URL = "http://bighead.test";
    delete process.env.BIGHEAD_OPS_TOKEN;
    delete process.env.BIGHEAD_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.BIGHEAD_OPS_FIXTURE_MODE;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const tools = buildTools();
      const result = parse(await tools.bh_presales_ops_health.execute("t", {}));
      expect(result.ok).toBe(false);
      expect(result.source).toBe("api");
      expect(JSON.stringify(result.data)).toContain("not configured");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      delete process.env.BIGHEAD_OPS_BASE_URL;
    }
  });

  it("returns transcript lines and builds a /transcript/text path with limit", async () => {
    delete process.env.BIGHEAD_OPS_BASE_URL;
    delete process.env.BIGHEAD_API_URL;
    process.env.BIGHEAD_OPS_FIXTURE_MODE = "1";
    try {
      const tools = buildTools();
      const result = parse(
        await tools.bh_presales_transcript_text.execute("t", { session_id: "bh-1", limit: 25 }),
      );
      expect(result.ok).toBe(true);
      expect(result.source).toBe("fixture");
      // Headline use case: the operator can read what the customer actually said.
      expect(result.data.lines[0].text).toContain("don't want CRM");
    } finally {
      delete process.env.BIGHEAD_OPS_FIXTURE_MODE;
    }
  });

  it("redacts tokens, emails, and Zoom URLs from support payloads", () => {
    const redacted = redactForSupport({
      authorization: "Bearer abc123",
      email: "matt.keuning@cloudwarriors.ai",
      meeting_url: "https://zoom.us/j/123?pwd=secret",
    });
    expect(JSON.stringify(redacted)).not.toContain("abc123");
    expect(JSON.stringify(redacted)).not.toContain("matt.keuning");
    expect(JSON.stringify(redacted)).not.toContain("zoom.us/j");
  });
});
