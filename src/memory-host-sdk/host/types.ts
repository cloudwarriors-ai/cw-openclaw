export type MemorySource = "memory" | "sessions";

export type MemorySearchScope = "channel" | "all-customers" | "global";

export type ScopeResolution =
  | { prefix: string; denied?: false; excludePrefixes?: string[] }
  | { prefix?: undefined; denied: true };

/**
 * Resolve a scope + channelSlug into a path prefix for filtering search results.
 * - `global` / undefined → no prefix (search everything)
 * - `all-customers` → `memory/customers` (optionally excludes specific slugs)
 * - `channel` + slug → `memory/customers/${slug}`
 * - `channel` without slug → denied (fail-closed)
 *
 * @param excludeSlugs — slugs to exclude from all-customers scope
 */
export function resolveSearchPathPrefix(
  scope: MemorySearchScope | undefined,
  channelSlug: string | undefined,
  excludeSlugs?: string[],
): ScopeResolution | undefined {
  if (!scope || scope === "global") return undefined;
  if (scope === "all-customers") {
    const excludePrefixes = excludeSlugs
      ?.map((s) => s.replace(/[/\\]+/g, "/").replace(/^\/|\/$/g, ""))
      .filter(Boolean)
      .map((s) => `memory/customers/${s}`);
    return {
      prefix: "memory/customers",
      ...(excludePrefixes?.length ? { excludePrefixes } : {}),
    };
  }
  // scope === "channel"
  if (!channelSlug) return { denied: true };
  const slug = channelSlug.replace(/[/\\]+/g, "/").replace(/^\/|\/$/g, "");
  if (!slug) return { denied: true };
  return { prefix: `memory/customers/${slug}` };
}

export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
};

export type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
};

export type MemorySyncProgressUpdate = {
  completed: number;
  total: number;
  label?: string;
};

export type MemoryProviderStatus = {
  backend: "builtin" | "qmd";
  provider: string;
  model?: string;
  requestedProvider?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  workspaceDir?: string;
  dbPath?: string;
  extraPaths?: string[];
  sources?: MemorySource[];
  sourceCounts?: Array<{ source: MemorySource; files: number; chunks: number }>;
  cache?: { enabled: boolean; entries?: number; maxEntries?: number };
  fts?: { enabled: boolean; available: boolean; error?: string };
  fallback?: { from: string; reason?: string };
  vector?: {
    enabled: boolean;
    available?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  batch?: {
    enabled: boolean;
    failures: number;
    limit: number;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    lastError?: string;
    lastProvider?: string;
  };
  custom?: Record<string, unknown>;
};

export interface MemorySearchManager {
  search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      scope?: MemorySearchScope;
      channelSlug?: string;
      excludeSlugs?: string[];
    },
  ): Promise<MemorySearchResult[]>;
  readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }>;
  status(): MemoryProviderStatus;
  sync?(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}
