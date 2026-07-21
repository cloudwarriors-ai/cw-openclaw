// Support-ticket tool for the scopely-support audience (Slice E §5 — the
// no-dead-end guarantee: every conversation ends in answer / ticket / named
// human, never silence).
//
// scopely_create_support_ticket is deliberately the ONE write an end user may
// trigger UNGATED: it mutates nothing in the product — it creates work for
// us. Direct create, fully audited (wrapToolWithAudit records actor, params,
// and the resulting issue URL). Backend is GitHub issues via the same
// argv-only `gh` execution discipline as gh-tools.ts (no shell — every
// LLM-controlled value is an inert argv element). The repo comes from the
// SAME scopelyRepos allowlist; end users cannot steer the destination.
//
// After the issue lands, a handoff line is posted best-effort to the internal
// triage channel (SCOPELYBOT_TRIAGE_CHANNEL) so a human starts from the link,
// not archaeology. Triage-post failure never fails the ticket.

import { execFileSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { sendScopelyText } from "./comfort.js";
import { errorResult, jsonResult } from "./scopely-api.js";

type PluginConfig = { scopelyRepos?: string[] };

const SEVERITIES = new Set(["low", "normal", "high"]);

export function registerSupportTicketTools(
  api: OpenClawPluginApi,
  logger: AuditLogger,
  config: PluginConfig,
): void {
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_create_support_ticket",
        description:
          "Create a support ticket for the current requester. Use when a question cannot be " +
          "answered or the user reports a problem needing human follow-up. Ungated by design: " +
          "tickets create work for the support team and change nothing in the product. Include " +
          "what the user asked, what was tried, and what is still needed.",
        parameters: Type.Object({
          title: Type.String({ description: "Short ticket title (user-visible)" }),
          description: Type.String({
            description:
              "What the user needs: their question, what the bot tried/answered, what remains",
          }),
          requester: Type.String({
            description: "Who asked — the requester's email or handle from the conversation",
          }),
          severity: Type.Optional(
            Type.String({ description: "low | normal | high (default normal)" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            // Tickets always land in the primary allowlisted repo — the
            // requester never chooses the destination.
            const repo = (config.scopelyRepos ?? ["cloudwarriors-ai/scopely"])[0];
            const title = typeof params.title === "string" ? params.title.trim() : "";
            const description =
              typeof params.description === "string" ? params.description.trim() : "";
            const requester = typeof params.requester === "string" ? params.requester.trim() : "";
            if (!title || !description || !requester) {
              return jsonResult({
                ok: false,
                error: "title, description, and requester are all required",
              });
            }
            const severityRaw =
              typeof params.severity === "string" ? params.severity.toLowerCase() : "normal";
            const severity = SEVERITIES.has(severityRaw) ? severityRaw : "normal";

            const body = [
              `Requester: ${requester}`,
              `Severity: ${severity}`,
              `Source: scopely-support bot`,
              "",
              description,
            ].join("\n");

            const result = execFileSync(
              "gh",
              [
                "issue",
                "create",
                "--repo",
                repo,
                "--title",
                `[support] ${title}`,
                "--label",
                "support-ticket",
                "--body-file",
                "-",
              ],
              {
                encoding: "utf-8",
                input: body,
                timeout: 30000,
                env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
              },
            );
            const url = result.trim();

            // Best-effort triage handoff — the ticket already exists; a Zoom
            // failure must not fail the tool call.
            const triage = process.env.SCOPELYBOT_TRIAGE_CHANNEL ?? "";
            if (triage) {
              await sendScopelyText(
                triage,
                `New support ticket (${severity}) from ${requester}: ${title} — ${url}`,
              ).catch(() => {});
            }

            return jsonResult({ ok: true, status: 201, data: { url, severity } });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );
}
