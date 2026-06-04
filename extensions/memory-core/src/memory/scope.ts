/**
 * CW memory scope resolution (ported from the pre-sync fork's src/memory/types.ts).
 *
 * Scopes restrict memory search hits by path prefix so customer-channel sessions
 * only see their own `memory/customers/<slug>/` files:
 * - `global` / undefined → no restriction
 * - `all-customers`      → `memory/customers` (optionally excluding specific slugs)
 * - `channel` + slug     → `memory/customers/<slug>`
 * - `channel` w/o slug   → denied (fail-closed)
 */

export type MemorySearchScope = "channel" | "all-customers" | "global";

const VALID_SCOPES: ReadonlySet<string> = new Set(["channel", "all-customers", "global"]);

export type ScopeResolution =
  | { prefix: string; denied?: false; excludePrefixes?: string[] }
  | { prefix?: undefined; denied: true };

function normalizeSlugPath(value: string): string {
  return value.replace(/[/\\]+/g, "/").replace(/^\/|\/$/g, "");
}

export function resolveSearchPathPrefix(
  scope: MemorySearchScope | undefined,
  channelSlug: string | undefined,
  excludeSlugs?: string[],
): ScopeResolution | undefined {
  if (!scope || scope === "global") {
    return undefined;
  }
  if (scope === "all-customers") {
    const excludePrefixes = excludeSlugs
      ?.map((s) => normalizeSlugPath(s))
      .filter(Boolean)
      .map((s) => `memory/customers/${s}`);
    return {
      prefix: "memory/customers",
      ...(excludePrefixes?.length ? { excludePrefixes } : {}),
    };
  }
  // scope === "channel"
  if (!channelSlug) {
    return { denied: true };
  }
  const slug = normalizeSlugPath(channelSlug);
  if (!slug) {
    return { denied: true };
  }
  return { prefix: `memory/customers/${slug}` };
}

/**
 * Tool-level scope policy (ported from the pre-sync memory-tool behavior).
 * - invalid/unknown requested scope falls back to defaultScope
 * - `all-customers` requires allowAllCustomers, else downgrades to channel
 *   (when a slug exists) or global
 * - `channel` without a slug falls back to global (matching the pre-sync
 *   behavior for non-support sessions; support fail-closed is enforced at the
 *   engine layer via resolveSearchPathPrefix when scope reaches it with no slug)
 */
export function resolveEffectiveScope(params: {
  requestedScope?: string;
  defaultScope?: MemorySearchScope;
  channelSlug?: string;
  allowAllCustomers?: boolean;
}): MemorySearchScope {
  const fallback: MemorySearchScope =
    params.defaultScope ?? (params.channelSlug ? "channel" : "global");
  const requested =
    params.requestedScope && VALID_SCOPES.has(params.requestedScope)
      ? (params.requestedScope as MemorySearchScope)
      : fallback;
  if (requested === "all-customers" && !params.allowAllCustomers) {
    return params.channelSlug ? "channel" : "global";
  }
  if (requested === "channel" && !params.channelSlug) {
    return "global";
  }
  return requested;
}

/** Filter search hits to a resolved scope (prefix include + exclusion prefixes). */
export function filterResultsByScope<T extends { path: string }>(
  results: T[],
  resolution: Exclude<ScopeResolution, { denied: true }> | undefined,
): T[] {
  if (!resolution?.prefix) {
    return results;
  }
  const normalized = resolution.prefix.replace(/\/$/, "") + "/";
  let filtered = results.filter(
    (r) => r.path.startsWith(normalized) || r.path === resolution.prefix,
  );
  const excludePrefixes = resolution.excludePrefixes;
  if (excludePrefixes?.length) {
    const normExcludes = excludePrefixes.map((p) => p.replace(/\/$/, "") + "/");
    filtered = filtered.filter((r) => !normExcludes.some((ex) => r.path.startsWith(ex)));
  }
  return filtered;
}
