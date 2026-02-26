import { createHash } from "node:crypto";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL = "openai/text-embedding-3-large";
const DEFAULT_TIMEOUT_MS = 20_000;
const DETERMINISTIC_DIMENSION = 64;

export type EmbeddingProvider = {
  model: string;
  version: string;
  dimension?: number;
  embed: (text: string) => Promise<number[]>;
};

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly model = "deterministic-hash-v1";
  readonly version = "1";
  readonly dimension = DETERMINISTIC_DIMENSION;

  async embed(text: string): Promise<number[]> {
    return deterministicEmbedding(text);
  }
}

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly version = "1";
  readonly dimension?: number;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly appName?: string;
  private readonly appUrl?: string;
  private readonly embeddingsUrl: URL;

  constructor(params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
    appName?: string;
    appUrl?: string;
  }) {
    this.apiKey = params.apiKey.trim();
    this.model = (params.model ?? DEFAULT_OPENROUTER_MODEL).trim();
    this.baseUrl = (params.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL).trim();
    this.timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.appName = params.appName?.trim();
    this.appUrl = params.appUrl?.trim();
    this.embeddingsUrl = resolveEmbeddingsUrl(this.baseUrl);
  }

  async embed(text: string): Promise<number[]> {
    const input = text.trim();
    if (!input) {
      return deterministicEmbedding("");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await fetch(this.embeddingsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...(this.appName ? { "X-Title": this.appName } : {}),
          ...(this.appUrl ? { "HTTP-Referer": this.appUrl } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          input,
        }),
        signal: controller.signal,
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(
          `openrouter embeddings failed with status ${response.status}: ${safeStringify(payload)}`,
        );
      }
      if (payload === null) {
        throw new Error("openrouter embeddings returned non-json payload");
      }
      const vector = parseOpenAiEmbeddingPayload(payload);
      if (vector.length === 0) {
        throw new Error("openrouter embeddings returned empty vector");
      }
      return vector;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function resolveEmbeddingProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider {
  const openRouterApiKey = env.OPENROUTER_API_KEY?.trim();
  if (openRouterApiKey) {
    return new OpenRouterEmbeddingProvider({
      apiKey: openRouterApiKey,
      model: env.OPENCLAW_MEMORY_EMBEDDING_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL,
      baseUrl: env.OPENCLAW_MEMORY_OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL,
      timeoutMs: parsePositiveInt(env.OPENCLAW_MEMORY_EMBEDDING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      appName: env.OPENCLAW_MEMORY_OPENROUTER_APP_NAME?.trim() || "moltbot-memory-server",
      appUrl: env.OPENCLAW_MEMORY_OPENROUTER_APP_URL?.trim() || "https://openclaw.ai",
    });
  }
  return new DeterministicEmbeddingProvider();
}

export function deterministicEmbedding(input: string): number[] {
  const normalized = input.trim().toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < DETERMINISTIC_DIMENSION; i++) {
    const digest = createHash("sha256").update(`${normalized}:${i}`).digest();
    const value = digest.readUInt32BE(0) / 0xffff_ffff;
    out.push((value * 2) - 1);
  }
  const norm = Math.sqrt(out.reduce((sum, value) => sum + (value * value), 0));
  if (norm === 0) {
    return out;
  }
  return out.map((value) => value / norm);
}

function parsePositiveInt(input: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((input ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolveEmbeddingsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith("/embeddings")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/embeddings`;
  }
  return url;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseOpenAiEmbeddingPayload(payload: unknown): number[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("embedding payload is not an object");
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("embedding payload missing data array");
  }
  const first = data[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    throw new Error("embedding payload data[0] invalid");
  }
  const embedding = (first as { embedding?: unknown }).embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("embedding payload data[0].embedding missing");
  }
  const out: number[] = [];
  for (const value of embedding) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("embedding contains non-finite numbers");
    }
    out.push(value);
  }
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
