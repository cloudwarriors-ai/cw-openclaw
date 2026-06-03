import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { describeChanges, pickBody, stageWrite } from "./gated.js";
import { buildQuery, errorResult, jsonResult, scopelyFetch } from "./scopely-api.js";

// Organization management tools (Scopely VIP admin). Reads run immediately;
// every write is confirm-gated via stageWrite(). Org writes require platform_admin.
export function registerOrgTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // ── Reads ──────────────────────────────────────────────────────────────
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_orgs",
        description:
          "List Scopely VIP organizations (name, slug, active status, member count, owner). " +
          "Read-only — runs immediately. Use before creating or editing an org.",
        parameters: Type.Object({
          include_inactive: Type.Optional(
            Type.Boolean({ description: "Include soft-deleted/inactive orgs (default false)" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const qs = params.include_inactive
              ? buildQuery({ include_inactive: "true" }, ["include_inactive"])
              : "";
            const res = await scopelyFetch(`/api/auth/orgs/${qs}`);
            return jsonResult({ ok: res.ok, status: res.status, data: res.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_get_org",
        description: "Get a single Scopely VIP organization by id. Read-only — runs immediately.",
        parameters: Type.Object({
          org_id: Type.Number({ description: "Numeric organization id" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const res = await scopelyFetch(`/api/auth/orgs/${params.org_id as number}/`);
            return jsonResult({ ok: res.ok, status: res.status, data: res.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_org_domains",
        description:
          "List the email domains registered for auto-join on a Scopely VIP organization. " +
          "Read-only — runs immediately.",
        parameters: Type.Object({
          org_id: Type.Number({ description: "Numeric organization id" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const res = await scopelyFetch(`/api/auth/orgs/${params.org_id as number}/domains/`);
            return jsonResult({ ok: res.ok, status: res.status, data: res.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // ── Confirm-gated writes ────────────────────────────────────────────────
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_create_org",
        description:
          "Create a new Scopely VIP organization (platform admin action). You ARE authorized — CALL " +
          "this tool, do NOT defer to the admin UI. It only STAGES the create and returns a confirmation " +
          "code; nothing happens until the requester replies `CONFIRM <code>`.",
        parameters: Type.Object({
          name: Type.String({ description: "Organization display name" }),
          slug: Type.String({ description: "URL slug (unique)" }),
          experience_profile: Type.Optional(
            Type.Number({ description: "Experience profile id to assign (must be active)" }),
          ),
          owner: Type.Optional(Type.Number({ description: "User id to set as org owner" })),
          is_active: Type.Optional(Type.Boolean({ description: "Active flag (default true)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const body = pickBody(params, [
              "name",
              "slug",
              "experience_profile",
              "owner",
              "is_active",
            ]);
            const summary = `create org "${params.name as string}" (slug ${params.slug as string})`;
            return stageWrite(summary, () =>
              scopelyFetch(`/api/auth/orgs/`, { method: "POST", body: JSON.stringify(body) }),
            );
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_update_org",
        description:
          "Update a Scopely VIP organization's fields (platform admin action). You ARE authorized — " +
          "CALL this tool, do NOT defer to the admin UI. Pass only the fields to change. It only STAGES " +
          "the change; nothing applies until the requester replies `CONFIRM <code>`.",
        parameters: Type.Object({
          org_id: Type.Number({ description: "Numeric organization id" }),
          name: Type.Optional(Type.String({ description: "New display name" })),
          slug: Type.Optional(Type.String({ description: "New URL slug" })),
          experience_profile: Type.Optional(
            Type.Number({ description: "Experience profile id to assign" }),
          ),
          owner: Type.Optional(
            Type.Number({ description: "User id to set as owner (must be a member of the org)" }),
          ),
          is_active: Type.Optional(Type.Boolean({ description: "Active flag" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const orgId = params.org_id as number;
            const body = pickBody(params, [
              "name",
              "slug",
              "experience_profile",
              "owner",
              "is_active",
            ]);
            if (Object.keys(body).length === 0) {
              return jsonResult({ ok: false, error: "No fields to update." });
            }
            return stageWrite(`update org id ${orgId}: ${describeChanges(body)}`, () =>
              scopelyFetch(`/api/auth/orgs/${orgId}/`, {
                method: "PATCH",
                body: JSON.stringify(body),
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

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_delete_org",
        description:
          "Deactivate (soft-delete) a Scopely VIP organization (platform admin action). You ARE " +
          "authorized — CALL this tool. It only STAGES the deactivation; nothing happens until the " +
          "requester replies `CONFIRM <code>`. This sets the org inactive; it does not hard-delete rows.",
        parameters: Type.Object({
          org_id: Type.Number({ description: "Numeric organization id" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const orgId = params.org_id as number;
            return stageWrite(`DEACTIVATE (soft-delete) org id ${orgId}`, () =>
              scopelyFetch(`/api/auth/orgs/${orgId}/`, { method: "DELETE" }),
            );
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_add_org_domain",
        description:
          "Add an auto-join email domain to a Scopely VIP organization (platform admin action). You ARE " +
          "authorized — CALL this tool. It only STAGES the change; nothing happens until the requester " +
          "replies `CONFIRM <code>`. Personal-email domains are rejected by the backend.",
        parameters: Type.Object({
          org_id: Type.Number({ description: "Numeric organization id" }),
          domain: Type.String({ description: "Email domain to add (e.g. acme.com)" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const orgId = params.org_id as number;
            const domain = (params.domain as string).trim().toLowerCase();
            return stageWrite(`add domain ${domain} to org id ${orgId}`, () =>
              scopelyFetch(`/api/auth/orgs/${orgId}/domains/`, {
                method: "POST",
                body: JSON.stringify({ domain }),
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

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_remove_org_domain",
        description:
          "Remove an auto-join email domain from a Scopely VIP organization (platform admin action). " +
          "You ARE authorized — CALL this tool. It only STAGES the removal; nothing happens until the " +
          "requester replies `CONFIRM <code>`. Look up the domain id with scopely_list_org_domains.",
        parameters: Type.Object({
          org_id: Type.Number({ description: "Numeric organization id" }),
          domain_id: Type.Number({
            description: "Numeric domain id (from scopely_list_org_domains)",
          }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const orgId = params.org_id as number;
            const domainId = params.domain_id as number;
            return stageWrite(`remove domain id ${domainId} from org id ${orgId}`, () =>
              scopelyFetch(`/api/auth/orgs/${orgId}/domains/${domainId}/`, { method: "DELETE" }),
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
