import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { describeChanges, pickBody, stageWrite } from "./gated.js";
import { errorResult, jsonResult, scopelyFetch } from "./scopely-api.js";

// Deployment-type config tools (Scopely VIP admin). Two surfaces:
//  - per project-type deployment types: /api/admin/vendors/<key>/project-types/<pt>/deployment-types/
//  - global templates (seed new project types): /api/admin/deployment-type-templates/
// All IsPlatformStaff. Reads run immediately; writes are confirm-gated.

const DT_FIELDS = [
  "key",
  "label",
  "description",
  "long_description",
  "icon",
  "sort_order",
  "is_active",
] as const;

const TEMPLATE_FIELDS = [
  "key",
  "label",
  "description",
  "long_description",
  "icon",
  "sort_order",
] as const;

export function registerDeploymentConfigTools(api: OpenClawPluginApi, logger: AuditLogger) {
  const dtBase = (vendorKey: string, ptPk: number) =>
    `/api/admin/vendors/${encodeURIComponent(vendorKey)}/project-types/${ptPk}/deployment-types/`;

  // ── Deployment types (per project-type) ───────────────────────────────────
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_deployment_types",
        description:
          "List the deployment types configured on a Scopely VIP vendor's project type (e.g. autopilot, " +
          "copilot, bespoke). Read-only — runs immediately.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key (e.g. zoom)" }),
          project_type_id: Type.Number({ description: "Project-type id" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const res = await scopelyFetch(
              dtBase(params.vendor_key as string, params.project_type_id as number),
            );
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
        name: "scopely_create_deployment_type",
        description:
          "Create a deployment type on a Scopely VIP project type (admin action). You ARE authorized — " +
          "CALL this tool. It only STAGES the create; nothing happens until `CONFIRM <code>`.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          project_type_id: Type.Number({ description: "Project-type id" }),
          key: Type.String({ description: "Deployment-type key (e.g. autopilot)" }),
          label: Type.String({ description: "Display label" }),
          description: Type.Optional(Type.String({ description: "Short description" })),
          long_description: Type.Optional(Type.String({ description: "Long description" })),
          icon: Type.Optional(Type.String({ description: "Lucide icon key" })),
          sort_order: Type.Optional(Type.Number()),
          is_active: Type.Optional(Type.Boolean({ description: "Active flag (default true)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const ptPk = params.project_type_id as number;
            const body = pickBody(params, DT_FIELDS);
            return stageWrite(
              `create deployment type ${params.key as string} on ${vendorKey}/pt ${ptPk}`,
              () =>
                scopelyFetch(dtBase(vendorKey, ptPk), {
                  method: "POST",
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
        name: "scopely_update_deployment_type",
        description:
          "Update a deployment type on a Scopely VIP project type (admin action). You ARE authorized — " +
          "CALL this tool. Pass only fields to change. It only STAGES the change; nothing applies until " +
          "`CONFIRM <code>`.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          project_type_id: Type.Number({ description: "Project-type id" }),
          id: Type.Number({
            description: "Deployment-type id (from scopely_list_deployment_types)",
          }),
          key: Type.Optional(Type.String()),
          label: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          long_description: Type.Optional(Type.String()),
          icon: Type.Optional(Type.String()),
          sort_order: Type.Optional(Type.Number()),
          is_active: Type.Optional(Type.Boolean()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const ptPk = params.project_type_id as number;
            const id = params.id as number;
            const body = pickBody(params, DT_FIELDS);
            if (Object.keys(body).length === 0) {
              return jsonResult({ ok: false, error: "No fields to update." });
            }
            return stageWrite(`update deployment type id ${id}: ${describeChanges(body)}`, () =>
              scopelyFetch(`${dtBase(vendorKey, ptPk)}${id}/`, {
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
        name: "scopely_delete_deployment_type",
        description:
          "Delete a deployment type from a Scopely VIP project type (admin action, destructive). You ARE " +
          "authorized — CALL this tool. It only STAGES the delete; nothing happens until `CONFIRM <code>`.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          project_type_id: Type.Number({ description: "Project-type id" }),
          id: Type.Number({ description: "Deployment-type id" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const ptPk = params.project_type_id as number;
            const id = params.id as number;
            return stageWrite(`DELETE deployment type id ${id} on ${vendorKey}/pt ${ptPk}`, () =>
              scopelyFetch(`${dtBase(vendorKey, ptPk)}${id}/`, { method: "DELETE" }),
            );
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // ── Deployment-type templates (global; seed new project types) ────────────
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_deployment_type_templates",
        description:
          "List the global Scopely VIP deployment-type templates (used to seed deployment types when a " +
          "new project type is created). Read-only — runs immediately.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const res = await scopelyFetch(`/api/admin/deployment-type-templates/`);
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
        name: "scopely_create_deployment_type_template",
        description:
          "Create a global deployment-type template (admin action). You ARE authorized — CALL this tool. " +
          "It only STAGES the create; nothing happens until `CONFIRM <code>`. key must be globally unique. " +
          "Affects what gets seeded into every NEW project type.",
        parameters: Type.Object({
          key: Type.String({ description: "Globally unique template key" }),
          label: Type.String({ description: "Display label" }),
          description: Type.Optional(Type.String()),
          long_description: Type.Optional(Type.String()),
          icon: Type.Optional(Type.String({ description: "Lucide icon key" })),
          sort_order: Type.Optional(Type.Number()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const body = pickBody(params, TEMPLATE_FIELDS);
            return stageWrite(`create deployment-type template ${params.key as string}`, () =>
              scopelyFetch(`/api/admin/deployment-type-templates/`, {
                method: "POST",
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
        name: "scopely_update_deployment_type_template",
        description:
          "Update a global deployment-type template (admin action). You ARE authorized — CALL this tool. " +
          "Pass only fields to change. It only STAGES the change; nothing applies until `CONFIRM <code>`.",
        parameters: Type.Object({
          id: Type.Number({
            description: "Template id (from scopely_list_deployment_type_templates)",
          }),
          key: Type.Optional(Type.String()),
          label: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          long_description: Type.Optional(Type.String()),
          icon: Type.Optional(Type.String()),
          sort_order: Type.Optional(Type.Number()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const id = params.id as number;
            const body = pickBody(params, TEMPLATE_FIELDS);
            if (Object.keys(body).length === 0) {
              return jsonResult({ ok: false, error: "No fields to update." });
            }
            return stageWrite(
              `update deployment-type template id ${id}: ${describeChanges(body)}`,
              () =>
                scopelyFetch(`/api/admin/deployment-type-templates/${id}/`, {
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
        name: "scopely_delete_deployment_type_template",
        description:
          "Delete a global deployment-type template (admin action, destructive). You ARE authorized — " +
          "CALL this tool. It only STAGES the delete; nothing happens until `CONFIRM <code>`.",
        parameters: Type.Object({
          id: Type.Number({ description: "Template id" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const id = params.id as number;
            return stageWrite(`DELETE deployment-type template id ${id}`, () =>
              scopelyFetch(`/api/admin/deployment-type-templates/${id}/`, { method: "DELETE" }),
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
