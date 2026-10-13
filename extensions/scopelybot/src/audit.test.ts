// Audit row producers (audit.ts, PK-7b-1): tool_call rows from wrapToolWithAudit,
// the AuditLogger facade for the PK-7a producers, redaction of secret-shaped
// values, the params hash, and the frozen v1 file.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyChain } from "../scripts/verify-audit-chain.mjs";
import { setAuditDepsForTest } from "./audit-chain.js";
import { createAuditLogger, PLUGIN_VERSION, wrapToolWithAudit } from "./audit.js";
import { auditFile, readAuditRows, testCall } from "./audit.test-helpers.js";
import { runInCall } from "./call-context.js";

let workspace: string;
const text = (result: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
});

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "scopelybot-audit-"));
  setAuditDepsForTest(null);
});
afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function tool(execute: () => Promise<unknown>) {
  return wrapToolWithAudit(
    {
      name: "scopely_test_tool",
      description: "test",
      parameters: {},
      execute: execute as never,
    },
    createAuditLogger(workspace),
  );
}

describe("write audit summaries", () => {
  it("does not describe a staged write as executed", async () => {
    const logger = vi.fn();
    const wrapped = wrapToolWithAudit(
      {
        name: "scopely_test_write",
        description: "test",
        parameters: {},
        async execute() {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ staged: true, awaiting_confirmation: true }),
              },
            ],
          };
        },
      },
      logger,
    );

    await wrapped.execute("call", {});

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({ resultSummary: "staged: awaiting confirmation" }),
    );
  });
});

describe("tool_call rows", () => {
  it("carry the call's requester and action, the redacted params and their hash", async () => {
    const wrapped = tool(async () => text({ ok: true }));
    await runInCall(testCall("scopely_test_tool", "op_123"), () =>
      wrapped.execute("call-1", { b: 1, a: "x" }),
    );
    expect(readAuditRows(workspace)).toEqual([
      expect.objectContaining({
        event_type: "tool_call",
        requester: { resolved: true, zoom_operator_id: "op_123", source: "ctx", reason: null },
        openclaw: expect.objectContaining({ tool_call_id: "call-1" }),
        action: expect.objectContaining({
          tool: "scopely_test_tool",
          params_redacted: { b: 1, a: "x" },
          // sha256 of the canonical form {"a":"x","b":1}, computed independently here
          params_sha256: createHash("sha256").update('{"a":"x","b":1}').digest("hex"),
        }),
        result: { status: "ok" },
      }),
    ]);
  });

  it("hashes the REDACTED params, so a low-entropy secret cannot be recovered from the hash", async () => {
    await tool(async () => text({ ok: true })).execute("call-1", {
      note: "mail a@b.test",
      password: "hunter2",
    });
    const action = readAuditRows(workspace)[0].action as Record<string, unknown>;
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(action).toMatchObject({
      params_redacted: { note: "mail [REDACTED_EMAIL]", password: "[REDACTED]" },
      params_sha256: sha('{"note":"mail [REDACTED_EMAIL]","password":"[REDACTED]"}'),
    });
    expect(action.params_sha256).not.toBe(sha('{"note":"mail a@b.test","password":"hunter2"}'));
  });

  it("outside a tool call the requester is a system principal, never the bot", async () => {
    await tool(async () => text({ ok: true })).execute("call-1", { actor: "op_evil" });
    const row = readAuditRows(workspace)[0];
    expect(row.requester).toEqual({
      resolved: false,
      zoom_operator_id: null,
      source: "none",
      reason: "system",
    });
    expect(JSON.stringify(row.requester)).not.toContain("scopelybot");
  });

  it("never stores secret-shaped values (params, nested params, error text)", async () => {
    const secrets = [
      "hunter2-FAKE-PW",
      "sk-FAKE-1234567890",
      "FAKEbearerTOKENabcdef",
      "jane.doe@example.test",
      "415-555-0134",
      "FAKE-NESTED-TOKEN",
      "FAKEerrPW99",
    ];
    const ok = tool(async () => text({ ok: true }));
    await ok.execute("call-1", {
      password: secrets[0],
      api_key: secrets[1],
      note: `Bearer ${secrets[2]} mail ${secrets[3]} call ${secrets[4]}`,
      nested: { token: secrets[5] },
    });
    const failing = tool(async () => {
      throw new Error(`login failed password=${secrets[6]}`);
    });
    await expect(failing.execute("call-2", {})).rejects.toThrow();
    const file = fs.readFileSync(auditFile(workspace), "utf8");
    for (const secret of secrets) {
      expect(file, secret).not.toContain(secret);
    }
    expect(readAuditRows(workspace).at(-1)).toMatchObject({ result: { status: "error" } });
  });

  it("oversized, circular or fractional params still yield a valid row", async () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const huge = Object.fromEntries(
      Array.from({ length: 80 }, (_v, i) => [`k${i}`, "x".repeat(150)]),
    );
    for (const params of [circular, huge, { ratio: 0.25, big: 2 ** 60 }]) {
      await tool(async () => text({ ok: true })).execute("call", params);
    }
    const rows = readAuditRows(workspace);
    expect(rows).toHaveLength(3);
    expect(rows[1].action).toMatchObject({ params_redacted: null, params_dropped: true });
    expect(rows[2].action).toMatchObject({ params_redacted: { ratio: "0.25" } });
    expect(verifyChain(fs.readFileSync(auditFile(workspace), "utf8")).ok).toBe(true);
  });
});

describe("the AuditLogger facade for the PK-7a producers", () => {
  it("maps the inbound guard, CONFIRM execution and supervisor rows onto the v2 vocabulary", () => {
    const log = createAuditLogger(workspace);
    const base = { ts: new Date().toISOString() };
    log({ ...base, tool: "scopely_inbound_guard", actor: "op_a", resultSummary: "blocked: x" });
    log({ ...base, tool: "scopely_inbound_guard", actor: "op_a", resultSummary: "flagged: y" });
    log({ ...base, tool: "scopely_confirm_execute", actor: "op_b", resultSummary: "ok" });
    log({ ...base, tool: "scopely_confirm_execute", actor: "op_b", resultSummary: "error: 500" });
    log({ ...base, tool: "scopely_supervisor", actor: "scopelybot", resultSummary: "revise" });
    const rows = readAuditRows(workspace);
    expect(rows.map((r) => r.event_type)).toEqual([
      "inbound_block",
      "inbound_flag",
      "confirm_ok",
      "confirm_error",
      "supervisor",
    ]);
    expect(rows[0].requester).toMatchObject({
      zoom_operator_id: "op_a",
      source: "before_dispatch",
    });
    expect(rows[2]).toMatchObject({
      trigger: "confirm",
      approver: { zoom_operator_id: "op_b", source: "before_dispatch" },
      requester: { resolved: false, reason: "missing" },
    });
    expect(rows[4].requester).toMatchObject({ resolved: false, reason: "system" });
    log({
      ...base,
      tool: "scopely_inbound_guard",
      actor: "u".repeat(20_000),
      resultSummary: "flagged: z",
    });
    const id = String(readAuditRows(workspace).at(-1)?.requester.zoom_operator_id);
    expect(id).toBe(
      `${"u".repeat(240)}~${createHash("sha256").update("u".repeat(20_000)).digest("hex").slice(0, 12)}`,
    );
    expect(JSON.stringify(rows.map((r) => r.requester))).not.toContain("scopelybot");
  });
});

describe("pins", () => {
  it("PLUGIN_VERSION matches package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });

  it('only the epoch-marker reader has an "audit.jsonl" string literal in production code', () => {
    const root = path.dirname(new URL("../index.ts", import.meta.url).pathname);
    const prod = ["index.ts", ...fs.readdirSync(path.join(root, "src")).map((f) => `src/${f}`)]
      .filter((f) => f.endsWith(".ts") && !f.includes(".test"))
      .filter((f) => {
        const sf = ts.createSourceFile(
          f,
          fs.readFileSync(path.join(root, f), "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        let found = false;
        const visit = (n: ts.Node) => {
          if (
            (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
            /(^|\/)audit\.jsonl$/.test(n.text)
          ) {
            found = true;
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
        return found;
      });
    expect(prod).toEqual(["src/audit-chain.ts"]);
  });
});
