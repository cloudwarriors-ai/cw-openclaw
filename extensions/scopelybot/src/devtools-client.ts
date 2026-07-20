/** Bounded, fail-explicit client for Scopely application container logs. */

import type { ScopelyBotConfig } from "./config.js";
import { configuredServiceContainers } from "./config.js";
import { redactText } from "./redaction.js";

type ContainerInfo = {
  id?: string;
  name?: string;
  image?: string;
  state?: string;
  status?: string;
  created?: number;
};

export type SourceState = {
  ok: boolean;
  base?: string;
  status?: number;
  error?: string;
};

const DEVTOOLS_TOKEN = () => process.env.SCOPELY_DEV_TOOLS_API ?? process.env.DEV_TOOLS_API ?? "";
const MAX_LOG_LINES = 50;
const MAX_LOG_BYTES = 24_000;

function bases(): string[] {
  return [
    process.env.DEVTOOLS_API_URL,
    process.env.SCOPELY_DEVTOOLS_API_URL,
    "https://devtools-api.cloudwarriors.ai",
  ]
    .map((value) => value?.trim().replace(/\/$/, ""))
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
}

async function devtoolsRequest(path: string): Promise<{
  state: SourceState;
  response?: Response;
}> {
  const token = DEVTOOLS_TOKEN();
  if (!token) return { state: { ok: false, error: "DevTools token is not configured" } };
  const failures: string[] = [];
  for (const base of bases()) {
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return { state: { ok: true, base, status: response.status }, response };
      failures.push(`${base}: HTTP ${response.status}`);
    } catch (err) {
      failures.push(`${base}: ${err instanceof Error ? err.name : "request failed"}`);
    }
  }
  return { state: { ok: false, error: failures.join("; ").slice(0, 500) } };
}

export function normalizeEpoch(value: unknown, nowMs = Date.now()): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("time must be epoch seconds");
    return value;
  }
  if (typeof value !== "string") throw new Error("time must be relative, ISO, or epoch seconds");
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed)) throw new Error("time is outside the safe integer range");
    return parsed;
  }
  const relative = trimmed.match(/^(\d+)([mhd])$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const seconds = amount * ({ m: 60, h: 3600, d: 86400 }[relative[2].toLowerCase()] ?? 0);
    return Math.max(0, Math.floor(nowMs / 1000) - seconds);
  }
  const iso = Date.parse(trimmed);
  if (!Number.isFinite(iso))
    throw new Error("time must be like 30m, 1h, ISO-8601, or epoch seconds");
  return Math.floor(iso / 1000);
}

function normalizeTail(value: unknown): number {
  const parsed = value === undefined ? 500 : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("tail must be a positive integer");
  return Math.min(parsed, 1000);
}

export async function listScopelyServices(config: ScopelyBotConfig) {
  const allowed = configuredServiceContainers(config);
  const request = await devtoolsRequest("/api/v1/containers");
  if (!request.response) {
    return {
      ok: false,
      source: request.state,
      services: allowed.map((name) => ({ name, discovered: false })),
    };
  }
  let containers: ContainerInfo[];
  try {
    const data = await request.response.json();
    if (!Array.isArray(data)) throw new Error("unexpected container-list response");
    containers = data as ContainerInfo[];
  } catch (err) {
    return {
      ok: false,
      source: {
        ...request.state,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      services: allowed.map((name) => ({ name, discovered: false })),
    };
  }
  const byName = new Map(containers.map((container) => [container.name, container]));
  return {
    ok: true,
    source: request.state,
    services: allowed.map((name) => {
      const container = byName.get(name);
      return container
        ? {
            name,
            discovered: true,
            image: container.image,
            state: container.state,
            status: container.status,
          }
        : { name, discovered: false };
    }),
  };
}

export async function traceScopelyLogs(config: ScopelyBotConfig, params: Record<string, unknown>) {
  const allowed = configuredServiceContainers(config);
  const requested = Array.isArray(params.containers)
    ? params.containers.map((value) => String(value))
    : allowed;
  if (requested.length === 0 || requested.some((name) => !allowed.includes(name))) {
    throw new Error("containers must be a non-empty subset of the exact Scopely service allowlist");
  }
  const pattern = typeof params.pattern === "string" ? params.pattern.trim() : "";
  if (!pattern || pattern.length > 200) throw new Error("pattern must be 1-200 characters");
  const tail = normalizeTail(params.tail);
  const since = normalizeEpoch(params.since);
  const until = normalizeEpoch(params.until);
  if (since !== undefined && until !== undefined && until < since) {
    throw new Error("until must be greater than or equal to since");
  }

  const results = await Promise.all(
    requested.map(async (container) => {
      const query = new URLSearchParams({ tail: String(tail) });
      if (since !== undefined) query.set("since", String(since));
      if (until !== undefined) query.set("until", String(until));
      const request = await devtoolsRequest(
        `/api/v1/containers/${encodeURIComponent(container)}/logs?${query.toString()}`,
      );
      if (!request.response) {
        return { container, source: request.state, matches: [] as string[] };
      }
      const text = await request.response.text();
      const needle = pattern.toLowerCase();
      let bytes = 0;
      const matches: string[] = [];
      for (const line of text.split("\n")) {
        if (!line.toLowerCase().includes(needle)) continue;
        const safe = redactText(line, 2_000);
        const size = Buffer.byteLength(safe, "utf8");
        if (matches.length >= MAX_LOG_LINES || bytes + size > MAX_LOG_BYTES) break;
        matches.push(safe);
        bytes += size;
      }
      return { container, source: request.state, matches };
    }),
  );
  return {
    ok: results.some((result) => result.source.ok),
    pattern,
    window: { since, until, tail },
    results,
  };
}
