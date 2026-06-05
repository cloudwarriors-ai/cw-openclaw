import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { describeChanges, pickBody, stageWrite } from "./gated.js";
import { buildQuery, errorResult, jsonResult, scopelyFetch } from "./scopely-api.js";

// Pricing-config tools (Scopely VIP admin). All IsPlatformStaff. Reads run
// immediately; writes are confirm-gated. Prices are decimal STRINGS (e.g. "15.00").
// unit_price_by_deployment is a dict {deployment_key: "price"}; deployment_types is a string list.

const PRICING_FIELDS = [
  "pricing_key",
  "display_name",
  "description",
  "unit_price",
  "unit_price_by_deployment",
  "category",
  "sort_order",
  "deployment_types",
  "is_active",
] as const;

function pricingBodyParams(extra: Record<string, unknown> = {}) {
  return Type.Object({
    pricing_key: Type.String({ description: "Unique pricing key (machine id)" }),
    display_name: Type.String({ description: "Human-readable name" }),
    description: Type.Optional(Type.String({ description: "Description" })),
    unit_price: Type.String({ description: 'Unit price as a decimal string, e.g. "15.00"' }),
    unit_price_by_deployment: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: 'Per-deployment price overrides, e.g. {"autopilot":"18.00"}',
      }),
    ),
    category: Type.String({
      description: "Pricing category (must be a valid UCaaS pricing category)",
    }),
    sort_order: Type.Optional(Type.Number({ description: "Sort order (default 0)" })),
    deployment_types: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Deployment type keys, e.g. ["autopilot","copilot"]',
      }),
    ),
    is_active: Type.Optional(Type.Boolean({ description: "Active flag (default true)" })),
    ...extra,
  });
}

export function registerPricingTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // ── Pricing defaults (global rate card) ──────────────────────────────────
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_pricing_defaults",
        description:
          "List Scopely VIP global pricing defaults (the default rate card). Read-only — runs " +
          "immediately. Optionally filter by scope_category (ucaas or ccaas).",
        parameters: Type.Object({
          scope_category: Type.Optional(Type.String({ description: "Filter: ucaas or ccaas" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const qs = buildQuery(params, ["scope_category"]);
            const res = await scopelyFetch(`/api/admin/pricing-defaults/${qs}`);
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
        name: "scopely_get_pricing_default",
        description:
          "Get a single Scopely VIP pricing default by id. Read-only — runs immediately.",
        parameters: Type.Object({ id: Type.Number({ description: "Pricing default id" }) }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const res = await scopelyFetch(`/api/admin/pricing-defaults/${params.id as number}/`);
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
        name: "scopely_create_pricing_default",
        description:
          "Create a Scopely VIP global pricing default (admin action). You ARE authorized — CALL this " +
          "tool. It only STAGES the create; nothing happens until the requester replies `CONFIRM <code>`. " +
          "Note: (scope_category, pricing_key) must be unique; pricing_key cannot be a go-live key.",
        parameters: pricingBodyParams({
          scope_category: Type.String({ description: "Scope: ucaas or ccaas" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const body = pickBody(params, ["scope_category", ...PRICING_FIELDS]);
            return stageWrite(
              `create pricing default ${params.scope_category as string}/${params.pricing_key as string} @ ${params.unit_price as string}`,
              () =>
                scopelyFetch(`/api/admin/pricing-defaults/`, {
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
        name: "scopely_update_pricing_default",
        description:
          "Update a Scopely VIP pricing default (admin action). You ARE authorized — CALL this tool. " +
          "Pass only fields to change. It only STAGES the change; nothing applies until `CONFIRM <code>`.",
        parameters: Type.Object({
          id: Type.Number({ description: "Pricing default id" }),
          display_name: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          unit_price: Type.Optional(Type.String({ description: 'Decimal string, e.g. "15.00"' })),
          unit_price_by_deployment: Type.Optional(Type.Record(Type.String(), Type.String())),
          category: Type.Optional(Type.String()),
          sort_order: Type.Optional(Type.Number()),
          deployment_types: Type.Optional(Type.Array(Type.String())),
          is_active: Type.Optional(Type.Boolean()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const id = params.id as number;
            const body = pickBody(params, PRICING_FIELDS);
            if (Object.keys(body).length === 0) {
              return jsonResult({ ok: false, error: "No fields to update." });
            }
            return stageWrite(`update pricing default id ${id}: ${describeChanges(body)}`, () =>
              scopelyFetch(`/api/admin/pricing-defaults/${id}/`, {
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
        name: "scopely_delete_pricing_default",
        description:
          "Delete a Scopely VIP pricing default (admin action). You ARE authorized — CALL this tool. " +
          "It only STAGES the delete; nothing happens until the requester replies `CONFIRM <code>`.",
        parameters: Type.Object({ id: Type.Number({ description: "Pricing default id" }) }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const id = params.id as number;
            return stageWrite(`DELETE pricing default id ${id}`, () =>
              scopelyFetch(`/api/admin/pricing-defaults/${id}/`, { method: "DELETE" }),
            );
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // ── Pricing items (per vendor project-type) ──────────────────────────────
  const itemBase = (vendorKey: string, ptPk: number) =>
    `/api/admin/vendors/${vendorKey}/project-types/${ptPk}/pricing-items/`;

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_pricing_items",
        description:
          "List Scopely VIP pricing items for a vendor's project type. Read-only — runs immediately. " +
          "Needs the vendor key and project-type id.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key (e.g. zoom)" }),
          project_type_id: Type.Number({ description: "Project-type id" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const res = await scopelyFetch(
              itemBase(params.vendor_key as string, params.project_type_id as number),
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
        name: "scopely_create_pricing_item",
        description:
          "Create a Scopely VIP pricing item under a vendor's project type (admin action). You ARE " +
          "authorized — CALL this tool. It only STAGES the create; nothing happens until `CONFIRM <code>`. " +
          "Note: (project_type, pricing_key) must be unique.",
        parameters: pricingBodyParams({
          vendor_key: Type.String({ description: "Vendor key (e.g. zoom)" }),
          project_type_id: Type.Number({ description: "Project-type id" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const ptPk = params.project_type_id as number;
            const body = pickBody(params, PRICING_FIELDS);
            return stageWrite(
              `create pricing item ${params.pricing_key as string} on ${vendorKey}/pt ${ptPk} @ ${params.unit_price as string}`,
              () =>
                scopelyFetch(itemBase(vendorKey, ptPk), {
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
        name: "scopely_update_pricing_item",
        description:
          "Update a Scopely VIP pricing item (admin action). You ARE authorized — CALL this tool. Pass " +
          "only fields to change. It only STAGES the change; nothing applies until `CONFIRM <code>`. Note: " +
          "deactivating an item referenced by a scoping card is rejected by the backend.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          project_type_id: Type.Number({ description: "Project-type id" }),
          id: Type.Number({ description: "Pricing item id" }),
          display_name: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          unit_price: Type.Optional(Type.String({ description: 'Decimal string, e.g. "15.00"' })),
          unit_price_by_deployment: Type.Optional(Type.Record(Type.String(), Type.String())),
          category: Type.Optional(Type.String()),
          sort_order: Type.Optional(Type.Number()),
          deployment_types: Type.Optional(Type.Array(Type.String())),
          is_active: Type.Optional(Type.Boolean()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const ptPk = params.project_type_id as number;
            const id = params.id as number;
            const body = pickBody(params, PRICING_FIELDS);
            if (Object.keys(body).length === 0) {
              return jsonResult({ ok: false, error: "No fields to update." });
            }
            return stageWrite(`update pricing item id ${id}: ${describeChanges(body)}`, () =>
              scopelyFetch(`${itemBase(vendorKey, ptPk)}${id}/`, {
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
        name: "scopely_delete_pricing_item",
        description:
          "Delete a Scopely VIP pricing item (admin action). You ARE authorized — CALL this tool. It only " +
          "STAGES the delete; nothing happens until `CONFIRM <code>`. Locked/seeded items cannot be deleted.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          project_type_id: Type.Number({ description: "Project-type id" }),
          id: Type.Number({ description: "Pricing item id" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const ptPk = params.project_type_id as number;
            const id = params.id as number;
            return stageWrite(`DELETE pricing item id ${id} on ${vendorKey}/pt ${ptPk}`, () =>
              scopelyFetch(`${itemBase(vendorKey, ptPk)}${id}/`, { method: "DELETE" }),
            );
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // ── Currencies ────────────────────────────────────────────────────────────
  const CURRENCY_FIELDS = ["code", "symbol", "name", "exchange_rate", "is_active"] as const;

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_currencies",
        description: "List Scopely VIP configured currencies. Read-only — runs immediately.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const res = await scopelyFetch(`/api/admin/currencies/`);
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
        name: "scopely_create_currency",
        description:
          "Create a Scopely VIP currency (admin action). You ARE authorized — CALL this tool. It only " +
          "STAGES the create; nothing happens until `CONFIRM <code>`. code must be a unique 3-letter ISO code.",
        parameters: Type.Object({
          code: Type.String({ description: "3-letter ISO code (e.g. EUR)" }),
          symbol: Type.String({ description: "Currency symbol (e.g. €)" }),
          name: Type.String({ description: "Currency name (e.g. Euro)" }),
          exchange_rate: Type.Optional(
            Type.String({ description: 'Decimal string, e.g. "0.9200"' }),
          ),
          is_active: Type.Optional(Type.Boolean({ description: "Active flag (default true)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const body = pickBody(params, CURRENCY_FIELDS);
            return stageWrite(
              `create currency ${params.code as string} (${params.name as string})`,
              () =>
                scopelyFetch(`/api/admin/currencies/`, {
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
        name: "scopely_update_currency",
        description:
          "Update a Scopely VIP currency (admin action). You ARE authorized — CALL this tool. Pass only " +
          "fields to change. It only STAGES the change; nothing applies until `CONFIRM <code>`.",
        parameters: Type.Object({
          id: Type.Number({ description: "Currency id" }),
          code: Type.Optional(Type.String()),
          symbol: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          exchange_rate: Type.Optional(Type.String({ description: "Decimal string" })),
          is_active: Type.Optional(Type.Boolean()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const id = params.id as number;
            const body = pickBody(params, CURRENCY_FIELDS);
            if (Object.keys(body).length === 0) {
              return jsonResult({ ok: false, error: "No fields to update." });
            }
            return stageWrite(`update currency id ${id}: ${describeChanges(body)}`, () =>
              scopelyFetch(`/api/admin/currencies/${id}/`, {
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
        name: "scopely_delete_currency",
        description:
          "Delete a Scopely VIP currency (admin action). You ARE authorized — CALL this tool. It only " +
          "STAGES the delete; nothing happens until `CONFIRM <code>`.",
        parameters: Type.Object({ id: Type.Number({ description: "Currency id" }) }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const id = params.id as number;
            return stageWrite(`DELETE currency id ${id}`, () =>
              scopelyFetch(`/api/admin/currencies/${id}/`, { method: "DELETE" }),
            );
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // ── Session pricing config (global singleton) ────────────────────────────
  const SESSION_PRICING_FIELDS = [
    "additional_go_live_price",
    "additional_go_live_display_name",
    "additional_go_live_copy",
    "post_go_live_support_enabled",
    "post_go_live_support_price",
    "post_go_live_support_display_name",
    "post_go_live_support_copy",
    "post_go_live_support_m1_meetings",
    "post_go_live_support_m2_4_meetings",
    "post_go_live_support_adhoc_hours",
    "post_go_live_support_adhoc_value",
  ] as const;

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_get_session_pricing_config",
        description:
          "Get the Scopely VIP global session-pricing config singleton (go-live + post-go-live support " +
          "pricing). Read-only — runs immediately.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const res = await scopelyFetch(`/api/admin/session-pricing-config/`);
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
        name: "scopely_update_session_pricing_config",
        description:
          "Update the Scopely VIP global session-pricing config (admin action). You ARE authorized — CALL " +
          "this tool. Pass only fields to change. It only STAGES the change; nothing applies until " +
          "`CONFIRM <code>`. Price fields must be >= 0.",
        parameters: Type.Object({
          additional_go_live_price: Type.Optional(Type.String({ description: "Decimal string" })),
          additional_go_live_display_name: Type.Optional(Type.String()),
          additional_go_live_copy: Type.Optional(Type.String()),
          post_go_live_support_enabled: Type.Optional(Type.Boolean()),
          post_go_live_support_price: Type.Optional(Type.String({ description: "Decimal string" })),
          post_go_live_support_display_name: Type.Optional(Type.String()),
          post_go_live_support_copy: Type.Optional(Type.String()),
          post_go_live_support_m1_meetings: Type.Optional(Type.Number()),
          post_go_live_support_m2_4_meetings: Type.Optional(Type.Number()),
          post_go_live_support_adhoc_hours: Type.Optional(
            Type.String({ description: "Decimal string" }),
          ),
          post_go_live_support_adhoc_value: Type.Optional(
            Type.String({ description: "Decimal string" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const body = pickBody(params, SESSION_PRICING_FIELDS);
            if (Object.keys(body).length === 0) {
              return jsonResult({ ok: false, error: "No fields to update." });
            }
            return stageWrite(`update session-pricing config: ${describeChanges(body)}`, () =>
              scopelyFetch(`/api/admin/session-pricing-config/`, {
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
}
