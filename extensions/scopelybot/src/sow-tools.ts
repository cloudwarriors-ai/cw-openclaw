// SOW pipeline verbs for Scopely sessions (plan Slice 3): JSON preview (read),
// document generation, and the EXTERNAL send plane — DocuSign envelopes and
// SOW emails that reach the CUSTOMER. Every mutation only STAGES via
// stageWrite() (confirm-gate invariant), and every external-send summary names
// the recipient explicitly so the approver sees exactly who receives what
// (emails are masked by the boundary redaction in stageWrite, not here).
//
// Backend contracts verified against scopely service/apps/scoping/views/
// {sow,docusign_actions}.py on 2026-07-21: preview is GET (JSON); generate is
// POST returning FILE BYTES (we discard the body — no binaries over chat, and
// the write effect is the status transition + snapshot, not the download);
// execute/send/change-signer are POSTs whose recipient fields are REQUIRED
// here even where the backend would default them — an external send must
// never have an implicit recipient.

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { stageWrite } from "./gated.js";
import { scopelyFetch, jsonResult, errorResult } from "./scopely-api.js";

function sessionId(params: Record<string, unknown>): number {
  const parsed = Number(params.session_id);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("session_id must be a positive integer");
  }
  return parsed;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = typeof params[key] === "string" ? (params[key] as string).trim() : "";
  if (!value) throw new Error(`${key} is required`);
  return value;
}

const SESSION_ID_PARAM = Type.Number({ description: "Numeric session id" });

const STAGED =
  "You ARE authorized — CALL this tool; do NOT refuse or defer to the UI. It is safe: it only " +
  "STAGES the action; nothing happens until the requester replies `CONFIRM <code>`.";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function registerSowTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // scopely_sow_preview — read-only JSON view of the SOW content.
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_sow_preview",
        description:
          "Preview a Scopely session's SOW content as structured JSON (company info, scope, line " +
          "items, totals) WITHOUT generating a document or changing state. Read-only — runs " +
          "immediately. Requires the session's pricing to be calculated.",
        parameters: Type.Object({ session_id: SESSION_ID_PARAM }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const id = sessionId(params);
            const result = await scopelyFetch(`/api/sessions/${id}/sow-preview/`);
            if (!result.ok) {
              return jsonResult({ ok: false, status: result.status, details: result.data });
            }
            const data = asRecord(result.data);
            const lineItems = Array.isArray(data.line_items) ? data.line_items : [];
            // Bound the payload: line items can be long; totals carry the story.
            return jsonResult({
              ok: true,
              status: result.status,
              data: {
                company_info: data.company_info,
                scope: data.scope,
                totals: data.totals,
                category_totals: data.category_totals,
                template_meta: data.template_meta,
                line_item_count: lineItems.length,
                line_items: lineItems.slice(0, 50),
              },
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // scopely_generate_sow — generates the document server-side and transitions
  // the session to sow_generated (that transition is why this is a write).
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_generate_sow",
        description:
          "Generate the Statement of Work document for a priced Scopely session (transitions the " +
          "session to sow_generated and snapshots pricing). " +
          STAGED +
          " The document itself stays in the app — no file is posted to chat.",
        parameters: Type.Object({ session_id: SESSION_ID_PARAM }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const id = sessionId(params);
            return await stageWrite(`generate SOW for session ${id}`, async () => {
              const result = await scopelyFetch(`/api/sessions/${id}/generate-sow/`, {
                method: "POST",
                body: "{}",
              });
              // Success returns the document BYTES — discard them (the write
              // effect we wanted is the transition + snapshot; a docx blob
              // must never ride back through chat or the audit log).
              return {
                ok: result.ok,
                status: result.status,
                data: result.ok ? { generated: true } : result.data,
              };
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // scopely_execute_sow — EXTERNAL: creates and sends a DocuSign envelope to
  // the named customer recipient.
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_execute_sow",
        description:
          "Send a Scopely session's generated SOW for signature via DocuSign — the CUSTOMER " +
          "recipient receives the envelope email. " +
          STAGED +
          " Recipient name and email are required; the confirm prompt names them explicitly.",
        parameters: Type.Object({
          session_id: SESSION_ID_PARAM,
          first_name: Type.String({ description: "Signer first name" }),
          last_name: Type.String({ description: "Signer last name" }),
          email: Type.String({ description: "Signer email — the envelope goes HERE" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const id = sessionId(params);
            const firstName = requiredString(params, "first_name");
            const lastName = requiredString(params, "last_name");
            const email = requiredString(params, "email");
            const summary = `send SOW for session ${id} for SIGNATURE via DocuSign to ${firstName} ${lastName} <${email}>`;
            return await stageWrite(summary, () =>
              scopelyFetch(`/api/sessions/${id}/execute-sow/`, {
                method: "POST",
                body: JSON.stringify({ first_name: firstName, last_name: lastName, email }),
              }),
            );
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // scopely_send_sow — EXTERNAL: emails the generated SOW document.
  // recipient_email is REQUIRED here even though the backend can default it —
  // an external email must never have an implicit recipient.
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_send_sow",
        description:
          "Email a Scopely session's generated SOW document to a recipient — an EXTERNAL email " +
          "leaves the platform. " +
          STAGED +
          " recipient_email is required; the confirm prompt names it explicitly.",
        parameters: Type.Object({
          session_id: SESSION_ID_PARAM,
          recipient_email: Type.String({ description: "Where the SOW email goes — required" }),
          subject: Type.Optional(Type.String({ description: "Email subject override" })),
          body: Type.Optional(Type.String({ description: "Email body override" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const id = sessionId(params);
            const recipient = requiredString(params, "recipient_email");
            const payload: Record<string, unknown> = { recipient_email: recipient };
            if (typeof params.subject === "string" && params.subject)
              payload.subject = params.subject;
            if (typeof params.body === "string" && params.body) payload.body = params.body;
            const summary = `EMAIL the SOW for session ${id} to ${recipient}`;
            return await stageWrite(summary, () =>
              scopelyFetch(`/api/sessions/${id}/send-sow/`, {
                method: "POST",
                body: JSON.stringify(payload),
              }),
            );
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // scopely_change_sow_signer — EXTERNAL: voids the active envelope and
  // re-sends to a new recipient. Reason is required by the backend (recorded
  // on the voided envelope row).
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_change_sow_signer",
        description:
          "Change the DocuSign signer on a Scopely session: voids the active envelope (reason is " +
          "recorded) and sends a fresh SOW to the NEW customer recipient. " +
          STAGED +
          " New signer name, email, and a reason are all required.",
        parameters: Type.Object({
          session_id: SESSION_ID_PARAM,
          first_name: Type.String({ description: "New signer first name" }),
          last_name: Type.String({ description: "New signer last name" }),
          email: Type.String({ description: "New signer email — the fresh envelope goes HERE" }),
          reason: Type.String({
            description: "Why the signer changed — recorded in the audit trail",
          }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const id = sessionId(params);
            const firstName = requiredString(params, "first_name");
            const lastName = requiredString(params, "last_name");
            const email = requiredString(params, "email");
            const reason = requiredString(params, "reason");
            const summary =
              `CHANGE SOW SIGNER on session ${id} to ${firstName} ${lastName} <${email}> ` +
              `(voids current envelope; reason: ${reason})`;
            return await stageWrite(summary, () =>
              scopelyFetch(`/api/sessions/${id}/docusign/change-signer/`, {
                method: "POST",
                body: JSON.stringify({
                  first_name: firstName,
                  last_name: lastName,
                  email,
                  reason,
                }),
              }),
            );
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );
}
