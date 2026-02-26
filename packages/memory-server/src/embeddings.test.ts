import { afterEach, describe, expect, test, vi } from "vitest";

import {
  DeterministicEmbeddingProvider,
  OpenRouterEmbeddingProvider,
  deterministicEmbedding,
  resolveEmbeddingProviderFromEnv,
} from "./embeddings.js";

describe("memory server embeddings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("deterministic embedding output is stable", async () => {
    const a = deterministicEmbedding("hello");
    const b = deterministicEmbedding("hello");
    const c = deterministicEmbedding("different");
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.length).toBeGreaterThan(10);
  });

  test("resolveEmbeddingProviderFromEnv falls back to deterministic", async () => {
    const provider = resolveEmbeddingProviderFromEnv({});
    expect(provider).toBeInstanceOf(DeterministicEmbeddingProvider);
    const embedding = await provider.embed("hello");
    expect(embedding.length).toBeGreaterThan(10);
  });

  test("openrouter provider parses embeddings response", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          embedding: [0.1, 0.2, 0.3],
        },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenRouterEmbeddingProvider({
      apiKey: "token",
      model: "openai/text-embedding-3-large",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const vector = await provider.embed("hello");
    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://openrouter.ai/api/v1/embeddings"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("openrouter provider throws on non-2xx", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenRouterEmbeddingProvider({
      apiKey: "token",
      model: "openai/text-embedding-3-large",
    });
    await expect(provider.embed("hello")).rejects.toThrow("openrouter embeddings failed");
  });

  test("openrouter provider fails on non-json success payload", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>ok</html>", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenRouterEmbeddingProvider({
      apiKey: "token",
      model: "openai/text-embedding-3-large",
      baseUrl: "https://openrouter.ai/api/v1/",
    });
    await expect(provider.embed("hello")).rejects.toThrow("non-json payload");
  });
});
