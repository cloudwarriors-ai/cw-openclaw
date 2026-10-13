// Test-only helpers for the audit-v2 chain (never imported by production code).
import * as fs from "node:fs";
import * as path from "node:path";
import { type CallContext, requesterFromToolCtx } from "./call-context.js";

// Parsed JSON: the object fields are typed present for test convenience (a
// row without one reads as undefined, which an assertion then catches).
export type AuditRow = Record<string, unknown> & {
  event_type: string;
  seq: number;
  audit_id: string;
  detail: Record<string, unknown>;
  http: Record<string, unknown>;
  result: Record<string, unknown>;
  requester: Record<string, unknown>;
};

export function auditFile(workspace: string): string {
  return path.join(workspace, "scopelybot", "audit-v2.jsonl");
}

/** Parsed audit-v2 rows (epoch_marker skipped unless asked); [] when the file is absent. */
export function readAuditRows(workspace: string, opts: { withEpoch?: boolean } = {}): AuditRow[] {
  const file = auditFile(workspace);
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditRow)
    .filter((row) => opts.withEpoch || row.event_type !== "epoch_marker");
}

// Golden vector: one fixed record -> one canonical string and hash, asserted
// against the TS writer (audit-chain.test.ts) and the .mjs verifier.
export const GOLDEN = {
  record: {
    seq: 1,
    schema_version: 2,
    ts: "2026-10-12T00:00:00.000Z",
    prev_hash: "0".repeat(64),
    audit_id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
    event_type: "epoch_marker",
    phase: "single",
    detail: { reason: "cutover_v1", b: true, n: null },
    v1: { exists: false },
    z: [1, "x", { b: 2, a: "\u00e9\u2028" }],
  },
  canonical:
    '{"audit_id":"01JABCDEFGHJKMNPQRSTVWXYZ0","detail":{"b":true,"n":null,"reason":"cutover_v1"},"event_type":"epoch_marker","phase":"single","prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","schema_version":2,"seq":1,"ts":"2026-10-12T00:00:00.000Z","v1":{"exists":false},"z":[1,"x",{"a":"\u00e9\u2028","b":2}]}',
  hash: "d4eba6379cb4a2cc558727d44a9538a57264b3d8bdc9bc2f7dc9813a992e6256",
};

/** The call context the registry wrapper sets for `tool` in a human-triggered coordinator run. */
export function testCall(tool: string, sender = "op_tester"): CallContext {
  const ctx = { sessionKey: "agent:scopelybot:zoom:test", requesterSenderId: sender };
  return {
    tool,
    trigger: "tool",
    requester: requesterFromToolCtx(ctx),
    openclaw: { agent_id: "scopelybot", session_key: ctx.sessionKey, tool_call_id: "call-1" },
    action: { tool, family: null, op_class: "unknown", registry_status: "unregistered" },
  };
}

/**
 * The audit_id the guard appended to `url`, which must be exactly `expected`
 * plus one ?bot_audit_id=<ULID> (INV-5); throws otherwise.
 */
export function correlatedId(url: unknown, expected: string): string {
  const prefix = `${expected}${expected.includes("?") ? "&" : "?"}bot_audit_id=`;
  const id = typeof url === "string" && url.startsWith(prefix) ? url.slice(prefix.length) : "";
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
    throw new Error(`not a correlated request URL: ${String(url)} (expected ${prefix}<ULID>)`);
  }
  return id;
}

/** The two headers the guard adds to every request (INV-5). */
export function correlationHeaders(id: string, env: "prod" | "dev"): Record<string, string> {
  return { "x-correlation-id": id, "x-vipbot-client": `scopelybot/0.1.0 (${env})` };
}
