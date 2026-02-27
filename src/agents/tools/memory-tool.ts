import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import type { MemorySearchScope } from "../../memory/types.js";
import { normalizeChannelSlug } from "../../channels/channel-config.js";
import { resolveMemoryBackendConfig } from "../../memory/backend-config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import type { MemorySearchResult } from "../../memory/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
  scope: Type.Optional(Type.String({ description: "Search scope: 'channel' (current customer only), 'all-customers', or 'global' (default)" })),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

const VALID_SCOPES = new Set<MemorySearchScope>(["channel", "all-customers", "global"]);

function parseScope(raw: string | undefined): MemorySearchScope | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().toLowerCase() as MemorySearchScope;
  return VALID_SCOPES.has(trimmed) ? trimmed : undefined;
}

/**
 * Compute the effective scope given the requested scope and policy options.
 * Returns the effective scope and whether the request was downgraded.
 */
function resolveEffectiveScope(params: {
  requested?: MemorySearchScope;
  defaultScope?: MemorySearchScope;
  isSupport?: boolean;
  allowAllCustomers?: boolean;
  channelSlug?: string;
}): { effectiveScope: MemorySearchScope; scopeDenied: boolean } {
  const raw = params.requested ?? params.defaultScope ?? "global";

  // Non-support sessions cannot use all-customers scope;
  // channel scope is allowed for ANY session that has a valid channelSlug
  if (!params.isSupport && raw === "all-customers") {
    return { effectiveScope: "global", scopeDenied: false };
  }
  if (!params.isSupport && raw === "channel" && !params.channelSlug) {
    return { effectiveScope: "global", scopeDenied: false };
  }

  // Support sessions with allowAllCustomers=false cannot use all-customers
  if (raw === "all-customers" && !params.allowAllCustomers) {
    return { effectiveScope: "channel", scopeDenied: !params.channelSlug };
  }

  // Channel scope without slug = fail-closed
  if (raw === "channel" && !params.channelSlug) {
    return { effectiveScope: "channel", scopeDenied: true };
  }

  return { effectiveScope: raw, scopeDenied: false };
}

function normalizeCandidateSlug(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  const normalized = normalizeChannelSlug(raw);
  return normalized || undefined;
}

function resolveThreadParentKey(sessionKey: string): string | undefined {
  const normalized = sessionKey.toLowerCase();
  const threadIdx = normalized.lastIndexOf(":thread:");
  const topicIdx = normalized.lastIndexOf(":topic:");
  const idx = Math.max(threadIdx, topicIdx);
  if (idx <= 0) {
    return undefined;
  }
  const parent = sessionKey.slice(0, idx).trim();
  return parent || undefined;
}

function resolveChannelSlugFromSessionMetadata(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
}): string | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!params.cfg || !sessionKey) {
    return undefined;
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    const store = loadSessionStore(storePath);
    const parentKey = resolveThreadParentKey(sessionKey);
    const entry = store[sessionKey] ?? (parentKey ? store[parentKey] : undefined);
    if (!entry) {
      return undefined;
    }
    const fromSubject = normalizeCandidateSlug(entry.subject);
    if (fromSubject) {
      return fromSubject;
    }
    const groupChannel = entry.groupChannel?.trim();
    if (!groupChannel) {
      return undefined;
    }
    const channelLabel = groupChannel.includes("@") ? groupChannel.split("@")[0] : groupChannel;
    return normalizeCandidateSlug(channelLabel);
  } catch {
    return undefined;
  }
}

function resolveMemoryToolContext(options: { config?: OpenClawConfig; agentSessionKey?: string }) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  return { cfg, agentId };
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  channelSlug?: string;
  isSupport?: boolean;
  defaultScope?: MemorySearchScope;
  allowAllCustomers?: boolean;
  excludeSlugs?: string[];
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  const resolvedChannelSlug =
    normalizeCandidateSlug(options.channelSlug) ??
    resolveChannelSlugFromSessionMetadata({
      cfg,
      agentId,
      sessionKey: options.agentSessionKey,
    });
  const searchConfig = resolveMemorySearchConfig(cfg, agentId);
  if (!searchConfig) {
    return null;
  }
  const configuredMinScore = searchConfig.query.minScore;
  const relaxedChannelMinScore = Math.max(0, Math.min(configuredMinScore, 0.2));
  return {
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user." +
      (resolvedChannelSlug ? " Supports scope parameter: 'channel' (current customer — USE THIS for trained Q&A recall), 'global'." : "") +
      (options.isSupport ? " Also supports 'all-customers' scope for cross-customer search." : ""),
    parameters: MemorySearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults");
      const minScore = readNumberParam(params, "minScore");
      const requestedScope = parseScope(readStringParam(params, "scope"));
      const { effectiveScope, scopeDenied } = resolveEffectiveScope({
        requested: requestedScope,
        defaultScope: options.defaultScope,
        isSupport: options.isSupport,
        allowAllCustomers: options.allowAllCustomers,
        channelSlug: resolvedChannelSlug,
      });

      if (scopeDenied) {
        return jsonResult({
          results: [],
          effectiveScope,
          requestedScope: requestedScope ?? options.defaultScope ?? "global",
          scopeDenied: true,
        });
      }

      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult(buildMemorySearchUnavailableResult(error));
      }
      try {
        const citationsMode = resolveMemoryCitationsMode(cfg);
        const includeCitations = shouldIncludeCitations({
          mode: citationsMode,
          sessionKey: options.agentSessionKey,
        });
        let rawResults = await manager.search(query, {
          maxResults,
          minScore,
          sessionKey: options.agentSessionKey,
          scope: effectiveScope,
          channelSlug: resolvedChannelSlug,
          excludeSlugs: effectiveScope === "all-customers" ? options.excludeSlugs : undefined,
        });
        let relaxedMinScore: number | undefined;
        if (
          rawResults.length === 0 &&
          minScore === undefined &&
          effectiveScope === "channel" &&
          relaxedChannelMinScore < configuredMinScore
        ) {
          rawResults = await manager.search(query, {
            maxResults,
            minScore: relaxedChannelMinScore,
            sessionKey: options.agentSessionKey,
            scope: effectiveScope,
            channelSlug: resolvedChannelSlug,
            excludeSlugs: undefined,
          });
          if (rawResults.length > 0) {
            relaxedMinScore = relaxedChannelMinScore;
          }
        }
        const status = manager.status();
        const decorated = decorateCitations(rawResults, includeCitations);
        const resolved = resolveMemoryBackendConfig({ cfg, agentId });
        const results =
          status.backend === "qmd"
            ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
            : decorated;
        const searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
        return jsonResult({
          results,
          provider: status.provider,
          model: status.model,
          fallback: status.fallback,
          citations: citationsMode,
          mode: searchMode,
          effectiveScope,
          requestedScope: requestedScope ?? options.defaultScope ?? "global",
          scopeDenied: false,
          ...(relaxedMinScore !== undefined ? { relaxedMinScore } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult(buildMemorySearchUnavailableResult(message));
      }
    },
  };
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;
  return {
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
    parameters: MemoryGetSchema,
    execute: async (_toolCallId, params) => {
      const relPath = readStringParam(params, "path", { required: true });
      const from = readNumberParam(params, "from", { integer: true });
      const lines = readNumberParam(params, "lines", { integer: true });
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult({ path: relPath, text: "", disabled: true, error });
      }
      try {
        const result = await manager.readFile({
          relPath,
          from: from ?? undefined,
          lines: lines ?? undefined,
        });
        return jsonResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ path: relPath, text: "", disabled: true, error: message });
      }
    },
  };
}

function resolveMemoryCitationsMode(cfg: OpenClawConfig): MemoryCitationsMode {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function decorateCitations(results: MemorySearchResult[], include: boolean): MemorySearchResult[] {
  if (!include) {
    return results.map((entry) => ({ ...entry, citation: undefined }));
  }
  return results.map((entry) => {
    const citation = formatCitation(entry);
    const snippet = `${entry.snippet.trim()}\n\nSource: ${citation}`;
    return { ...entry, citation, snippet };
  });
}

function formatCitation(entry: MemorySearchResult): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}

function clampResultsByInjectedChars(
  results: MemorySearchResult[],
  budget?: number,
): MemorySearchResult[] {
  if (!budget || budget <= 0) {
    return results;
  }
  let remaining = budget;
  const clamped: MemorySearchResult[] = [];
  for (const entry of results) {
    if (remaining <= 0) {
      break;
    }
    const snippet = entry.snippet ?? "";
    if (snippet.length <= remaining) {
      clamped.push(entry);
      remaining -= snippet.length;
    } else {
      const trimmed = snippet.slice(0, Math.max(0, remaining));
      clamped.push({ ...entry, snippet: trimmed });
      break;
    }
  }
  return clamped;
}

function buildMemorySearchUnavailableResult(error: string | undefined) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  const isQuotaError = /insufficient_quota|quota|429/.test(reason.toLowerCase());
  const warning = isQuotaError
    ? "Memory search is unavailable because the embedding provider quota is exhausted."
    : "Memory search is unavailable due to an embedding/provider error.";
  const action = isQuotaError
    ? "Top up or switch embedding provider, then retry memory_search."
    : "Check embedding provider configuration and retry memory_search.";
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning,
    action,
  };
}

function shouldIncludeCitations(params: {
  mode: MemoryCitationsMode;
  sessionKey?: string;
}): boolean {
  if (params.mode === "on") {
    return true;
  }
  if (params.mode === "off") {
    return false;
  }
  // auto: show citations in direct chats; suppress in groups/channels by default.
  const chatType = deriveChatTypeFromSessionKey(params.sessionKey);
  return chatType === "direct";
}

function deriveChatTypeFromSessionKey(sessionKey?: string): "direct" | "group" | "channel" {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return "direct";
  }
  const tokens = new Set(parsed.rest.toLowerCase().split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}
