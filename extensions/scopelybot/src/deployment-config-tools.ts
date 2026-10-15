import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { assertNativeSchema } from "./capability-registry.js";
import { describeChanges, pickBody, stageWrite } from "./gated.js";
import { opsRead } from "./ops-client.js";
import { opsStageWrite } from "./ops-write-client.js";
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

const deploymentTypeFields = {
  label: Type.String({ minLength: 1, maxLength: 100 }),
  description: Type.String({ maxLength: 500 }),
  long_description: Type.String({ maxLength: 500 }),
  icon: Type.String({ maxLength: 100 }),
  sort_order: Type.Integer({ minimum: 0, maximum: 2147483647 }),
};
const deploymentTypeUpdateSchema = Type.Object(
  {
    vendor_key: Type.String({
      pattern: "^[-a-zA-Z0-9_]+$",
      minLength: 1,
      maxLength: 50,
      description: "Exact native key from catalog reads",
    }),
    project_type: Type.String({
      pattern: "^[-a-zA-Z0-9_]+$",
      minLength: 1,
      maxLength: 50,
      description: "Exact native key from catalog reads",
    }),
    deployment_type: Type.String({
      pattern: "^[-a-zA-Z0-9_]+$",
      minLength: 1,
      maxLength: 50,
      description: "Exact native key from catalog reads",
    }),
    field: Type.String({
      enum: Object.keys(deploymentTypeFields),
      description: "The single field the human explicitly asked to change",
    }),
    value: Type.Unknown({
      description:
        "The exact replacement value: sort_order requires an integer; other fields require strings. No defaults.",
    }),
  },
  { additionalProperties: false },
);
function prepareDeploymentTypeUpdate(args: unknown): Record<string, unknown> {
  assertNativeSchema(deploymentTypeUpdateSchema, args);
  const params = args as Record<string, unknown>;
  if (!Object.hasOwn(deploymentTypeFields, params.field as string)) {
    throw new Error("The selected field is unsupported.");
  }
  if (!Object.hasOwn(params, "value") || params.value === undefined) {
    throw new Error("An explicit value is required for the selected field.");
  }
  assertNativeSchema(
    deploymentTypeFields[params.field as keyof typeof deploymentTypeFields],
    params.value,
  );
  return params;
}

export function registerDeploymentConfigTools(api: OpenClawPluginApi, logger: AuditLogger) {
  const dtBase = (vendorKey: string, ptPk: number) =>
    `/api/admin/vendors/${encodeURIComponent(vendorKey)}/project-types/${ptPk}/deployment-types/`;

  // ── Deployment types (per project-type) ───────────────────────────────────
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_deployment_types",
        description:
          "List the deployment types offered for a VIP vendor's project type (key, label, " +
          "description; e.g. autopilot, copilot, bespoke). Read-only — runs immediately.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key (e.g. zoom)" }),
          project_type: Type.String({
            description: "Project-type key (from scopely_list_project_types)",
          }),
        }),
        execute: opsRead,
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
          "Prepare exactly ONE native field update per human preview. Choose field and value explicitly; " +
          "do not copy other current values or invent empty/zero defaults. For a multi-field request, ask which " +
          "field to change first; do not stage a batch automatically. Human CONFIRM is required.",
        parameters: deploymentTypeUpdateSchema,
        prepareArguments: prepareDeploymentTypeUpdate,
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const args = prepareDeploymentTypeUpdate(params);
            return opsStageWrite("catalog.deployment_types.update", {
              vendor_key: args.vendor_key,
              project_type: args.project_type,
              deployment_type: args.deployment_type,
              [args.field as string]: args.value,
            });
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
