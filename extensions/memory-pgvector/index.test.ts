import { afterEach, describe, expect, test, vi } from "vitest";

import memoryPgvectorPlugin from "./index.js";

describe("memory-pgvector plugin", () => {
  const originalUrl = process.env.OPENCLAW_MEMORY_SERVER_URL;
  const originalToken = process.env.OPENCLAW_MEMORY_SERVER_TOKEN;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalUrl === undefined) {
      delete process.env.OPENCLAW_MEMORY_SERVER_URL;
    } else {
      process.env.OPENCLAW_MEMORY_SERVER_URL = originalUrl;
    }
    if (originalToken === undefined) {
      delete process.env.OPENCLAW_MEMORY_SERVER_TOKEN;
    } else {
      process.env.OPENCLAW_MEMORY_SERVER_TOKEN = originalToken;
    }
  });

  test("registers memory tools and returns disabled response when env is missing", async () => {
    const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];

    memoryPgvectorPlugin.register({
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      registerTool: (tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) => {
        tools.push(tool);
      },
    } as unknown as Parameters<typeof memoryPgvectorPlugin.register>[0]);

    expect(tools.map((tool) => tool.name).toSorted()).toEqual(["memory_get", "memory_search"]);

    delete process.env.OPENCLAW_MEMORY_SERVER_URL;
    delete process.env.OPENCLAW_MEMORY_SERVER_TOKEN;

    const search = tools.find((tool) => tool.name === "memory_search");
    expect(search).toBeDefined();
    const result = await search?.execute("call-1", { query: "test" });

    expect(result).toMatchObject({
      details: {
        disabled: true,
        results: [],
      },
    });

    const getTool = tools.find((tool) => tool.name === "memory_get");
    const getResult = await getTool?.execute("call-2", { path: "memory:abc" });
    expect(getResult).toMatchObject({
      details: {
        disabled: true,
      },
    });
  });

  test("calls memory server search endpoint while preserving base path", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      records: [
        {
          id: "abc",
          content: "hello from memory",
        },
      ],
      scores: [0.9],
      query_embedding_model: "openai/text-embedding-3-large",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    process.env.OPENCLAW_MEMORY_SERVER_URL = "https://memory.local/api/v1";
    process.env.OPENCLAW_MEMORY_SERVER_TOKEN = "token-a";

    const tools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];
    memoryPgvectorPlugin.register({
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      registerTool: (tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) => {
        tools.push(tool);
      },
    } as unknown as Parameters<typeof memoryPgvectorPlugin.register>[0]);

    const search = tools.find((tool) => tool.name === "memory_search");
    const result = await search?.execute("call-1", { query: "hello", maxResults: 3, minScore: 0.1 });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://memory.local/api/v1/memories/search"),
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(result).toMatchObject({
      details: {
        provider: "memory-server",
        model: "openai/text-embedding-3-large",
        results: [
          {
            path: "memory:abc",
            snippet: "hello from memory",
            score: 0.9,
          },
        ],
      },
    });
  });
});
