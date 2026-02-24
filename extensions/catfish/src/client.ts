import { join } from "node:path";
import { appendCatfishAuditRecord } from "./audit.js";
import {
  parseCatfishConfig,
  resolveCatfishCredentials,
  type CatfishCredentials,
  type CatfishRuntimeConfig,
} from "./config.js";
import {
  CatfishError,
  authFailedError,
  invalidJidError,
  invalidTargetError,
  isCatfishError,
  mapApiError,
  toErrorMessage,
} from "./errors.js";
import { getCatfishAccessToken } from "./token.js";
import {
  createZoomUserLookupResolver,
  extractZoomUserIdFromJid,
  type ZoomApiResult,
  type ZoomResolvedIdentity,
} from "./zoom-user-lookup.js";

export type CatfishSendTargetType = "auto" | "dm" | "channel";
export type CatfishResolvedTargetType = "dm" | "channel";

export type CatfishSendOptions = {
  targetType?: CatfishSendTargetType;
};

export type CatfishSendResult = {
  ok: true;
  status: number;
  senderUserId: string;
  targetType: CatfishResolvedTargetType;
  targetId: string;
  messageId?: string;
  requestId?: string;
};

export type CatfishClient = {
  send: (
    jid: string,
    target: string,
    message: string,
    options?: CatfishSendOptions,
  ) => Promise<CatfishSendResult>;
  setStateDir: (stateDir: string) => void;
  getAuditLogPath: () => string;
};

type CatfishClientLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type CatfishApiResponse<T> = ZoomApiResult<T> & {
  headers?: Headers;
};

const CONFERENCE_SUFFIX = "@conference.xmpp.zoom.us";
const DM_SUFFIX = "@xmpp.zoom.us";

function defaultAuditLogPath(): string {
  const home = process.env.HOME ?? "/tmp";
  return join(home, ".openclaw", "data", "catfish", "catfish-audit.jsonl");
}

function normalizeTargetType(
  target: string,
  targetType: CatfishSendTargetType,
): CatfishResolvedTargetType {
  if (targetType === "dm" || targetType === "channel") {
    return targetType;
  }

  const lower = target.toLowerCase();
  if (lower.endsWith(CONFERENCE_SUFFIX)) {
    return "channel";
  }

  return "dm";
}

function trimOrThrow(value: string, code: "jid" | "target" | "message"): string {
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }

  if (code === "jid") {
    throw invalidJidError(value);
  }
  if (code === "target") {
    throw invalidTargetError(value);
  }

  throw new CatfishError({
    code: "CATFISH_API_ERROR",
    message: "message cannot be empty",
  });
}

function extractChannelId(target: string): string {
  const trimmed = target.trim();
  const lower = trimmed.toLowerCase();
  if (lower.endsWith(CONFERENCE_SUFFIX)) {
    const atIndex = trimmed.indexOf("@");
    if (atIndex <= 0) {
      throw invalidTargetError(target);
    }
    return trimmed.slice(0, atIndex);
  }

  if (lower.endsWith(DM_SUFFIX)) {
    throw invalidTargetError(target);
  }

  return trimmed;
}

function extractRequestId(headers?: Headers): string | undefined {
  return headers?.get("x-zm-trackingid") ?? headers?.get("x-zm-traceid") ?? undefined;
}

export function createCatfishClient(params?: {
  config?: CatfishRuntimeConfig;
  logger?: CatfishClientLogger;
  stateDir?: string;
}): CatfishClient {
  const logger = params?.logger;
  const config = params?.config ?? parseCatfishConfig(undefined);
  let stateDir = params?.stateDir;

  const resolveAuditPath = (): string => {
    if (config.auditLogPath) {
      return config.auditLogPath;
    }
    if (stateDir) {
      return join(stateDir, "plugins", "catfish", "catfish-audit.jsonl");
    }
    return defaultAuditLogPath();
  };

  const resolveCredentials = (): CatfishCredentials => {
    const creds = resolveCatfishCredentials(config);
    if (!creds) {
      throw authFailedError(
        "Catfish credentials not configured (clientId/clientSecret/accountId or CATFISH_ZOOM_* env vars)",
      );
    }
    return creds;
  };

  const zoomApiFetch = async <T>(
    endpoint: string,
    options: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown } = {},
    forceRefreshToken = false,
  ): Promise<CatfishApiResponse<T>> => {
    const creds = resolveCredentials();
    const token = await getCatfishAccessToken({
      creds,
      oauthBaseUrl: config.oauthBaseUrl,
      requiredScopes: config.requiredScopes,
      forceRefresh: forceRefreshToken,
    });

    const url = endpoint.startsWith("http") ? endpoint : `${config.apiBaseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token.accessToken}`,
      "Content-Type": "application/json",
    };

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const responseText = await response.text().catch(() => "");

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: responseText,
        headers: response.headers,
      };
    }

    let data: T | undefined;
    if (responseText) {
      try {
        data = JSON.parse(responseText) as T;
      } catch {
        data = undefined;
      }
    }

    return {
      ok: true,
      status: response.status,
      data,
      headers: response.headers,
    };
  };

  const userLookup = createZoomUserLookupResolver({
    apiFetch: (endpoint, options) => zoomApiFetch(endpoint, options),
    usersListPageSize: config.usersListPageSize,
    usersListMaxPages: config.usersListMaxPages,
    cacheTtlMs: config.cacheTtlMs,
    logger,
  });

  const resolveSender = async (
    senderJid: string,
  ): Promise<{
    senderPathUser: string;
    senderLocal: string;
    senderIdentity: ZoomResolvedIdentity;
  }> => {
    const senderLocal = extractZoomUserIdFromJid(senderJid);
    if (!senderLocal) {
      throw invalidJidError(senderJid);
    }

    const senderIdentity = await userLookup.resolveIdentity([senderJid, senderLocal]);
    const senderPathUser = senderIdentity.userId ?? senderIdentity.email ?? senderLocal;

    return {
      senderPathUser,
      senderLocal,
      senderIdentity,
    };
  };

  const resolveDmTarget = async (target: string): Promise<string> => {
    const lower = target.toLowerCase();
    if (lower.endsWith(CONFERENCE_SUFFIX)) {
      throw invalidTargetError(target);
    }

    const localFromJid = extractZoomUserIdFromJid(target);
    if (!localFromJid) {
      return target;
    }

    const identity = await userLookup.resolveIdentity([target, localFromJid]);
    return identity.userId ?? identity.email ?? localFromJid;
  };

  const resolveTarget = async (
    target: string,
    targetType: CatfishSendTargetType,
  ): Promise<{
    resolvedType: CatfishResolvedTargetType;
    resolvedTarget: string;
    payloadField: "to_contact" | "to_channel";
  }> => {
    const resolvedType = normalizeTargetType(target, targetType);
    if (resolvedType === "channel") {
      return {
        resolvedType,
        resolvedTarget: extractChannelId(target),
        payloadField: "to_channel",
      };
    }

    return {
      resolvedType,
      resolvedTarget: await resolveDmTarget(target),
      payloadField: "to_contact",
    };
  };

  return {
    setStateDir(nextStateDir: string): void {
      stateDir = nextStateDir;
    },

    getAuditLogPath(): string {
      return resolveAuditPath();
    },

    async send(
      jid: string,
      target: string,
      message: string,
      options?: CatfishSendOptions,
    ): Promise<CatfishSendResult> {
      const rawMessage = message;
      let senderJid = jid;
      let rawTarget = target;
      let senderInfo:
        | {
            senderPathUser: string;
            senderLocal: string;
            senderIdentity: ZoomResolvedIdentity;
          }
        | undefined;
      let targetInfo:
        | {
            resolvedType: CatfishResolvedTargetType;
            resolvedTarget: string;
            payloadField: "to_contact" | "to_channel";
          }
        | undefined;
      let response:
        | CatfishApiResponse<{
            id?: string;
            message_id?: string;
          }>
        | undefined;
      let text = message;

      try {
        senderJid = trimOrThrow(jid, "jid");
        rawTarget = trimOrThrow(target, "target");
        text = trimOrThrow(message, "message");

        senderInfo = await resolveSender(senderJid);
        targetInfo = await resolveTarget(rawTarget, options?.targetType ?? "auto");

        const endpoint = `/chat/users/${encodeURIComponent(senderInfo.senderPathUser)}/messages`;
        const payload: Record<string, unknown> = {
          message: text,
          [targetInfo.payloadField]: targetInfo.resolvedTarget,
        };

        response = await zoomApiFetch<{
          id?: string;
          message_id?: string;
        }>(endpoint, {
          method: "POST",
          body: payload,
        });

        if (response.status === 401) {
          response = await zoomApiFetch(endpoint, { method: "POST", body: payload }, true);
        }

        if (!response.ok) {
          throw mapApiError(response.status, response.error ?? "");
        }

        const requestId = extractRequestId(response.headers);

        const result: CatfishSendResult = {
          ok: true,
          status: response.status,
          senderUserId: senderInfo.senderPathUser,
          targetType: targetInfo.resolvedType,
          targetId: targetInfo.resolvedTarget,
          messageId: response.data?.message_id ?? response.data?.id,
          requestId,
        };

        await appendCatfishAuditRecord({
          filePath: resolveAuditPath(),
          logger,
          record: {
            timestamp: new Date().toISOString(),
            senderJid,
            senderResolvedUserId: senderInfo.senderIdentity.userId,
            senderResolvedEmail: senderInfo.senderIdentity.email,
            senderLookupSource: senderInfo.senderIdentity.source,
            targetRaw: rawTarget,
            targetType: targetInfo.resolvedType,
            targetResolved: targetInfo.resolvedTarget,
            payloadField: targetInfo.payloadField,
            message: rawMessage,
            ok: true,
            status: response.status,
            requestId,
          },
        });

        logger?.info?.(
          `catfish send ok sender=${senderInfo.senderPathUser} target=${targetInfo.resolvedTarget} type=${targetInfo.resolvedType}`,
        );

        return result;
      } catch (err) {
        const requestId = extractRequestId(response?.headers);
        const mapped = isCatfishError(err)
          ? err
          : new CatfishError({
              code: "CATFISH_API_ERROR",
              message: toErrorMessage(err),
              cause: err,
            });

        const targetType =
          targetInfo?.resolvedType ?? normalizeTargetType(rawTarget, options?.targetType ?? "auto");
        const payloadField =
          targetInfo?.payloadField ?? (targetType === "channel" ? "to_channel" : "to_contact");
        const targetResolved = targetInfo?.resolvedTarget ?? (rawTarget.trim() || rawTarget);

        await appendCatfishAuditRecord({
          filePath: resolveAuditPath(),
          logger,
          record: {
            timestamp: new Date().toISOString(),
            senderJid,
            senderResolvedUserId: senderInfo?.senderIdentity.userId,
            senderResolvedEmail: senderInfo?.senderIdentity.email,
            senderLookupSource: senderInfo?.senderIdentity.source,
            targetRaw: rawTarget,
            targetType,
            targetResolved,
            payloadField,
            message: rawMessage,
            ok: false,
            status: mapped.statusCode ?? response?.status,
            requestId,
            errorCode: mapped.code,
            errorMessage: mapped.message,
          },
        });

        logger?.error?.(`catfish send failed code=${mapped.code} message=${mapped.message}`);
        throw mapped;
      }
    },
  };
}
