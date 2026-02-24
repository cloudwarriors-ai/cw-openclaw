import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";

export const CATFISH_SCOPE_PRIMARY = "teamchat:admin:write";
export const CATFISH_SCOPE_ALT = "team_chat:write:user_message:admin";

const DEFAULT_REQUIRED_SCOPES = [CATFISH_SCOPE_PRIMARY, CATFISH_SCOPE_ALT] as const;
const DEFAULT_OAUTH_BASE_URL = "https://zoom.us";
const DEFAULT_API_BASE_URL = "https://api.zoom.us/v2";
const DEFAULT_USERS_LIST_PAGE_SIZE = 300;
const DEFAULT_USERS_LIST_MAX_PAGES = 10;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

export type CatfishRuntimeConfig = {
  clientId?: string;
  clientSecret?: string;
  accountId?: string;
  requiredScopes: string[];
  oauthBaseUrl: string;
  apiBaseUrl: string;
  usersListPageSize: number;
  usersListMaxPages: number;
  cacheTtlMs: number;
  auditLogPath?: string;
};

export type CatfishCredentials = {
  clientId: string;
  clientSecret: string;
  accountId: string;
};

type ConfigIssue = {
  path: Array<string | number>;
  message: string;
};

type ConfigSafeParseResult =
  | { success: true; data: CatfishRuntimeConfig }
  | { success: false; error: { issues: ConfigIssue[] } };

function asRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function firstDefined(values: Array<unknown>): string | undefined {
  for (const value of values) {
    const normalized = asOptionalString(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.map(asOptionalString).filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function normalizeScopes(raw: { requiredScope?: string; requiredScopes?: string[] }): string[] {
  const source = raw.requiredScopes ?? (raw.requiredScope ? [raw.requiredScope] : undefined);
  const values = source ?? [...DEFAULT_REQUIRED_SCOPES];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const scope of values) {
    const trimmed = scope.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized.length > 0 ? normalized : [...DEFAULT_REQUIRED_SCOPES];
}

function normalizeBaseUrl(url: string | undefined, fallback: string): string {
  const value = (url ?? fallback).trim();
  return value.replace(/\/+$/, "");
}

export function parseCatfishConfig(value: unknown): CatfishRuntimeConfig {
  const record = asRecord(value) ? value : {};
  const requiredScope = asOptionalString(record.requiredScope);
  const requiredScopes = asStringArray(record.requiredScopes);

  return {
    clientId: asOptionalString(record.clientId),
    clientSecret: asOptionalString(record.clientSecret),
    accountId: asOptionalString(record.accountId),
    requiredScopes: normalizeScopes({ requiredScope, requiredScopes }),
    oauthBaseUrl: normalizeBaseUrl(asOptionalString(record.oauthBaseUrl), DEFAULT_OAUTH_BASE_URL),
    apiBaseUrl: normalizeBaseUrl(asOptionalString(record.apiBaseUrl), DEFAULT_API_BASE_URL),
    usersListPageSize: asPositiveInteger(record.usersListPageSize) ?? DEFAULT_USERS_LIST_PAGE_SIZE,
    usersListMaxPages: asPositiveInteger(record.usersListMaxPages) ?? DEFAULT_USERS_LIST_MAX_PAGES,
    cacheTtlMs: asPositiveNumber(record.cacheTtlMs) ?? DEFAULT_CACHE_TTL_MS,
    auditLogPath: asOptionalString(record.auditLogPath),
  };
}

export function resolveCatfishCredentials(
  config: CatfishRuntimeConfig,
): CatfishCredentials | undefined {
  const clientId = firstDefined([config.clientId, process.env.CATFISH_ZOOM_CLIENT_ID]);
  const clientSecret = firstDefined([config.clientSecret, process.env.CATFISH_ZOOM_CLIENT_SECRET]);
  const accountId = firstDefined([config.accountId, process.env.CATFISH_ZOOM_ACCOUNT_ID]);

  if (!clientId || !clientSecret || !accountId) {
    return undefined;
  }

  return {
    clientId,
    clientSecret,
    accountId,
  };
}

const CATFISH_CONFIG_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    clientId: { type: "string" },
    clientSecret: { type: "string" },
    accountId: { type: "string" },
    requiredScope: { type: "string" },
    requiredScopes: {
      type: "array",
      items: { type: "string" },
    },
    oauthBaseUrl: { type: "string" },
    apiBaseUrl: { type: "string" },
    usersListPageSize: { type: "number" },
    usersListMaxPages: { type: "number" },
    cacheTtlMs: { type: "number" },
    auditLogPath: { type: "string" },
  },
} as const;

export const catfishConfigSchema: OpenClawPluginConfigSchema = {
  safeParse(value: unknown): ConfigSafeParseResult {
    if (value !== undefined && !asRecord(value)) {
      return {
        success: false,
        error: {
          issues: [{ path: [], message: "expected config object" }],
        },
      };
    }

    return {
      success: true,
      data: parseCatfishConfig(value),
    };
  },
  parse: parseCatfishConfig,
  jsonSchema: CATFISH_CONFIG_JSON_SCHEMA,
  uiHints: {
    clientId: {
      label: "Zoom Client ID",
      help: "Dedicated Catfish OAuth client id.",
    },
    clientSecret: {
      label: "Zoom Client Secret",
      help: "Dedicated Catfish OAuth client secret.",
      sensitive: true,
    },
    accountId: {
      label: "Zoom Account ID",
      help: "Zoom account id for account_credentials grant.",
    },
    requiredScopes: {
      label: "Required Scopes",
      help: "Default includes teamchat:admin:write and team_chat:write:user_message:admin.",
    },
    auditLogPath: {
      label: "Audit Log Path",
      help: "Optional JSONL path for privileged send audit logs.",
    },
  },
};
