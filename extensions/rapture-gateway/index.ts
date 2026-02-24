import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { emptyPluginConfigSchema, stringEnum } from "openclaw/plugin-sdk";

const GATEWAY_IDS = ["zoom", "ringcentral", "teams", "goto", "dialpad", "custom"] as const;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const SESSION_TTL_MS = 270_000; // Reconnect before the upstream 5 minute timeout.
const AUTH_TOKEN_TTL_MS = 55 * 60_000;
const RC_TOKEN_TTL_SECONDS = 3000;
const ZOOM_TOKEN_TTL_SECONDS = 3300;

type GatewayId = (typeof GATEWAY_IDS)[number];
type HttpMethod = (typeof HTTP_METHODS)[number];
type ProvisionableGatewayId = "zoom" | "ringcentral";

interface GatewayTarget {
  gateway: GatewayId;
  baseUrl: string;
  tenant: string;
  app?: string;
  apiPrefix: string;
}

interface SessionState {
  sessionId: string;
  createdAt: number;
  credentialId?: string;
}

interface GatewayResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

interface WorkflowAuthConfig {
  apiUrl: string;
  authPath: string;
  submitPath: string;
  username: string;
  password: string;
}

interface RaptureGroupCredential {
  credentialId?: string;
  accountId: string;
  clientId: string;
  clientSecret: string;
  accountLabel?: string;
}

interface RaptureCredentialOption {
  credentialId: string;
  accountId?: string;
  accountLabel?: string;
}

interface OrgCredentialSelection {
  credentialId?: string;
  accountLabel?: string;
  requesterEmail?: string;
}

interface OrgProvisionResult {
  provisioned: boolean;
  credentialId?: string;
  accountLabel?: string;
}

interface RaptureFrontendLoginCredentials {
  username: string;
  password: string;
}

type RedisClientLike = {
  connect(): Promise<void>;
  quit(): Promise<void>;
  hSet(key: string, value: Record<string, string>): Promise<unknown>;
  sAdd(key: string, member: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  exists?(key: string): Promise<number>;
};

type RedisModuleLike = {
  createClient(options?: { url?: string }): RedisClientLike;
};

type OrgProvisioner = (
  target: GatewayTarget,
  selection?: OrgCredentialSelection,
) => Promise<boolean | OrgProvisionResult>;

const sessionCache = new Map<string, SessionState>();
const targetCredentialCache = new Map<string, string>();
const requesterCredentialSelectionCache = new Map<string, string>();
const authTokenCache = new Map<string, { token: string; expiresAt: number }>();
const playbookInjectedSessions = new Set<string>();
let orgProvisionerForTests: OrgProvisioner | undefined;

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return jsonResult({ ok: false, error: message });
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return undefined;
  }
  return num;
}

function asTruthyEnv(value: string | undefined): boolean | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseCsv(value: string | undefined): string[] {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function envFirst(...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = asTrimmedString(process.env[name]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function gatewaySupportsOrgProvisioning(gateway: GatewayId): gateway is ProvisionableGatewayId {
  return gateway === "zoom" || gateway === "ringcentral";
}

function normalizeTenantEnvSuffix(tenant: string): string {
  const normalized = tenant
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "DEFAULT";
}

function resolveDefaultTenant(): string {
  return envFirst("RAPTURE_TENANT_NAME", "GATEWAY_TENANT_NAME", "TESSERACT_TENANT_NAME") ?? "cloudwarriors";
}

function resolveOrgEmailEnforcementEnabled(): boolean {
  const explicit = asTruthyEnv(envFirst("RAPTURE_ENFORCE_ORG_EMAIL", "RAPTURE_REQUIRE_ORG_EMAIL"));
  return explicit ?? true;
}

function resolveOrgEmailEnforcedChannels(): Set<string> {
  const configured = parseCsv(envFirst("RAPTURE_ORG_EMAIL_ENFORCED_CHANNELS"));
  const channels = configured.length > 0 ? configured : ["zoom"];
  return new Set(channels.map((entry) => entry.toLowerCase()));
}

function resolvePlaybookInjectionEnabled(): boolean {
  const explicit = asTruthyEnv(
    envFirst("RAPTURE_INJECT_PLAYBOOK", "RAPTURE_ENABLE_PLAYBOOK_INJECTION"),
  );
  return explicit ?? false;
}

function resolveAllowedOrgEmails(tenant: string): Set<string> {
  const tenantSuffix = normalizeTenantEnvSuffix(tenant);
  const emails = [
    ...parseCsv(envFirst("RAPTURE_ALLOWED_ORG_EMAILS", "RAPTURE_ALLOWED_EMAILS")),
    ...parseCsv(
      envFirst(
        `RAPTURE_ALLOWED_ORG_EMAILS_${tenantSuffix}`,
        `RAPTURE_ALLOWED_EMAILS_${tenantSuffix}`,
      ),
    ),
  ].map((entry) => entry.toLowerCase());
  return new Set(emails);
}

function resolveAllowedOrgDomains(tenant: string): Set<string> {
  const tenantSuffix = normalizeTenantEnvSuffix(tenant);
  const domains = [
    ...parseCsv(envFirst("RAPTURE_ALLOWED_ORG_DOMAINS", "RAPTURE_ALLOWED_EMAIL_DOMAINS")),
    ...parseCsv(
      envFirst(
        `RAPTURE_ALLOWED_ORG_DOMAINS_${tenantSuffix}`,
        `RAPTURE_ALLOWED_EMAIL_DOMAINS_${tenantSuffix}`,
      ),
    ),
  ]
    .map((entry) => entry.toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  if (domains.length === 0 && tenant.trim().toLowerCase() === "cloudwarriors") {
    domains.push("cloudwarriors.ai");
  }
  return new Set(domains);
}

function normalizeEmail(value: unknown): string | undefined {
  const email = asTrimmedString(value)?.toLowerCase();
  if (!email) {
    return undefined;
  }
  const atIndex = email.indexOf("@");
  if (atIndex <= 0 || atIndex >= email.length - 1) {
    return undefined;
  }
  return email;
}

function resolveRequesterEmail(ctx: OpenClawPluginToolContext): string | undefined {
  const explicit = normalizeEmail(ctx.senderEmail);
  if (explicit) {
    return explicit;
  }
  return normalizeEmail(ctx.senderUsername);
}

function formatRequesterIdentityDebug(ctx: OpenClawPluginToolContext): string {
  const channel = asTrimmedString(ctx.messageChannel) ?? "-";
  const senderId = asTrimmedString(ctx.senderId) ?? "-";
  const senderName = asTrimmedString(ctx.senderName) ?? "-";
  const senderEmail = asTrimmedString(ctx.senderEmail) ?? "-";
  const senderUsername = asTrimmedString(ctx.senderUsername) ?? "-";
  return `Observed sender context: channel=${channel}, senderId=${senderId}, senderName=${senderName}, senderEmail=${senderEmail}, senderUsername=${senderUsername}.`;
}

function shouldEnforceOrgEmail(ctx: OpenClawPluginToolContext): boolean {
  if (!resolveOrgEmailEnforcementEnabled()) {
    return false;
  }
  const enforcedChannels = resolveOrgEmailEnforcedChannels();
  if (enforcedChannels.size === 0) {
    return false;
  }
  const channel = asTrimmedString(ctx.messageChannel)?.toLowerCase();
  if (channel === "webchat") {
    return false;
  }
  if (!channel) {
    return (
      asTruthyEnv(
        envFirst(
          "RAPTURE_ENFORCE_ORG_EMAIL_WITHOUT_CHANNEL",
          "RAPTURE_REQUIRE_ORG_EMAIL_WITHOUT_CHANNEL",
        ),
      ) ?? false
    );
  }
  return enforcedChannels.has(channel);
}

function shouldInjectPlaybook(params: {
  agentId?: string;
  sessionKey?: string;
  messageProvider?: string;
}): boolean {
  if (!resolvePlaybookInjectionEnabled()) {
    return false;
  }
  const agentId = asTrimmedString(params.agentId)?.toLowerCase();
  if (!agentId || !["main", "rapture", "tesseract"].includes(agentId)) {
    return false;
  }

  const messageProvider = asTrimmedString(params.messageProvider)?.toLowerCase();
  const sessionKey = asTrimmedString(params.sessionKey);
  const looksLikeZoomSession = sessionKey?.toLowerCase().includes(":zoom:") ?? false;
  if (messageProvider !== "zoom" && !looksLikeZoomSession) {
    return false;
  }

  const dedupeKey = `${agentId}|${sessionKey ?? "unknown"}`;
  if (playbookInjectedSessions.has(dedupeKey)) {
    return false;
  }
  playbookInjectedSessions.add(dedupeKey);
  if (playbookInjectedSessions.size > 2000) {
    playbookInjectedSessions.clear();
    playbookInjectedSessions.add(dedupeKey);
  }
  return true;
}

function isRequesterEmailAllowed(params: { tenant: string; email: string }): boolean {
  const allowedEmails = resolveAllowedOrgEmails(params.tenant);
  if (allowedEmails.has(params.email)) {
    return true;
  }
  const domain = params.email.split("@")[1];
  if (!domain) {
    return false;
  }
  const allowedDomains = resolveAllowedOrgDomains(params.tenant);
  return allowedDomains.has(domain);
}

function assertOrgEmailAuthorized(params: {
  toolName: string;
  tenant: string;
  toolContext: OpenClawPluginToolContext;
}): void {
  const { toolName, tenant, toolContext } = params;
  if (!shouldEnforceOrgEmail(toolContext)) {
    return;
  }
  const requesterEmail = resolveRequesterEmail(toolContext);
  if (!requesterEmail) {
    throw new Error(
      `${toolName} denied: missing requester email for tenant '${tenant}'. Ensure the channel supplies sender email and configure RAPTURE_ALLOWED_ORG_DOMAINS/RAPTURE_ALLOWED_ORG_EMAILS. ${formatRequesterIdentityDebug(toolContext)}`,
    );
  }
  if (isRequesterEmailAllowed({ tenant, email: requesterEmail })) {
    return;
  }
  const allowedDomains = Array.from(resolveAllowedOrgDomains(tenant));
  const domainHint =
    allowedDomains.length > 0
      ? `Allowed domains: ${allowedDomains.join(", ")}.`
      : "No allowed org domains configured.";
  throw new Error(
    `${toolName} denied: '${requesterEmail}' is not authorized for tenant '${tenant}'. ${domainHint}`,
  );
}

class CredentialSelectionRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialSelectionRequiredError";
  }
}

function isCredentialSelectionRequiredError(error: unknown): error is CredentialSelectionRequiredError {
  return error instanceof CredentialSelectionRequiredError;
}

function resolveOrgCredentialSelection(
  params: Record<string, unknown>,
  toolContext: OpenClawPluginToolContext,
): OrgCredentialSelection {
  return {
    credentialId: asTrimmedString(params.credential_id),
    accountLabel: asTrimmedString(params.account_label),
    requesterEmail: resolveRequesterEmail(toolContext),
  };
}

function requesterSelectionCacheKey(
  target: GatewayTarget,
  requesterEmail: string | undefined,
): string | undefined {
  const email = normalizeEmail(requesterEmail);
  if (!email || !gatewaySupportsOrgProvisioning(target.gateway)) {
    return undefined;
  }
  return `${target.tenant.toLowerCase()}|${target.gateway}|${email}`;
}

function formatCredentialChoices(options: RaptureCredentialOption[]): string {
  return options
    .map((option) => {
      const label = option.accountLabel ?? "Unlabeled";
      const accountId = option.accountId ? ` (${option.accountId})` : "";
      return `${option.credentialId}: ${label}${accountId}`;
    })
    .join("; ");
}

function throwCredentialSelectionRequired(params: {
  gateway: ProvisionableGatewayId;
  target: GatewayTarget;
  requesterEmail?: string;
  options: RaptureCredentialOption[];
}): never {
  const requester = params.requesterEmail
    ? ` for requester '${params.requesterEmail}'`
    : "";
  throw new CredentialSelectionRequiredError(
    `Multiple active ${params.gateway} credentials were found in tenant '${params.target.tenant}'${requester}. ` +
      `Re-run with credential_id or account_label. Options: ${formatCredentialChoices(params.options)}`,
  );
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlash(baseUrl)}${normalizePath(path)}`;
}

function parseJsonObject(raw: unknown, paramName: string): Record<string, unknown> | undefined {
  const text = asTrimmedString(raw);
  if (!text) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${paramName} must be valid JSON.`);
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new Error(`${paramName} must be a JSON object.`);
  }
  return record;
}

function parseJsonValue(raw: unknown, paramName: string): unknown {
  const text = asTrimmedString(raw);
  if (!text) {
    throw new Error(`${paramName} is required and must be valid JSON.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${paramName} must be valid JSON.`);
  }
}

function appendQueryValue(searchParams: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      appendQueryValue(searchParams, key, item);
    }
    return;
  }
  if (typeof value === "object") {
    searchParams.append(key, JSON.stringify(value));
    return;
  }
  if (typeof value === "string") {
    searchParams.append(key, value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    searchParams.append(key, String(value));
    return;
  }
  searchParams.append(key, JSON.stringify(value));
}

function buildRequestUrl(
  target: GatewayTarget,
  path: string,
  sessionId: string,
  query: Record<string, unknown> | undefined,
): URL {
  let effectivePath = normalizePath(path);
  const prefix = asTrimmedString(target.apiPrefix);
  if (prefix) {
    const normalizedPrefix = normalizePath(prefix);
    if (effectivePath !== normalizedPrefix && !effectivePath.startsWith(`${normalizedPrefix}/`)) {
      effectivePath = `${normalizedPrefix}${effectivePath}`;
    }
  }
  const url = new URL(joinUrl(target.baseUrl, effectivePath));
  appendQueryValue(url.searchParams, "session_id", sessionId);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      appendQueryValue(url.searchParams, key, value);
    }
  }
  return url;
}

async function parseResponseData(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function formatHttpError(status: number, data: unknown): string {
  if (typeof data === "string") {
    return `HTTP ${status}: ${data.slice(0, 500)}`;
  }
  return `HTTP ${status}: ${JSON.stringify(data).slice(0, 500)}`;
}

function resolveGatewayBaseUrl(gateway: GatewayId, override?: string): string {
  const explicit = asTrimmedString(override);
  if (explicit) {
    return trimTrailingSlash(explicit);
  }

  const shared = envFirst("RAPTURE_GATEWAY_URL", "TESSERACT_GATEWAY_URL");

  const byGateway: Record<Exclude<GatewayId, "custom">, string | undefined> = {
    zoom: envFirst(
      "RAPTURE_ZOOM_GATEWAY_URL",
      "TESSERACT_ZOOM_GATEWAY_URL",
      "ZOOM_GATEWAY_URL",
      "TESSERACT_GATEWAY_ZOOM_URL",
    ),
    ringcentral: envFirst(
      "RAPTURE_RINGCENTRAL_GATEWAY_URL",
      "TESSERACT_RINGCENTRAL_GATEWAY_URL",
      "RINGCENTRAL_GATEWAY_URL",
      "TESSERACT_GATEWAY_RINGCENTRAL_URL",
    ),
    teams: envFirst(
      "RAPTURE_TEAMS_GATEWAY_URL",
      "TESSERACT_TEAMS_GATEWAY_URL",
      "TEAMS_GATEWAY_URL",
    ),
    goto: envFirst("RAPTURE_GOTO_GATEWAY_URL", "TESSERACT_GOTO_GATEWAY_URL", "GOTO_GATEWAY_URL"),
    dialpad: envFirst(
      "RAPTURE_DIALPAD_GATEWAY_URL",
      "TESSERACT_DIALPAD_GATEWAY_URL",
      "DIALPAD_GATEWAY_URL",
    ),
  };

  const fromEnv = gateway === "custom" ? shared : (byGateway[gateway] ?? shared);
  if (!fromEnv) {
    throw new Error(
      `Missing gateway URL for '${gateway}'. Set base_url or env vars (for example RAPTURE_${gateway.toUpperCase()}_GATEWAY_URL).`,
    );
  }
  return trimTrailingSlash(fromEnv);
}

function resolveGatewayApp(gateway: GatewayId, override?: string): string | undefined {
  const explicit = asTrimmedString(override);
  if (explicit) {
    return explicit;
  }
  const shared = envFirst("RAPTURE_GATEWAY_APP", "TESSERACT_GATEWAY_APP");
  if (shared) {
    return shared;
  }
  if (gateway === "custom") {
    return undefined;
  }
  return gateway;
}

function resolveGatewayPrefix(gateway: GatewayId, override?: string): string {
  const explicit = asTrimmedString(override);
  if (explicit) {
    return explicit;
  }
  if (gateway === "ringcentral") {
    return (
      envFirst("RAPTURE_RINGCENTRAL_API_PREFIX", "TESSERACT_RINGCENTRAL_API_PREFIX") ??
      "/voice-proxy/account/~"
    );
  }
  return "";
}

function resolveGatewayTarget(params: Record<string, unknown>): GatewayTarget {
  const gatewayRaw = asTrimmedString(params.gateway)?.toLowerCase() as GatewayId | undefined;
  if (!gatewayRaw || !GATEWAY_IDS.includes(gatewayRaw)) {
    throw new Error(`gateway must be one of: ${GATEWAY_IDS.join(", ")}`);
  }
  const defaultTenant = resolveDefaultTenant();
  const tenant = asTrimmedString(params.tenant) ?? defaultTenant;
  const allowedTenants = (
    envFirst("RAPTURE_ALLOWED_TENANTS", "TESSERACT_ALLOWED_TENANTS") ?? defaultTenant
  )
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!allowedTenants.includes(tenant.toLowerCase())) {
    throw new Error(
      `Tenant '${tenant}' is not allowed. Configure RAPTURE_ALLOWED_TENANTS to permit additional tenants.`,
    );
  }
  return {
    gateway: gatewayRaw,
    baseUrl: resolveGatewayBaseUrl(gatewayRaw, asTrimmedString(params.base_url)),
    tenant,
    app: resolveGatewayApp(gatewayRaw, asTrimmedString(params.app)),
    apiPrefix: resolveGatewayPrefix(gatewayRaw, asTrimmedString(params.api_prefix)),
  };
}

function sessionKey(target: GatewayTarget): string {
  return [target.gateway, target.baseUrl, target.tenant, target.app ?? ""].join("|");
}

function isProviderNotFoundError(status: number, data: unknown): boolean {
  if (status !== 404) {
    return false;
  }
  if (typeof data === "string") {
    return /provider/i.test(data) && /not found/i.test(data);
  }
  const payload = asRecord(data);
  const detail = asTrimmedString(payload?.detail);
  const message = asTrimmedString(payload?.message);
  const combined = [detail, message, JSON.stringify(data)].filter(Boolean).join(" ");
  return /provider/i.test(combined) && /not found/i.test(combined);
}

function resolveOrgProvisionEnabled(): boolean {
  const explicit = asTruthyEnv(
    envFirst("RAPTURE_ORG_AUTH_ENABLED", "RAPTURE_GATEWAY_ORG_AUTH_ENABLED"),
  );
  return explicit ?? true;
}

function resolveRaptureFrontendBaseUrl(): string | undefined {
  const explicit = envFirst("RAPTURE_FRONTEND_URL", "FRONTEND_URL");
  if (explicit) {
    return trimTrailingSlash(explicit);
  }
  const jobsUrl = envFirst("RAPTURE_JOBS_STATUS_URL");
  if (jobsUrl) {
    try {
      const parsed = new URL(jobsUrl);
      return trimTrailingSlash(`${parsed.protocol}//${parsed.host}`);
    } catch {
      // Ignore malformed jobs URL and continue fallback resolution.
    }
  }
  const apiUrl = envFirst("RAPTURE_API_URL");
  if (!apiUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(apiUrl);
    return trimTrailingSlash(`${parsed.protocol}//${parsed.host}`);
  } catch {
    return undefined;
  }
}

function resolveRaptureFrontendLoginCredentials(): RaptureFrontendLoginCredentials | undefined {
  const username = envFirst("RAPTURE_FRONTEND_USERNAME", "RAPTURE_USERNAME");
  const password = envFirst("RAPTURE_FRONTEND_PASSWORD", "RAPTURE_PASSWORD");
  if ((username && !password) || (!username && password)) {
    throw new Error(
      "Incomplete Rapture frontend login credentials. Set both RAPTURE_FRONTEND_USERNAME and RAPTURE_FRONTEND_PASSWORD.",
    );
  }
  if (!username || !password) {
    return undefined;
  }
  return { username, password };
}

function normalizeFrontendAuthorization(value: string): string {
  return /^(bearer|token)\s+/i.test(value) ? value : `Bearer ${value}`;
}

function extractCookiePair(rawSetCookie: string, cookieName: string): string | undefined {
  const escapedName = cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[;,]\\s*)(${escapedName}=([^;\\s,]+))`, "i");
  const match = pattern.exec(rawSetCookie);
  return match?.[1];
}

function extractCookieValueFromPair(cookiePair: string | undefined): string | undefined {
  if (!cookiePair) {
    return undefined;
  }
  const equalsAt = cookiePair.indexOf("=");
  if (equalsAt <= 0 || equalsAt >= cookiePair.length - 1) {
    return undefined;
  }
  return cookiePair.slice(equalsAt + 1);
}

function extractCsrfTokenFromHtml(html: string): string | undefined {
  const tokenMatch =
    /name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)["']/i.exec(html) ??
    /value=["']([^"']+)["'][^>]*name=["']csrfmiddlewaretoken["']/i.exec(html);
  return asTrimmedString(tokenMatch?.[1]);
}

async function loginToRaptureFrontend(
  frontendUrl: string,
  credentials: RaptureFrontendLoginCredentials,
): Promise<string> {
  const loginUrl = joinUrl(frontendUrl, "/accounts/login/");
  const loginPageResponse = await fetch(loginUrl, {
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "manual",
  });
  const loginPageBody = await loginPageResponse.text();
  if (loginPageResponse.status >= 400) {
    throw new Error(
      `Rapture frontend login bootstrap failed. ${formatHttpError(loginPageResponse.status, loginPageBody)}`,
    );
  }

  const loginPageCookies = loginPageResponse.headers.get("set-cookie") ?? "";
  const csrfPair = extractCookiePair(loginPageCookies, "csrftoken");
  const csrfToken = extractCookieValueFromPair(csrfPair) ?? extractCsrfTokenFromHtml(loginPageBody);
  if (!csrfToken) {
    throw new Error(
      "Unable to derive CSRF token from Rapture frontend login page. Provide RAPTURE_FRONTEND_SESSION_COOKIE directly.",
    );
  }

  const form = new URLSearchParams({
    login: credentials.username,
    password: credentials.password,
    csrfmiddlewaretoken: csrfToken,
  });
  const cookieHeader = [`csrftoken=${csrfToken}`].join("; ");

  const loginResponse = await fetch(loginUrl, {
    method: "POST",
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "content-type": "application/x-www-form-urlencoded",
      referer: loginUrl,
      cookie: cookieHeader,
    },
    body: form.toString(),
    redirect: "manual",
  });
  const loginBody = await loginResponse.text();
  const loginSetCookie = loginResponse.headers.get("set-cookie") ?? "";
  const sessionPair = extractCookiePair(loginSetCookie, "sessionid");
  const finalCsrfPair = extractCookiePair(loginSetCookie, "csrftoken") ?? `csrftoken=${csrfToken}`;
  if (!sessionPair) {
    throw new Error(
      `Rapture frontend login did not return a session cookie. ${formatHttpError(loginResponse.status, loginBody)}`,
    );
  }

  return [sessionPair, finalCsrfPair].filter(Boolean).join("; ");
}

async function resolveRaptureFrontendAuthHeaders(frontendUrl: string): Promise<Record<string, string>> {
  const bearer = envFirst("RAPTURE_FRONTEND_BEARER_TOKEN");
  const cookieRaw = envFirst("RAPTURE_FRONTEND_SESSION_COOKIE");
  const headers: Record<string, string> = { accept: "application/json" };
  if (bearer) {
    headers.authorization = normalizeFrontendAuthorization(bearer);
  }
  if (cookieRaw) {
    headers.cookie = cookieRaw.includes("=") ? cookieRaw : `sessionid=${cookieRaw}`;
  }
  if (!headers.authorization && !headers.cookie) {
    const credentials = resolveRaptureFrontendLoginCredentials();
    if (credentials) {
      headers.cookie = await loginToRaptureFrontend(frontendUrl, credentials);
    }
  }
  return headers;
}

function resolveCredentialLookupUrl(
  gateway: ProvisionableGatewayId,
  frontendUrl: string,
  credentialIdOverride?: string,
): string {
  const url = new URL(joinUrl(frontendUrl, `/get_credentials/${gateway}/`));
  const envName = `RAPTURE_${gateway.toUpperCase()}_CREDENTIAL_ID`;
  const credentialId = asTrimmedString(credentialIdOverride) ?? envFirst(envName, "RAPTURE_CREDENTIAL_ID");
  if (credentialId) {
    url.searchParams.set("credential_id", credentialId);
  }
  return url.toString();
}

function resolveCredentialListUrl(gateway: ProvisionableGatewayId, frontendUrl: string): string {
  const url = new URL(joinUrl(frontendUrl, "/api/credentials/"));
  url.searchParams.set("platform", gateway);
  return url.toString();
}

function resolveGatewayRedisUrl(): string {
  const explicit = envFirst(
    "RAPTURE_GATEWAY_REDIS_URL",
    "TESSERACT_GATEWAY_REDIS_URL",
    "GATEWAY_REDIS_URL",
  );
  if (explicit) {
    return explicit;
  }
  const host =
    envFirst("RAPTURE_GATEWAY_REDIS_HOST", "TESSERACT_GATEWAY_REDIS_HOST", "GATEWAY_REDIS_HOST") ??
    "localhost";
  const port = Math.max(
    1,
    Math.floor(
      asFiniteNumber(
        envFirst(
          "RAPTURE_GATEWAY_REDIS_PORT",
          "TESSERACT_GATEWAY_REDIS_PORT",
          "GATEWAY_REDIS_PORT",
        ) ?? "6381",
      ) ?? 6381,
    ),
  );
  const db = Math.max(
    0,
    Math.floor(
      asFiniteNumber(
        envFirst("RAPTURE_GATEWAY_REDIS_DB", "TESSERACT_GATEWAY_REDIS_DB", "GATEWAY_REDIS_DB") ??
          "0",
      ) ?? 0,
    ),
  );
  const username = envFirst(
    "RAPTURE_GATEWAY_REDIS_USERNAME",
    "TESSERACT_GATEWAY_REDIS_USERNAME",
    "GATEWAY_REDIS_USERNAME",
  );
  const password = envFirst(
    "RAPTURE_GATEWAY_REDIS_PASSWORD",
    "TESSERACT_GATEWAY_REDIS_PASSWORD",
    "GATEWAY_REDIS_PASSWORD",
  );
  const tlsEnabled =
    asTruthyEnv(
      envFirst("RAPTURE_GATEWAY_REDIS_TLS", "TESSERACT_GATEWAY_REDIS_TLS", "GATEWAY_REDIS_TLS"),
    ) ?? false;
  const scheme = tlsEnabled ? "rediss" : "redis";
  const auth = username
    ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ""}@`
    : password
      ? `:${encodeURIComponent(password)}@`
      : "";
  return `${scheme}://${auth}${host}:${port}/${db}`;
}

let redisModulePromise: Promise<RedisModuleLike> | undefined;

async function loadRedisModule(): Promise<RedisModuleLike> {
  if (!redisModulePromise) {
    redisModulePromise = (import("redis") as Promise<RedisModuleLike>).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        "rapture-gateway dependency missing: install extension runtime deps with " +
          "'cd extensions/rapture-gateway && npm install --omit=dev'. " +
          `Original error: ${detail}`,
      );
    });
  }
  return redisModulePromise;
}

async function fetchCredentialOptions(
  gateway: ProvisionableGatewayId,
  frontendUrl: string,
): Promise<RaptureCredentialOption[]> {
  const headers = await resolveRaptureFrontendAuthHeaders(frontendUrl);
  if (!headers.authorization && !headers.cookie) {
    throw new Error(
      "Missing Rapture frontend auth. Set RAPTURE_FRONTEND_SESSION_COOKIE, RAPTURE_FRONTEND_BEARER_TOKEN, or RAPTURE_FRONTEND_USERNAME + RAPTURE_FRONTEND_PASSWORD.",
    );
  }
  const response = await fetch(resolveCredentialListUrl(gateway, frontendUrl), {
    method: "GET",
    headers,
  });
  const data = await parseResponseData(response);
  if (!response.ok) {
    throw new Error(
      `Rapture credential list lookup failed for ${gateway}. ${formatHttpError(response.status, data)}`,
    );
  }
  const payload = asRecord(data);
  const credentialsRaw = Array.isArray(payload?.credentials) ? payload.credentials : [];
  return credentialsRaw
    .map((entry) => {
      const record = asRecord(entry);
      const credentialId = asTrimmedString(record?.id);
      if (!credentialId) {
        return null;
      }
      return {
        credentialId,
        accountId: asTrimmedString(record?.account_id),
        accountLabel: asTrimmedString(record?.account_label),
      } satisfies RaptureCredentialOption;
    })
    .filter((entry): entry is RaptureCredentialOption => Boolean(entry));
}

async function fetchRaptureGroupCredential(
  gateway: ProvisionableGatewayId,
  frontendUrl: string,
  credentialId?: string,
): Promise<RaptureGroupCredential> {
  const headers = await resolveRaptureFrontendAuthHeaders(frontendUrl);
  if (!headers.authorization && !headers.cookie) {
    throw new Error(
      "Missing Rapture frontend auth. Set RAPTURE_FRONTEND_SESSION_COOKIE, RAPTURE_FRONTEND_BEARER_TOKEN, or RAPTURE_FRONTEND_USERNAME + RAPTURE_FRONTEND_PASSWORD.",
    );
  }
  const response = await fetch(resolveCredentialLookupUrl(gateway, frontendUrl, credentialId), {
    method: "GET",
    headers,
  });
  const data = await parseResponseData(response);
  if (!response.ok) {
    throw new Error(
      `Rapture credential lookup failed for ${gateway}. ${formatHttpError(response.status, data)}`,
    );
  }
  const payload = asRecord(data);
  const accountId = asTrimmedString(payload?.account_id);
  const clientId = asTrimmedString(payload?.client_id);
  const clientSecret = asTrimmedString(payload?.client_secret);
  if (!accountId || !clientId || !clientSecret) {
    throw new Error(
      `Rapture credentials for ${gateway} are incomplete. Expected account_id, client_id, and client_secret.`,
    );
  }
  return {
    credentialId: asTrimmedString(payload?.credential_id),
    accountId,
    clientId,
    clientSecret,
    accountLabel: asTrimmedString(payload?.account_label),
  };
}

async function resolveCredentialForProvisioning(params: {
  target: GatewayTarget;
  gateway: ProvisionableGatewayId;
  frontendUrl: string;
  selection?: OrgCredentialSelection;
}): Promise<RaptureGroupCredential> {
  const explicitCredentialId = asTrimmedString(params.selection?.credentialId);
  if (explicitCredentialId) {
    const credential = await fetchRaptureGroupCredential(
      params.gateway,
      params.frontendUrl,
      explicitCredentialId,
    );
    const cacheKey = requesterSelectionCacheKey(params.target, params.selection?.requesterEmail);
    if (cacheKey && credential.credentialId) {
      requesterCredentialSelectionCache.set(cacheKey, credential.credentialId);
    }
    return credential;
  }

  const requestedLabel = asTrimmedString(params.selection?.accountLabel)?.toLowerCase();
  const cacheKey = requesterSelectionCacheKey(params.target, params.selection?.requesterEmail);
  const cachedCredentialId = cacheKey ? requesterCredentialSelectionCache.get(cacheKey) : undefined;

  if (!requestedLabel && cachedCredentialId) {
    try {
      const credential = await fetchRaptureGroupCredential(
        params.gateway,
        params.frontendUrl,
        cachedCredentialId,
      );
      if (cacheKey && credential.credentialId) {
        requesterCredentialSelectionCache.set(cacheKey, credential.credentialId);
      }
      return credential;
    } catch {
      // Stale sender selection; continue into list-based resolution.
    }
  }

  // Resolve deterministic account selection for sender-scoped auth.
  if (requestedLabel || cacheKey) {
    let options: RaptureCredentialOption[] | undefined;
    try {
      options = await fetchCredentialOptions(params.gateway, params.frontendUrl);
    } catch (error) {
      if (requestedLabel || cachedCredentialId) {
        throw error;
      }
      options = undefined;
    }

    if (options && options.length > 0) {
      let chosen: RaptureCredentialOption | undefined;
      if (requestedLabel) {
        const matches = options.filter(
          (option) => option.accountLabel?.trim().toLowerCase() === requestedLabel,
        );
        if (matches.length > 1) {
          throw new CredentialSelectionRequiredError(
            `Multiple ${params.gateway} credentials matched account_label='${requestedLabel}'. ` +
              `Use credential_id explicitly. Options: ${formatCredentialChoices(matches)}`,
          );
        }
        chosen = matches[0];
        if (!chosen) {
          throw new Error(
            `No ${params.gateway} credential matched account_label='${requestedLabel}'. ` +
              `Available options: ${formatCredentialChoices(options)}`,
          );
        }
      } else if (cachedCredentialId) {
        chosen = options.find((option) => option.credentialId === cachedCredentialId);
      }

      if (!chosen) {
        if (options.length === 1) {
          chosen = options[0];
        } else {
          throwCredentialSelectionRequired({
            gateway: params.gateway,
            target: params.target,
            requesterEmail: normalizeEmail(params.selection?.requesterEmail),
            options,
          });
        }
      }

      const credential = await fetchRaptureGroupCredential(
        params.gateway,
        params.frontendUrl,
        chosen.credentialId,
      );
      if (cacheKey && credential.credentialId) {
        requesterCredentialSelectionCache.set(cacheKey, credential.credentialId);
      }
      return credential;
    }
  }

  const credential = await fetchRaptureGroupCredential(params.gateway, params.frontendUrl);
  if (cacheKey && credential.credentialId) {
    requesterCredentialSelectionCache.set(cacheKey, credential.credentialId);
  }
  return credential;
}

async function exchangeRingCentralJwt(credential: RaptureGroupCredential): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}> {
  const server = envFirst("RAPTURE_RINGCENTRAL_SERVER_URL", "RINGCENTRAL_SERVER_URL");
  const base = trimTrailingSlash(server ?? "https://platform.ringcentral.com");
  const tokenUrl = joinUrl(base, "/restapi/oauth/token");
  const authValue = Buffer.from(`${credential.clientId}:${credential.clientSecret}`).toString(
    "base64",
  );
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: credential.accountId,
  });
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${authValue}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: form.toString(),
  });
  const data = await parseResponseData(response);
  if (!response.ok) {
    throw new Error(`RingCentral JWT exchange failed. ${formatHttpError(response.status, data)}`);
  }
  const payload = asRecord(data);
  const accessToken = asTrimmedString(payload?.access_token);
  if (!accessToken) {
    throw new Error("RingCentral JWT exchange succeeded but no access_token was returned.");
  }
  return {
    accessToken,
    refreshToken: asTrimmedString(payload?.refresh_token),
    expiresIn: asFiniteNumber(payload?.expires_in),
  };
}

async function seedGatewayProviderCredential(
  target: GatewayTarget,
  credential: RaptureGroupCredential,
): Promise<void> {
  if (!gatewaySupportsOrgProvisioning(target.gateway)) {
    return;
  }
  const redisModule = await loadRedisModule();
  const redisUrl = resolveGatewayRedisUrl();
  const client = redisModule.createClient({ url: redisUrl });
  await client.connect();
  try {
    const tenantKeyPrefix = `tenant:${target.tenant}`;
    const providerKey = `${tenantKeyPrefix}:provider:${target.gateway}`;
    const configKey = `${tenantKeyPrefix}:config`;
    const providersSetKey = `${tenantKeyPrefix}:providers`;
    const systemKey = `${tenantKeyPrefix}:system:${target.gateway}`;

    const providerData: Record<string, string> = {
      api_key: credential.clientId,
      api_secret: credential.clientSecret,
      account_id: credential.accountId,
      client_id: credential.clientId,
      client_secret: credential.clientSecret,
      auth_type: "s2s_oauth",
      status: "active",
    };
    let ttlSeconds = ZOOM_TOKEN_TTL_SECONDS;

    if (target.gateway === "zoom") {
      providerData.api_base_url = "https://api.zoom.us/v2";
      providerData.features_enabled = '["users","phone","meetings"]';
    } else {
      const exchanged = await exchangeRingCentralJwt(credential);
      providerData.api_key = "";
      providerData.api_base_url = "https://platform.ringcentral.com";
      providerData.features_enabled = '["extensions","call_queues","sites"]';
      providerData.access_token = exchanged.accessToken;
      providerData.jwt_token = "";
      if (exchanged.refreshToken) {
        providerData.refresh_token = exchanged.refreshToken;
      }
      if (exchanged.expiresIn && exchanged.expiresIn > 0) {
        providerData.token_expiry = new Date(Date.now() + exchanged.expiresIn * 1000).toISOString();
      }
      ttlSeconds = RC_TOKEN_TTL_SECONDS;
    }

    await client.hSet(providerKey, providerData);
    await client.expire(providerKey, ttlSeconds);
    await client.sAdd(providersSetKey, target.gateway);

    const configExists = client.exists ? await client.exists(configKey) : 0;
    if (!configExists) {
      await client.hSet(configKey, {
        name: target.tenant,
        primary_provider: target.gateway,
        sync_strategy: "primary",
      });
    }

    await client.hSet(systemKey, {
      client_id: credential.clientId,
      client_secret: credential.clientSecret,
      account_id: credential.accountId,
    });
  } finally {
    await client.quit().catch(() => undefined);
  }
}

async function provisionGatewayFromRaptureOrg(
  target: GatewayTarget,
  selection?: OrgCredentialSelection,
): Promise<OrgProvisionResult> {
  if (!gatewaySupportsOrgProvisioning(target.gateway)) {
    return { provisioned: false };
  }
  if (!resolveOrgProvisionEnabled()) {
    return { provisioned: false };
  }
  const frontendUrl = resolveRaptureFrontendBaseUrl();
  if (!frontendUrl) {
    return { provisioned: false };
  }
  const credential = await resolveCredentialForProvisioning({
    target,
    gateway: target.gateway,
    frontendUrl,
    selection,
  });
  await seedGatewayProviderCredential(target, credential);
  return {
    provisioned: true,
    credentialId: credential.credentialId,
    accountLabel: credential.accountLabel,
  };
}

async function tryOrgProvision(
  target: GatewayTarget,
  selection?: OrgCredentialSelection,
): Promise<OrgProvisionResult> {
  if (orgProvisionerForTests) {
    const result = await orgProvisionerForTests(target, selection);
    if (typeof result === "boolean") {
      return { provisioned: result };
    }
    return result;
  }
  return provisionGatewayFromRaptureOrg(target, selection);
}

async function connectGateway(
  target: GatewayTarget,
  forceReconnect = false,
  orgSelection?: OrgCredentialSelection,
): Promise<SessionState> {
  const key = sessionKey(target);
  let shouldForceReconnect = forceReconnect;

  const shouldPreProvision =
    gatewaySupportsOrgProvisioning(target.gateway) &&
    resolveOrgProvisionEnabled() &&
    Boolean(
      asTrimmedString(orgSelection?.credentialId) ||
        asTrimmedString(orgSelection?.accountLabel) ||
        normalizeEmail(orgSelection?.requesterEmail),
    );

  if (shouldPreProvision) {
    const provision = await tryOrgProvision(target, orgSelection);
    if (provision.provisioned && provision.credentialId) {
      const previousCredential = targetCredentialCache.get(key);
      if (previousCredential && previousCredential !== provision.credentialId) {
        sessionCache.delete(key);
        shouldForceReconnect = true;
      }
      targetCredentialCache.set(key, provision.credentialId);
    }
  }

  const existing = sessionCache.get(key);
  if (!shouldForceReconnect && existing && Date.now() - existing.createdAt < SESSION_TTL_MS) {
    return existing;
  }

  const body: Record<string, string> = { tenant: target.tenant };
  if (target.app) {
    body.app = target.app;
  }

  const connectOnce = async (): Promise<{
    ok: boolean;
    status: number;
    data: unknown;
    sessionId?: string;
  }> => {
    const response = await fetch(joinUrl(target.baseUrl, "/auth/connect"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await parseResponseData(response);
    if (!response.ok) {
      return { ok: false, status: response.status, data };
    }
    const payload = asRecord(data);
    const nested = payload ? asRecord(payload.data) : undefined;
    const sessionId = asTrimmedString(payload?.session_id) ?? asTrimmedString(nested?.session_id);
    return { ok: true, status: response.status, data, sessionId };
  };

  let connectResult = await connectOnce();
  if (!connectResult.ok && isProviderNotFoundError(connectResult.status, connectResult.data)) {
    let provisioned = false;
    try {
      const provision = await tryOrgProvision(target, orgSelection);
      provisioned = provision.provisioned;
      if (provision.credentialId) {
        targetCredentialCache.set(key, provision.credentialId);
      }
    } catch (error) {
      if (isCredentialSelectionRequiredError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Gateway provider is missing for tenant '${target.tenant}'. Org credential provisioning failed: ${message}`,
        { cause: error },
      );
    }
    if (provisioned) {
      connectResult = await connectOnce();
    }
  }
  if (!connectResult.ok) {
    if (isProviderNotFoundError(connectResult.status, connectResult.data)) {
      throw new Error(
        `Provider '${target.gateway}' not found for tenant '${target.tenant}'. Configure gateway provider credentials or set RAPTURE_FRONTEND_URL with either RAPTURE_FRONTEND_SESSION_COOKIE or RAPTURE_FRONTEND_USERNAME + RAPTURE_FRONTEND_PASSWORD to enable org provisioning.`,
      );
    }
    throw new Error(formatHttpError(connectResult.status, connectResult.data));
  }
  const sessionId = connectResult.sessionId;
  if (!sessionId) {
    throw new Error("Gateway connect succeeded but no session_id was returned.");
  }

  const state = {
    sessionId,
    createdAt: Date.now(),
    credentialId: targetCredentialCache.get(key),
  };
  sessionCache.set(key, state);
  return state;
}

async function disconnectGateway(
  target: GatewayTarget,
): Promise<{ disconnected: boolean; sessionId?: string }> {
  const key = sessionKey(target);
  const existing = sessionCache.get(key);
  if (!existing) {
    return { disconnected: false };
  }

  const url = new URL(joinUrl(target.baseUrl, "/auth/disconnect"));
  appendQueryValue(url.searchParams, "session_id", existing.sessionId);

  await fetch(url, { method: "POST" }).catch(() => undefined);
  sessionCache.delete(key);
  targetCredentialCache.delete(key);
  return { disconnected: true, sessionId: existing.sessionId };
}

async function requestGateway(
  target: GatewayTarget,
  method: HttpMethod,
  path: string,
  query?: Record<string, unknown>,
  body?: Record<string, unknown>,
  orgSelection?: OrgCredentialSelection,
): Promise<GatewayResponse> {
  const doRequest = async (state: SessionState): Promise<GatewayResponse> => {
    const url = buildRequestUrl(target, path, state.sessionId, query);
    const response = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await parseResponseData(response);
    return { ok: response.ok, status: response.status, data };
  };

  let session = await connectGateway(target, false, orgSelection);
  let result = await doRequest(session);
  if (result.status === 401 || result.status === 404) {
    session = await connectGateway(target, true, orgSelection);
    result = await doRequest(session);
  }
  return result;
}

function resolveWorkflowAuthConfig(params: Record<string, unknown>): WorkflowAuthConfig {
  const apiUrl = asTrimmedString(params.api_url) ?? envFirst("RAPTURE_API_URL", "rapture_api_url");
  const username =
    asTrimmedString(params.username) ?? envFirst("RAPTURE_USERNAME", "rapture_username");
  const password =
    asTrimmedString(params.password) ?? envFirst("RAPTURE_PASSWORD", "rapture_password");
  if (!apiUrl) {
    throw new Error("Missing rapture API URL. Set api_url or RAPTURE_API_URL.");
  }
  if (!username || !password) {
    throw new Error(
      "Missing rapture credentials. Set username/password or RAPTURE_USERNAME/RAPTURE_PASSWORD.",
    );
  }
  return {
    apiUrl: trimTrailingSlash(apiUrl),
    authPath: asTrimmedString(params.auth_path) ?? "/api-token-auth/",
    submitPath:
      asTrimmedString(params.submit_path) ?? "/automation_validation/api/workflow-form-submission/",
    username,
    password,
  };
}

function authCacheKey(config: WorkflowAuthConfig): string {
  return [config.apiUrl, config.username, config.authPath].join("|");
}

async function getWorkflowAuthToken(
  config: WorkflowAuthConfig,
  skipCache = false,
): Promise<string> {
  const key = authCacheKey(config);
  const cached = authTokenCache.get(key);
  if (!skipCache && cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const response = await fetch(joinUrl(config.apiUrl, config.authPath), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: config.username, password: config.password }),
  });
  const data = await parseResponseData(response);
  if (!response.ok) {
    throw new Error(`Rapture auth failed. ${formatHttpError(response.status, data)}`);
  }

  const payload = asRecord(data);
  const nested = payload ? asRecord(payload.data) : undefined;
  const token =
    asTrimmedString(payload?.token) ??
    asTrimmedString(payload?.access_token) ??
    asTrimmedString(nested?.token) ??
    asTrimmedString(nested?.access_token);
  if (!token) {
    throw new Error("Auth succeeded but no token was returned.");
  }
  authTokenCache.set(key, { token, expiresAt: Date.now() + AUTH_TOKEN_TTL_MS });
  return token;
}

function buildEntityRequest(params: Record<string, unknown>): {
  path: string;
  query: Record<string, unknown>;
} {
  const gateway = asTrimmedString(params.gateway)?.toLowerCase() as GatewayId | undefined;
  const entity = asTrimmedString(params.entity)?.toLowerCase();
  const id = asTrimmedString(params.id);
  if (!gateway || !entity) {
    throw new Error("gateway and entity are required.");
  }

  const pageSize = Number(params.page_size ?? 100);
  const page = Number(params.page ?? 1);
  const perPage = Number(params.per_page ?? pageSize);
  const nextPageToken = asTrimmedString(params.next_page_token);

  if (gateway === "zoom") {
    const table: Record<
      string,
      { listPath: string; detailPath?: string; listQuery?: Record<string, unknown> }
    > = {
      users: { listPath: "/users", detailPath: "/users/:id", listQuery: { page_size: pageSize } },
      phone_users: {
        listPath: "/phone/users",
        detailPath: "/phone/users/:id",
        listQuery: { page_size: pageSize },
      },
      call_queues: {
        listPath: "/phone/call_queues",
        detailPath: "/phone/call_queues/:id",
        listQuery: { page_size: pageSize },
      },
      sites: {
        listPath: "/phone/sites",
        detailPath: "/phone/sites/:id",
        listQuery: { page_size: pageSize },
      },
      phone_numbers: { listPath: "/phone/numbers", listQuery: { page_size: pageSize } },
      shared_line_groups: {
        listPath: "/phone/shared_line_groups",
        detailPath: "/phone/shared_line_groups/:id",
        listQuery: { page_size: pageSize },
      },
      auto_receptionists: {
        listPath: "/phone/auto_receptionists",
        detailPath: "/phone/auto_receptionists/:id",
        listQuery: { page_size: pageSize },
      },
      devices: {
        listPath: "/phone/devices",
        detailPath: "/phone/devices/:id",
        listQuery: { page_size: pageSize },
      },
    };
    const route = table[entity];
    if (!route) {
      throw new Error(`Unsupported zoom entity '${entity}'.`);
    }
    if (id && route.detailPath) {
      return { path: route.detailPath.replace(":id", encodeURIComponent(id)), query: {} };
    }
    const query = { ...route.listQuery };
    if (nextPageToken) {
      query.next_page_token = nextPageToken;
    }
    return { path: route.listPath, query };
  }

  if (gateway === "ringcentral") {
    const table: Record<
      string,
      { listPath: string; detailPath?: string; listQuery?: Record<string, unknown> }
    > = {
      extensions: {
        listPath: "/extension",
        detailPath: "/extension/:id",
        listQuery: { page, perPage },
      },
      users: {
        listPath: "/extension",
        detailPath: "/extension/:id",
        listQuery: { type: "User", perPage },
      },
      call_queues: { listPath: "/call-queues", detailPath: "/call-queues/:id" },
      sites: { listPath: "/sites", detailPath: "/sites/:id" },
      phone_numbers: { listPath: "/phone-number", listQuery: { page, perPage } },
      ivr_menus: { listPath: "/ivr-menus", detailPath: "/ivr-menus/:id" },
    };
    const route = table[entity];
    if (!route) {
      throw new Error(`Unsupported ringcentral entity '${entity}'.`);
    }
    if (id && route.detailPath) {
      return { path: route.detailPath.replace(":id", encodeURIComponent(id)), query: {} };
    }
    return { path: route.listPath, query: { ...route.listQuery } };
  }

  throw new Error("rapture_list_entities currently supports gateway=zoom or gateway=ringcentral.");
}

function resolveJobsStatusUrl(override?: string): string {
  const explicit = asTrimmedString(override);
  if (explicit) {
    return explicit;
  }
  const direct = envFirst("RAPTURE_JOBS_STATUS_URL");
  if (direct) {
    return direct;
  }
  const frontend = envFirst("RAPTURE_FRONTEND_URL", "FRONTEND_URL");
  if (!frontend) {
    throw new Error("Missing jobs status URL. Set jobs_url or RAPTURE_JOBS_STATUS_URL.");
  }
  return joinUrl(frontend, "/api/jobs/status/");
}

function summarizeJobStates(jobs: Record<string, unknown>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const job of jobs) {
    const status = asTrimmedString(job.status) ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function matchesRequestId(job: Record<string, unknown>, requestId: string): boolean {
  return (
    asTrimmedString(job.job_id) === requestId ||
    asTrimmedString(job.workflow_id) === requestId ||
    asTrimmedString(job.request_id) === requestId
  );
}

export function __setRaptureGatewayOrgProvisionerForTests(
  provisioner: OrgProvisioner | undefined,
): void {
  orgProvisionerForTests = provisioner;
}

const plugin = {
  id: "rapture-gateway",
  name: "Rapture Gateway",
  description: "Session-managed tools for Tesseract gateways and Rapture workflow orchestration.",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    api.on("before_agent_start", async (_event, ctx) => {
      if (
        !shouldInjectPlaybook({
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          messageProvider: ctx.messageProvider,
        })
      ) {
        return;
      }
      return {
        prependContext:
          "<rapture-playbook>\n" +
          "Rapture/Tesseract operating rules:\n" +
          "1) Convert plain-English requests into concrete API actions.\n" +
          "2) For reads, use rapture_list_entities first, then rapture_gateway_request for targeted details.\n" +
          "3) For immediate changes, call rapture_gateway_request directly.\n" +
          "4) For workflow/form jobs, call rapture_submit_workflow, capture request_id, then call rapture_get_jobs_status.\n" +
          "5) Always report status with: request_id, current state, failed/blocked steps, and next action.\n" +
          "6) Do not use ZoomWarriors tools for Rapture/Tesseract tasks.\n" +
          "</rapture-playbook>",
      };
    });

    api.registerTool((toolCtx) => ({
      name: "rapture_gateway_connect",
      description:
        "Create or refresh a gateway session. Uses /auth/connect with tenant and app. " +
        "Resolves org credentials automatically by requester email + platform. " +
        "If multiple platform accounts exist, pass credential_id or account_label to select one. " +
        "If provider credentials are missing, it can auto-provision from Rapture group credentials and retry once. " +
        "Use this before a batch of gateway requests if you want a fresh session.",
      parameters: Type.Object({
        gateway: stringEnum(GATEWAY_IDS, { description: `Gateway id: ${GATEWAY_IDS.join(", ")}` }),
        base_url: Type.Optional(
          Type.String({ description: "Optional gateway base URL override." }),
        ),
        tenant: Type.Optional(
          Type.String({ description: "Optional tenant override (default: cloudwarriors)." }),
        ),
        app: Type.Optional(
          Type.String({ description: "Optional app value sent to /auth/connect." }),
        ),
        api_prefix: Type.Optional(
          Type.String({ description: "Optional API path prefix for requests." }),
        ),
        credential_id: Type.Optional(
          Type.String({ description: "Optional org credential UUID for this platform." }),
        ),
        account_label: Type.Optional(
          Type.String({ description: "Optional org account label to select when multiple exist." }),
        ),
        force_reconnect: Type.Optional(
          Type.Boolean({ description: "Force reconnect even if session is still warm." }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const target = resolveGatewayTarget(params);
          assertOrgEmailAuthorized({
            toolName: "rapture_gateway_connect",
            tenant: target.tenant,
            toolContext: toolCtx,
          });
          const orgSelection = resolveOrgCredentialSelection(params, toolCtx);
          const state = await connectGateway(target, Boolean(params.force_reconnect), orgSelection);
          return jsonResult({
            ok: true,
            gateway: target.gateway,
            base_url: target.baseUrl,
            tenant: target.tenant,
            app: target.app ?? null,
            credential_id: state.credentialId ?? null,
            session_id: state.sessionId,
            connected_at: new Date(state.createdAt).toISOString(),
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    }));

    api.registerTool((toolCtx) => ({
      name: "rapture_gateway_disconnect",
      description:
        "Disconnect and clear the cached gateway session for the selected gateway target.",
      parameters: Type.Object({
        gateway: stringEnum(GATEWAY_IDS, { description: `Gateway id: ${GATEWAY_IDS.join(", ")}` }),
        base_url: Type.Optional(
          Type.String({ description: "Optional gateway base URL override." }),
        ),
        tenant: Type.Optional(Type.String({ description: "Optional tenant override." })),
        app: Type.Optional(Type.String({ description: "Optional app override." })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const target = resolveGatewayTarget(params);
          assertOrgEmailAuthorized({
            toolName: "rapture_gateway_disconnect",
            tenant: target.tenant,
            toolContext: toolCtx,
          });
          const result = await disconnectGateway(target);
          return jsonResult({
            ok: true,
            gateway: target.gateway,
            disconnected: result.disconnected,
            session_id: result.sessionId ?? null,
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    }));

    api.registerTool((toolCtx) => ({
      name: "rapture_gateway_request",
      description:
        "Send an authenticated request through a Tesseract gateway with auto reconnect on 401/404. " +
        "Credential resolution uses requester email + platform by default. " +
        "Use this for both read and write operations.",
      parameters: Type.Object({
        gateway: stringEnum(GATEWAY_IDS, { description: `Gateway id: ${GATEWAY_IDS.join(", ")}` }),
        method: stringEnum(HTTP_METHODS, {
          description: `HTTP method: ${HTTP_METHODS.join(", ")}`,
        }),
        path: Type.String({ description: "API path, like /phone/users or /extension/123." }),
        query_json: Type.Optional(
          Type.String({ description: "Optional query params as a JSON object string." }),
        ),
        body_json: Type.Optional(
          Type.String({ description: "Optional request body as a JSON object string." }),
        ),
        base_url: Type.Optional(
          Type.String({ description: "Optional gateway base URL override." }),
        ),
        tenant: Type.Optional(Type.String({ description: "Optional tenant override." })),
        app: Type.Optional(
          Type.String({ description: "Optional app override for /auth/connect." }),
        ),
        api_prefix: Type.Optional(Type.String({ description: "Optional API prefix override." })),
        credential_id: Type.Optional(
          Type.String({ description: "Optional org credential UUID for this platform." }),
        ),
        account_label: Type.Optional(
          Type.String({ description: "Optional org account label to select when multiple exist." }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const target = resolveGatewayTarget(params);
          assertOrgEmailAuthorized({
            toolName: "rapture_gateway_request",
            tenant: target.tenant,
            toolContext: toolCtx,
          });
          const method = asTrimmedString(params.method)?.toUpperCase() as HttpMethod | undefined;
          if (!method || !HTTP_METHODS.includes(method)) {
            throw new Error(`method must be one of: ${HTTP_METHODS.join(", ")}`);
          }
          const path = asTrimmedString(params.path);
          if (!path) {
            throw new Error("path is required.");
          }
          const query = parseJsonObject(params.query_json, "query_json");
          const body = parseJsonObject(params.body_json, "body_json");
          const orgSelection = resolveOrgCredentialSelection(params, toolCtx);
          const response = await requestGateway(target, method, path, query, body, orgSelection);
          return jsonResult({
            ok: response.ok,
            status: response.status,
            gateway: target.gateway,
            path,
            data: response.data,
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    }));

    api.registerTool((toolCtx) => ({
      name: "rapture_list_entities",
      description:
        "List common system entities used in the dashboard/System panel (users, call queues, sites, phone numbers, etc.). " +
        "Supports zoom and ringcentral gateway mappings.",
      parameters: Type.Object({
        gateway: stringEnum(["zoom", "ringcentral"] as const, {
          description: "Gateway id: zoom or ringcentral.",
        }),
        entity: Type.String({
          description:
            "Entity key. Zoom: users, phone_users, call_queues, sites, phone_numbers, shared_line_groups, auto_receptionists, devices. " +
            "RingCentral: extensions, users, call_queues, sites, phone_numbers, ivr_menus.",
        }),
        id: Type.Optional(Type.String({ description: "Optional resource id for detail fetch." })),
        page_size: Type.Optional(Type.Number({ description: "Optional page size (default 100)." })),
        page: Type.Optional(
          Type.Number({ description: "Optional page for RingCentral list endpoints." }),
        ),
        per_page: Type.Optional(
          Type.Number({ description: "Optional perPage for RingCentral list endpoints." }),
        ),
        next_page_token: Type.Optional(
          Type.String({ description: "Optional next_page_token for Zoom pagination." }),
        ),
        base_url: Type.Optional(
          Type.String({ description: "Optional gateway base URL override." }),
        ),
        tenant: Type.Optional(Type.String({ description: "Optional tenant override." })),
        app: Type.Optional(Type.String({ description: "Optional app override." })),
        api_prefix: Type.Optional(Type.String({ description: "Optional API prefix override." })),
        credential_id: Type.Optional(
          Type.String({ description: "Optional org credential UUID for this platform." }),
        ),
        account_label: Type.Optional(
          Type.String({ description: "Optional org account label to select when multiple exist." }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const target = resolveGatewayTarget(params);
          assertOrgEmailAuthorized({
            toolName: "rapture_list_entities",
            tenant: target.tenant,
            toolContext: toolCtx,
          });
          const route = buildEntityRequest(params);
          const orgSelection = resolveOrgCredentialSelection(params, toolCtx);
          const response = await requestGateway(
            target,
            "GET",
            route.path,
            route.query,
            undefined,
            orgSelection,
          );
          const payload = asRecord(response.data);
          const list = Array.isArray(payload?.users)
            ? payload.users
            : Array.isArray(payload?.phone_users)
              ? payload.phone_users
              : Array.isArray(payload?.call_queues)
                ? payload.call_queues
                : Array.isArray(payload?.sites)
                  ? payload.sites
                  : Array.isArray(payload?.phone_numbers)
                    ? payload.phone_numbers
                    : Array.isArray(payload?.records)
                      ? payload.records
                      : null;
          return jsonResult({
            ok: response.ok,
            status: response.status,
            gateway: target.gateway,
            entity: asTrimmedString(params.entity),
            count: list ? list.length : null,
            data: response.data,
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    }));

    api.registerTool((toolCtx) => ({
      name: "rapture_submit_workflow",
      description:
        "Submit a workflow form job to the Rapture backend. Authenticates via /api-token-auth and posts to " +
        "/automation_validation/api/workflow-form-submission/ by default.",
      parameters: Type.Object({
        workflow_name: Type.String({ description: "Workflow name to submit." }),
        platform: Type.String({ description: "Target platform key (zoom, ringcentral, etc.)." }),
        sequence_data_json: Type.String({
          description:
            "Workflow sequence data as JSON. Accepts either an array or an object map (object values become the sequence list).",
        }),
        workflow_context_json: Type.Optional(
          Type.String({ description: "Optional workflow context JSON." }),
        ),
        credentials_json: Type.Optional(
          Type.String({ description: "Optional credentials JSON object." }),
        ),
        callback_url: Type.Optional(
          Type.String({ description: "Optional requested_url callback." }),
        ),
        request_id: Type.Optional(
          Type.String({ description: "Optional request ID. Auto-generated when omitted." }),
        ),
        user_id: Type.Optional(Type.String({ description: "Optional user ID." })),
        group_id: Type.Optional(Type.String({ description: "Optional group ID (default 1)." })),
        sla: Type.Optional(Type.String({ description: "Optional SLA value (default 0)." })),
        tenant: Type.Optional(
          Type.String({ description: "Optional tenant for org-email authorization checks." }),
        ),
        api_url: Type.Optional(
          Type.String({ description: "Optional Rapture API base URL override." }),
        ),
        username: Type.Optional(Type.String({ description: "Optional auth username override." })),
        password: Type.Optional(Type.String({ description: "Optional auth password override." })),
        auth_path: Type.Optional(Type.String({ description: "Optional auth path override." })),
        submit_path: Type.Optional(
          Type.String({ description: "Optional workflow submit path override." }),
        ),
        skip_auth_cache: Type.Optional(
          Type.Boolean({ description: "Skip cached auth token and force fresh auth." }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const tenant = asTrimmedString(params.tenant) ?? resolveDefaultTenant();
          assertOrgEmailAuthorized({
            toolName: "rapture_submit_workflow",
            tenant,
            toolContext: toolCtx,
          });
          const authConfig = resolveWorkflowAuthConfig(params);
          const token = await getWorkflowAuthToken(authConfig, Boolean(params.skip_auth_cache));

          const sequenceValue = parseJsonValue(params.sequence_data_json, "sequence_data_json");
          const sequenceData = Array.isArray(sequenceValue)
            ? sequenceValue
            : Object.values(asRecord(sequenceValue) ?? {});
          if (sequenceData.length === 0) {
            throw new Error("sequence_data_json resolved to an empty sequence list.");
          }

          const workflowContext = parseJsonObject(
            params.workflow_context_json,
            "workflow_context_json",
          );
          const credentials = parseJsonObject(params.credentials_json, "credentials_json") ?? {};
          const requestId = asTrimmedString(params.request_id) ?? `openclaw_${Date.now()}`;

          const payload: Record<string, unknown> = {
            workflow_data: {
              workflow_name: asTrimmedString(params.workflow_name),
              sequence_data: sequenceData,
            },
            platform: asTrimmedString(params.platform),
            request_id: requestId,
            user_id: asTrimmedString(params.user_id) ?? "",
            group_id:
              asTrimmedString(params.group_id) ??
              envFirst("RAPTURE_GROUP_ID", "RAPTURE_DEFAULT_GROUP_ID") ??
              "1",
            sla: asTrimmedString(params.sla) ?? "0",
            credentials,
          };
          if (workflowContext) {
            payload.workflow_context = workflowContext;
          }
          const callbackUrl = asTrimmedString(params.callback_url);
          if (callbackUrl) {
            payload.requested_url = callbackUrl;
          }

          const response = await fetch(joinUrl(authConfig.apiUrl, authConfig.submitPath), {
            method: "POST",
            headers: {
              authorization: `token ${token}`,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify(payload),
          });
          const data = await parseResponseData(response);
          return jsonResult({
            ok: response.ok,
            status: response.status,
            request_id: requestId,
            workflow_name: asTrimmedString(params.workflow_name),
            platform: asTrimmedString(params.platform),
            sequence_count: sequenceData.length,
            data,
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    }));

    api.registerTool((toolCtx) => ({
      name: "rapture_get_jobs_status",
      description:
        "Fetch workflow/job status from the frontend jobs endpoint (default /api/jobs/status/). " +
        "Provide bearer_token or session_cookie if the endpoint requires auth.",
      parameters: Type.Object({
        jobs_url: Type.Optional(Type.String({ description: "Optional jobs status URL override." })),
        request_id: Type.Optional(
          Type.String({ description: "Optional request ID to filter for one job/workflow." }),
        ),
        tenant: Type.Optional(
          Type.String({ description: "Optional tenant for org-email authorization checks." }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Optional max jobs to return (default 25)." }),
        ),
        bearer_token: Type.Optional(
          Type.String({ description: "Optional bearer token override." }),
        ),
        session_cookie: Type.Optional(
          Type.String({
            description:
              "Optional cookie string override. If value has no '=', it is treated as a Django sessionid token.",
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const tenant = asTrimmedString(params.tenant) ?? resolveDefaultTenant();
          assertOrgEmailAuthorized({
            toolName: "rapture_get_jobs_status",
            tenant,
            toolContext: toolCtx,
          });
          const jobsUrl = resolveJobsStatusUrl(asTrimmedString(params.jobs_url));
          const bearer =
            asTrimmedString(params.bearer_token) ?? envFirst("RAPTURE_FRONTEND_BEARER_TOKEN");
          const cookieRaw =
            asTrimmedString(params.session_cookie) ?? envFirst("RAPTURE_FRONTEND_SESSION_COOKIE");

          const headers: Record<string, string> = { accept: "application/json" };
          if (bearer) {
            headers.authorization = `Bearer ${bearer}`;
          }
          if (cookieRaw) {
            headers.cookie = cookieRaw.includes("=") ? cookieRaw : `sessionid=${cookieRaw}`;
          }

          const response = await fetch(jobsUrl, { method: "GET", headers });
          const data = await parseResponseData(response);
          if (!response.ok) {
            throw new Error(
              `Jobs status request failed. ${formatHttpError(response.status, data)}`,
            );
          }

          const payload = asRecord(data) ?? {};
          const userJobsRaw = Array.isArray(payload.user_jobs) ? payload.user_jobs : [];
          const groupJobsRaw = Array.isArray(payload.group_jobs) ? payload.group_jobs : [];
          const userJobs = userJobsRaw
            .filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)))
            .map((entry) => asRecord(entry) as Record<string, unknown>);
          const groupJobs = groupJobsRaw
            .filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)))
            .map((entry) => asRecord(entry) as Record<string, unknown>);

          const requestId = asTrimmedString(params.request_id);
          const filteredUserJobs = requestId
            ? userJobs.filter((job) => matchesRequestId(job, requestId))
            : userJobs;
          const filteredGroupJobs = requestId
            ? groupJobs.filter((job) => matchesRequestId(job, requestId))
            : groupJobs;

          const limit = Number.isFinite(Number(params.limit))
            ? Math.max(1, Number(params.limit))
            : 25;
          const limitedUserJobs = filteredUserJobs.slice(0, limit);
          const limitedGroupJobs = filteredGroupJobs.slice(0, limit);
          const combinedFilteredJobs = [...filteredUserJobs, ...filteredGroupJobs];

          return jsonResult({
            ok: true,
            status: response.status,
            request_id: requestId ?? null,
            counts: {
              user_jobs_total: userJobs.length,
              user_jobs_filtered: filteredUserJobs.length,
              group_jobs_total: groupJobs.length,
              group_jobs_filtered: filteredGroupJobs.length,
              by_status: summarizeJobStates(combinedFilteredJobs),
            },
            user_jobs: limitedUserJobs,
            group_jobs: limitedGroupJobs,
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    }));
  },
};

export default plugin;
