// Audit row producers (PK-7b). Every row goes to the audit-v2 chain
// (audit-chain.ts); nothing writes the v1 audit.jsonl any more. Rows carry the
// requester and tool context of the current call (call-context.ts), the live
// policy snapshot (set by backend-profile.ts on each read) and redacted,
// bounded details. createAuditLogger stays the AuditLogger facade the tool
// modules already take, so their call sites are unchanged.

import { createHash } from "node:crypto";
import {
  type AuditEventType,
  type AuditRecord,
  boundedText,
  canonicalJson,
  getAuditWriter,
} from "./audit-chain.js";
import { currentCall, type Principal, SYSTEM_PRINCIPAL } from "./call-context.js";
import { redactValue } from "./redaction.js";

/** Pinned to package.json by a test. */
export const PLUGIN_VERSION = "0.1.0";
const DETAIL_MAX = 256;

export type AuditPolicy = {
  env: "prod" | "dev" | "unknown";
  state: "valid" | "fail_closed_default";
  mode: "off" | "read-only" | "read-write";
  profile_sha256: string | null;
};
let policy: AuditPolicy = {
  env: "unknown",
  state: "fail_closed_default",
  mode: "read-only",
  profile_sha256: null,
};

/** backend-profile.ts reports the live profile on every read. */
export function noteAuditPolicy(next: AuditPolicy): void {
  policy = next;
}

export type AuditFields = {
  phase?: "intent" | "outcome" | "single";
  trigger?: "tool" | "confirm" | "hook" | "timer" | "startup";
  requester?: Principal;
  audit_id?: string;
  detail?: Record<string, unknown>;
} & Record<string, unknown>;

// Detail values are scalars of at most 256 characters, redacted; arrays are
// joined and fractional numbers kept as text (the chain admits integers only).
function cleanDetail(detail: Record<string, unknown> | undefined) {
  if (!detail) {
    return undefined;
  }
  const redacted = redactValue(detail, { maxStringLength: DETAIL_MAX }) as Record<string, unknown>;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(redacted)) {
    if (value === undefined) {
      continue;
    }
    out[key] =
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isSafeInteger(value))
        ? value
        : (Array.isArray(value)
            ? value.join(",")
            : typeof value === "string"
              ? value
              : (JSON.stringify(value) ?? "")
          ).slice(0, DETAIL_MAX);
  }
  return out;
}

/** Append one row; throws AuditWriteError (INV-15 callers fail closed on it). */
export function auditEvent(
  workspaceDir: string,
  event: AuditEventType,
  fields: AuditFields = {},
): AuditRecord {
  const call = currentCall();
  return getAuditWriter(workspaceDir).append({
    phase: "single",
    trigger: call?.trigger ?? "hook",
    requester: call?.requester ?? SYSTEM_PRINCIPAL,
    openclaw: call?.openclaw,
    action: call?.action,
    ...fields,
    event_type: event,
    env: policy.env,
    plugin_version: PLUGIN_VERSION,
    bot_principal: { auth_mode: "anonymous", principal_id: null },
    policy: { state: policy.state, mode: policy.mode, profile_sha256: policy.profile_sha256 },
    detail: cleanDetail(fields.detail),
  });
}

/** Observational rows: a failed append is reported by the writer (stderr, degraded), never thrown. */
export function auditEventBestEffort(
  workspaceDir: string,
  event: AuditEventType,
  fields: AuditFields = {},
): void {
  try {
    auditEvent(workspaceDir, event, fields);
  } catch {
    // the writer already logged audit_degraded and counts the gap
  }
}

/** sha256 of the canonical REDACTED params: kept when an oversized row drops them, and never a hash of a secret. */
export function paramsSha256(params: unknown): string | null {
  try {
    return createHash("sha256")
      .update(canonicalJson(params ?? null, true))
      .digest("hex");
  } catch {
    return null;
  }
}

export interface AuditEntry {
  ts: string;
  tool: string;
  actor: string;
  trigger?: string;
  params?: Record<string, unknown>;
  resultSummary?: string;
  durationMs?: number;
  error?: string;
  /** Set by wrapToolWithAudit; other producers (supervisor, voice judge, inbound guard) leave it unset. */
  event?: "tool_call";
  paramsSha256?: string | null;
}

// Legacy entry -> v2 row (the PK-7a producers keep their AuditLogger call
// sites). The inbound guard's and the CONFIRM execution's actor is the trusted
// before_dispatch senderId (for a CONFIRM that is the approver; who asked for
// the change is PK-7b-2); supervisor and voice-judge rows have no requester.
function legacyRow(entry: AuditEntry): [AuditEventType, AuditFields] {
  const summary = entry.resultSummary ?? "";
  const failed = Boolean(entry.error) || summary.startsWith("error");
  const outcome = { result_summary: summary, duration_ms: entry.durationMs, error: entry.error };
  if (entry.event === "tool_call") {
    const action = {
      ...currentCall()?.action,
      tool: entry.tool,
      params_redacted: entry.params ?? null,
      params_sha256: entry.paramsSha256 ?? null,
    };
    const status = failed ? "error" : summary.startsWith("staged") ? "staged" : "ok";
    return ["tool_call", { action, result: { status }, detail: outcome }];
  }
  const human = senderOf(entry.actor);
  const detail = { ...outcome, ...entry.params };
  if (entry.tool === "scopely_inbound_guard") {
    const event = summary.startsWith("blocked") ? "inbound_block" : "inbound_flag";
    return [event, { trigger: "hook", requester: human, detail }];
  }
  if (entry.tool === "scopely_confirm_execute") {
    const result = { status: failed ? "error" : "ok" };
    const missing = { ...SYSTEM_PRINCIPAL, reason: "missing" as const };
    const fields = { trigger: "confirm" as const, requester: missing, approver: human };
    return [failed ? "confirm_error" : "confirm_ok", { ...fields, result, detail }];
  }
  return [
    "supervisor",
    { trigger: "hook", requester: SYSTEM_PRINCIPAL, detail: { ...detail, tool: entry.tool } },
  ];
}

function senderOf(actor: string): Principal {
  return actor
    ? {
        resolved: true,
        zoom_operator_id: boundedText(actor),
        source: "before_dispatch",
        reason: null,
      }
    : { ...SYSTEM_PRINCIPAL, reason: "missing" };
}

export function createAuditLogger(workspaceDir: string) {
  return function logAudit(entry: AuditEntry): void {
    const [event, fields] = legacyRow(entry);
    auditEventBestEffort(workspaceDir, event, fields);
  };
}

export type AuditLogger = ReturnType<typeof createAuditLogger>;

export function wrapToolWithAudit(
  toolDef: {
    name: string;
    description: string;
    parameters: unknown;
    execute: (
      id: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: { type: "text"; text: string }[] }>;
  },
  logger: AuditLogger,
) {
  const origExecute = toolDef.execute;
  toolDef.execute = async (id: string, params: Record<string, unknown>) => {
    const start = Date.now();
    // Redact, then hash the redacted form (a hash of a low-entropy secret
    // could be brute-forced); the requester is the call context's.
    const redacted = sanitizeParams(params);
    const base = {
      tool: toolDef.name,
      actor: currentCall()?.requester.zoom_operator_id ?? "unresolved",
      params: redacted,
      event: "tool_call" as const,
      paramsSha256: paramsSha256(redacted),
    };
    try {
      const result = await origExecute(id, params);
      const durationMs = Date.now() - start;
      let resultSummary = "";
      try {
        const parsed = JSON.parse(result.content[0]?.text ?? "{}");
        if (parsed.ok === false) {
          resultSummary = `error: ${parsed.error ?? "unknown"}`;
        } else if (parsed.staged === true && parsed.awaiting_confirmation === true) {
          resultSummary = "staged: awaiting confirmation";
        } else if (Array.isArray(parsed.data)) {
          resultSummary = `${parsed.data.length} items`;
        } else {
          resultSummary = "ok";
        }
      } catch {
        resultSummary = "ok";
      }
      logger({ ...base, ts: new Date().toISOString(), resultSummary, durationMs });
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      logger({
        ...base,
        ts: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      });
      throw err;
    }
  };
  return toolDef;
}

function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  return chainSafe(redactValue(params, { maxStringLength: 200 })) as Record<string, unknown>;
}

// The chain admits safe integers only: model-supplied fractions and huge
// numbers are kept as text rather than failing the row.
function chainSafe(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map(chainSafe);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, chainSafe(v)]));
  }
  return typeof value === "bigint" ? String(value) : value;
}
