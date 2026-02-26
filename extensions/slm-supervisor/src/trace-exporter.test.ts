import { afterEach, describe, expect, test, vi } from "vitest";

import { resolveTraceExporterFromEnv } from "./trace-exporter.js";

describe("trace exporter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("uses noop exporter when env is missing", async () => {
    const exporter = resolveTraceExporterFromEnv({});
    await expect(
      exporter.exportTrace({
        trace_id: "trace-1",
        tenant_id: "tenant-a",
        channel_id: "zoom:ops",
        user_message: "hello",
        source_path: "slm_only",
        reason_codes: [],
        policy_flags: [],
        slm_confidence: 0.9,
        grounding_score: 0.9,
        created_at: "2026-02-23T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });

  test("exports trace to memory server when env is configured", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const exporter = resolveTraceExporterFromEnv({
      OPENCLAW_MEMORY_SERVER_URL: "https://memory.local",
      OPENCLAW_MEMORY_SERVER_TOKEN: "token-a",
    });

    await exporter.exportTrace({
      trace_id: "trace-1",
      tenant_id: "tenant-a",
      channel_id: "zoom:ops",
      user_message: "hello",
      source_path: "slm_only",
      reason_codes: ["code-a"],
      policy_flags: [],
      slm_confidence: 0.9,
      grounding_score: 0.9,
      created_at: "2026-02-23T00:00:00.000Z",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://memory.local/memories"),
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  test("preserves base path when building memory server URL", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const exporter = resolveTraceExporterFromEnv({
      OPENCLAW_MEMORY_SERVER_URL: "https://memory.local/api/v1",
      OPENCLAW_MEMORY_SERVER_TOKEN: "token-a",
    });

    await exporter.exportTrace({
      trace_id: "trace-1",
      tenant_id: "tenant-a",
      channel_id: "zoom:ops",
      user_message: "hello",
      source_path: "slm_only",
      reason_codes: ["code-a"],
      policy_flags: [],
      slm_confidence: 0.9,
      grounding_score: 0.9,
      created_at: "2026-02-23T00:00:00.000Z",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://memory.local/api/v1/memories"),
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  test("throws when memory server responds with non-2xx", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const exporter = resolveTraceExporterFromEnv({
      OPENCLAW_MEMORY_SERVER_URL: "https://memory.local",
      OPENCLAW_MEMORY_SERVER_TOKEN: "token-a",
    });

    await expect(
      exporter.exportTrace({
        trace_id: "trace-1",
        tenant_id: "tenant-a",
        channel_id: "zoom:ops",
        user_message: "hello",
        source_path: "slm_only",
        reason_codes: ["code-a"],
        policy_flags: [],
        slm_confidence: 0.9,
        grounding_score: 0.9,
        created_at: "2026-02-23T00:00:00.000Z",
      }),
    ).rejects.toThrow("memory-server trace export failed");
  });
});
