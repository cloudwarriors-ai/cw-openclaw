import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { describeChanges, pickBody, stageWrite } from "./gated.js";
import { errorResult, jsonResult, scopelyFetch } from "./scopely-api.js";

// Vendor-config tools (Scopely VIP admin): vendors, their project types, and
// vendor terminology. All IsPlatformStaff. Reads run immediately; writes are
// confirm-gated via stageWrite(). Vendor detail routes use the vendor KEY (string);
// project types and terms use numeric ids nested under the vendor.

const VENDOR_FIELDS = [
  "key",
  "display_name",
  "logo_url",
  "is_source",
  "is_destination",
  "status",
  "extraction_enabled",
] as const;

const PROJECT_TYPE_FIELDS = [
  "key",
  "label",
  "enabled",
  "sort_order",
  "product_info_url",
  "scope_category",
  "catalog_seeded",
] as const;

const TERM_FIELDS = ["scope", "key", "label"] as const;

export function registerVendorConfigTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // ── Vendors ───────────────────────────────────────────────────────────────
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_vendors",
        description:
          "List Scopely VIP vendors with full admin records (key, display name, source/destination " +
          "flags, status, extraction flag). Read-only — runs immediately.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const res = await scopelyFetch(`/api/admin/vendors/`);
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
        name: "scopely_get_vendor",
        description:
          "Get a single Scopely VIP vendor's admin record by vendor key (e.g. zoom). Read-only — runs immediately.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key (e.g. zoom, ringcentral)" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const res = await scopelyFetch(
              `/api/admin/vendors/${encodeURIComponent(params.vendor_key as string)}/`,
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
        name: "scopely_create_vendor",
        description:
          "Create a new Scopely VIP vendor (admin action). You ARE authorized — CALL this tool. It only " +
          "STAGES the create; nothing happens until the requester replies `CONFIRM <code>`. key must be unique.",
        parameters: Type.Object({
          key: Type.String({ description: "Unique vendor key (machine id, e.g. dialpad)" }),
          display_name: Type.String({ description: "Display name (e.g. Dialpad)" }),
          logo_url: Type.Optional(Type.String({ description: "Logo URL" })),
          is_source: Type.Optional(
            Type.Boolean({ description: "Vendor can be a migration source (default true)" }),
          ),
          is_destination: Type.Optional(
            Type.Boolean({ description: "Vendor can be a destination (default true)" }),
          ),
          status: Type.Optional(
            Type.String({ description: "Status: active or inactive (default active)" }),
          ),
          extraction_enabled: Type.Optional(
            Type.Boolean({ description: "Enable extraction (default false)" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const body = pickBody(params, VENDOR_FIELDS);
            return stageWrite(
              `create vendor ${params.key as string} ("${params.display_name as string}")`,
              () =>
                scopelyFetch(`/api/admin/vendors/`, { method: "POST", body: JSON.stringify(body) }),
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
        name: "scopely_update_vendor",
        description:
          "Update a Scopely VIP vendor (admin action). You ARE authorized — CALL this tool. Pass only " +
          "fields to change. It only STAGES the change; nothing applies until `CONFIRM <code>`.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key of the vendor to update" }),
          display_name: Type.Optional(Type.String()),
          logo_url: Type.Optional(Type.String()),
          is_source: Type.Optional(Type.Boolean()),
          is_destination: Type.Optional(Type.Boolean()),
          status: Type.Optional(Type.String({ description: "active or inactive" })),
          extraction_enabled: Type.Optional(Type.Boolean()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const body = pickBody(params, [
              "display_name",
              "logo_url",
              "is_source",
              "is_destination",
              "status",
              "extraction_enabled",
            ]);
            if (Object.keys(body).length === 0) {
              return jsonResult({ ok: false, error: "No fields to update." });
            }
            return stageWrite(`update vendor ${vendorKey}: ${describeChanges(body)}`, () =>
              scopelyFetch(`/api/admin/vendors/${encodeURIComponent(vendorKey)}/`, {
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
        name: "scopely_delete_vendor",
        description:
          "Delete a Scopely VIP vendor (admin action, destructive). You ARE authorized — CALL this tool. " +
          "It only STAGES the delete; nothing happens until the requester replies `CONFIRM <code>`.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key of the vendor to delete" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            return stageWrite(`DELETE vendor ${vendorKey}`, () =>
              scopelyFetch(`/api/admin/vendors/${encodeURIComponent(vendorKey)}/`, {
                method: "DELETE",
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

  // ── Project types (nested under a vendor) ─────────────────────────────────
  const ptBase = (vendorKey: string) =>
    `/api/admin/vendors/${encodeURIComponent(vendorKey)}/project-types/`;

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_project_types",
        description:
          "List a Scopely VIP vendor's project types (key, label, enabled, scope category). " +
          "Read-only — runs immediately.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key (e.g. zoom)" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const res = await scopelyFetch(ptBase(params.vendor_key as string));
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
        name: "scopely_create_project_type",
        description:
          "Create a project type under a Scopely VIP vendor (admin action). You ARE authorized — CALL " +
          "this tool. It only STAGES the create; nothing happens until `CONFIRM <code>`. NOTE: creating a " +
          "project type auto-seeds its deployment types from the global templates plus locked pricing items.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key (e.g. zoom)" }),
          key: Type.String({ description: "Project-type key (machine id, e.g. ucaas-migration)" }),
          label: Type.String({ description: "Display label" }),
          enabled: Type.Optional(Type.Boolean({ description: "Enabled flag (default false)" })),
          sort_order: Type.Optional(Type.Number()),
          product_info_url: Type.Optional(Type.String({ description: "Product info URL" })),
          scope_category: Type.Optional(
            Type.String({ description: "Scope: ucaas, ccaas, or both (default both)" }),
          ),
          catalog_seeded: Type.Optional(Type.Boolean()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const body = pickBody(params, PROJECT_TYPE_FIELDS);
            return stageWrite(
              `create project type ${params.key as string} on vendor ${vendorKey} (auto-seeds deployment types + locked pricing)`,
              () => scopelyFetch(ptBase(vendorKey), { method: "POST", body: JSON.stringify(body) }),
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
        name: "scopely_update_project_type",
        description:
          "Update a project type on a Scopely VIP vendor (admin action). You ARE authorized — CALL this " +
          "tool. Pass only fields to change. It only STAGES the change; nothing applies until `CONFIRM <code>`.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          project_type_id: Type.Number({
            description: "Project-type id (from scopely_list_project_types)",
          }),
          key: Type.Optional(Type.String()),
          label: Type.Optional(Type.String()),
          enabled: Type.Optional(Type.Boolean()),
          sort_order: Type.Optional(Type.Number()),
          product_info_url: Type.Optional(Type.String()),
          scope_category: Type.Optional(Type.String({ description: "ucaas, ccaas, or both" })),
          catalog_seeded: Type.Optional(Type.Boolean()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const ptId = params.project_type_id as number;
            const body = pickBody(params, PROJECT_TYPE_FIELDS);
            if (Object.keys(body).length === 0) {
              return jsonResult({ ok: false, error: "No fields to update." });
            }
            return stageWrite(
              `update project type id ${ptId} on ${vendorKey}: ${describeChanges(body)}`,
              () =>
                scopelyFetch(`${ptBase(vendorKey)}${ptId}/`, {
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
        name: "scopely_delete_project_type",
        description:
          "Delete a project type from a Scopely VIP vendor (admin action, destructive). You ARE " +
          "authorized — CALL this tool. It only STAGES the delete; nothing happens until `CONFIRM <code>`.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          project_type_id: Type.Number({ description: "Project-type id" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const ptId = params.project_type_id as number;
            return stageWrite(`DELETE project type id ${ptId} on vendor ${vendorKey}`, () =>
              scopelyFetch(`${ptBase(vendorKey)}${ptId}/`, { method: "DELETE" }),
            );
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // ── Vendor terms (terminology overrides, nested under a vendor) ───────────
  const termBase = (vendorKey: string) =>
    `/api/admin/vendors/${encodeURIComponent(vendorKey)}/terms/`;

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_vendor_terms",
        description:
          "List a Scopely VIP vendor's terminology overrides (wizard display language per field/card). " +
          "Read-only — runs immediately.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const res = await scopelyFetch(termBase(params.vendor_key as string));
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
        name: "scopely_create_vendor_term",
        description:
          "Add a terminology override to a Scopely VIP vendor (admin action). You ARE authorized — CALL " +
          "this tool. It only STAGES the create; nothing happens until `CONFIRM <code>`. (vendor, scope, key) " +
          "must be unique.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          scope: Type.String({ description: "Term scope: field or card" }),
          key: Type.String({ description: "Field/card key the term applies to" }),
          label: Type.String({ description: "Vendor-specific display label" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const body = pickBody(params, TERM_FIELDS);
            return stageWrite(
              `create vendor term ${params.scope as string}/${params.key as string}="${params.label as string}" on ${vendorKey}`,
              () =>
                scopelyFetch(termBase(vendorKey), { method: "POST", body: JSON.stringify(body) }),
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
        name: "scopely_update_vendor_term",
        description:
          "Update a Scopely VIP vendor terminology override (admin action). You ARE authorized — CALL " +
          "this tool. Pass only fields to change. It only STAGES the change; nothing applies until `CONFIRM <code>`.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          term_id: Type.Number({ description: "Term id (from scopely_list_vendor_terms)" }),
          scope: Type.Optional(Type.String({ description: "field or card" })),
          key: Type.Optional(Type.String()),
          label: Type.Optional(Type.String()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const termId = params.term_id as number;
            const body = pickBody(params, TERM_FIELDS);
            if (Object.keys(body).length === 0) {
              return jsonResult({ ok: false, error: "No fields to update." });
            }
            return stageWrite(
              `update vendor term id ${termId} on ${vendorKey}: ${describeChanges(body)}`,
              () =>
                scopelyFetch(`${termBase(vendorKey)}${termId}/`, {
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
        name: "scopely_delete_vendor_term",
        description:
          "Delete a Scopely VIP vendor terminology override (admin action). You ARE authorized — CALL " +
          "this tool. It only STAGES the delete; nothing happens until `CONFIRM <code>`.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          term_id: Type.Number({ description: "Term id" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const termId = params.term_id as number;
            return stageWrite(`DELETE vendor term id ${termId} on ${vendorKey}`, () =>
              scopelyFetch(`${termBase(vendorKey)}${termId}/`, { method: "DELETE" }),
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
