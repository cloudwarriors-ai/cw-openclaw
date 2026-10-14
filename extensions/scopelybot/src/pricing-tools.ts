import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { fetchDeploymentTypeKeys } from "./deployment-keys.js";
import { describeChanges, pickBody, stageWrite } from "./gated.js";
import { opsRead } from "./ops-client.js";
import { opsStageWrite } from "./ops-write-client.js";
import { errorResult, jsonResult, scopelyFetch } from "./scopely-api.js";

// Pricing-config tools (Scopely VIP admin). All IsPlatformStaff. Reads run
// immediately; writes are confirm-gated. Prices are decimal STRINGS (e.g. "15.00").
// unit_price_by_deployment is a dict {deployment_key: "price"}; deployment_types is a string list.

// Fail-loud deployment-key validation for pricing writes (live incident
// 2026-07-21): asked to "Make it core", the model wrote the pricing CATEGORY
// "core" into deployment_types on two dialpad items. The backend accepted it
// (its validator only checks "list of strings"), but the pricing engine gates
// CCaaS rows on `effective_deployment in deployment_types` — so rows with an
// unknown deployment type NEVER match a real deployment and silently drop from
// every quote. Category is validated loudly by the backend (400 naming the
// enum); deployment keys are the SILENT failure, so they get the pre-stage
// gate here — same pattern as the issue-#81 fix in support-tools.
// Returns an error string naming the unknown + valid keys, or null to proceed.
// FAILS OPEN (null) when the template lookup errors: validation must never
// turn a backend outage into a false rejection.
async function rejectUnknownDeploymentKeys(
  params: Record<string, unknown>,
): Promise<string | null> {
  const referenced: string[] = [];
  if (Array.isArray(params.deployment_types)) {
    referenced.push(...params.deployment_types.map(String));
  }
  const overrides = params.unit_price_by_deployment;
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
    referenced.push(...Object.keys(overrides));
  }
  if (referenced.length === 0) {
    return null;
  }
  const validKeys = await fetchDeploymentTypeKeys();
  if (validKeys.length === 0) {
    return null;
  } // fail open — lookup unavailable
  const unknown = [...new Set(referenced.filter((k) => !validKeys.includes(k)))];
  if (unknown.length === 0) {
    return null;
  }
  return (
    `Unknown deployment type key(s): ${unknown.join(", ")}. Valid keys: ${validKeys.join(", ")}. ` +
    `A pricing row gated on an unknown deployment type never matches a real deployment and ` +
    `silently drops from every quote. Note "Core" is a pricing CATEGORY, not a deployment ` +
    `type — do not put category values in deployment_types. Fix the keys and retry.`
  );
}

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
        description:
          'Per-deployment price overrides keyed by deployment-type KEY, e.g. {"autopilot":"18.00"}. ' +
          "Unknown keys are rejected with the valid list.",
      }),
    ),
    category: Type.String({
      description:
        "Pricing category (must be a valid UCaaS pricing category, e.g. Core, Integrations). " +
        "This is NOT a deployment type.",
    }),
    sort_order: Type.Optional(Type.Number({ description: "Sort order (default 0)" })),
    deployment_types: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Deployment type KEYS, e.g. ["autopilot","copilot","bespoke"] — NOT a pricing category ' +
          'like "Core". Unknown keys are rejected with the valid list.',
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
          "List the platform default rates of a vendor's governing rate card (amounts as strings, " +
          "with the card's version and effective window). Read-only. To list ALL scopes, set " +
          "scope_mode=all and omit scope_category. Never invent a scope filter. For an exact " +
          "scope, set scope_mode=exact and scope_category; blank selects only unclassified rows. " +
          "Paged: 20 rows at a time; the answer's next_offset " +
          "names the offset of the next page. These are VIP native rates. The older ZW pricing " +
          "table is separate and is not changed by the bot.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key (e.g. zoom)" }),
          scope_mode: Type.Optional(
            Type.String({
              enum: ["all", "exact"],
              description:
                "all = every scope, no scope_category; exact = only the supplied scope_category",
            }),
          ),
          scope_category: Type.Optional(
            Type.String({
              description:
                "Exact scope only; empty selects unclassified rows, not all scopes. Omit with scope_mode=all.",
            }),
          ),
          limit: Type.Optional(
            Type.Integer({ minimum: 1, maximum: 20, description: "Rows per page (default 20)" }),
          ),
          offset: Type.Optional(
            Type.Integer({
              minimum: 0,
              description: "First row to return; the answer names the next page's offset",
            }),
          ),
        }),
        execute: opsRead,
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
            const keyError = await rejectUnknownDeploymentKeys(params);
            if (keyError) {
              return jsonResult({ ok: false, error: keyError });
            }
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
          "List a vendor's shared governing VIP native rate card, using stable vendor_key and pricing_key. " +
          "Rates are shared across project types; legacy project_type_id and numeric entry id refuse. " +
          "Amounts are unit_amount/amount_by_deployment strings, not calculated quote totals or customer " +
          "overrides. scope_mode=all omits scope_category; exact requires scope_category (blank means " +
          "unclassified only). Never invent a scope filter. Native default page is 50; request 20 or " +
          "fewer for compact replies and follow next_offset until null. Platform staff permission applies. " +
          "These are VIP native rates. The older ZW pricing table is separate and is not changed by the bot.",
        parameters: Type.Object(
          {
            vendor_key: Type.String({ minLength: 1, maxLength: 50, pattern: "^[-a-zA-Z0-9_]+$" }),
            scope_mode: Type.Optional(Type.String({ enum: ["all", "exact"] })),
            scope_category: Type.Optional(
              Type.String({
                maxLength: 16,
                description: "Exact scope; empty means unclassified, not all",
              }),
            ),
            category: Type.Optional(Type.String({ maxLength: 100 })),
            is_active: Type.Optional(Type.Boolean()),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            offset: Type.Optional(Type.Integer({ minimum: 0 })),
          },
          { additionalProperties: true },
        ),
        execute: opsRead,
      },
      logger,
    ),
  );

  for (const [action, kind, capability] of [
    ["create", "item", "pricing.items.create"],
    ["update", "item", "pricing.items.update"],
    ["update", "default", "pricing.defaults.update"],
  ] as const) {
    api.registerTool(() =>
      wrapToolWithAudit(
        {
          name: `scopely_${action}_pricing_${kind}`,
          description:
            `${action === "create" ? "Create" : "Update"} a VIP/ZW shared vendor rate by pricing_key. ` +
            "Stages an exact preview for human CONFIRM; applies across project types using this key. " +
            "Organization overrides and historical quotes remain intact. Creates a new rate-card version. " +
            "Local synthetic vendors only. Legacy project_type_id/id, retirement and tier money edits refuse.",
          parameters: Type.Object(
            {
              vendor_key: Type.String({ description: "Synthetic native vendor key" }),
              pricing_key: Type.String({
                description: "Stable vendor-wide pricing key; immutable on update",
              }),
              unit_price:
                action === "create"
                  ? Type.String({ description: "Exact decimal string, max two fractional places" })
                  : Type.Optional(Type.String()),
              unit_price_by_deployment: Type.Optional(Type.Record(Type.String(), Type.String())),
              display_name: Type.Optional(Type.String()),
              description: Type.Optional(Type.String()),
              category: Type.Optional(Type.String()),
              sort_order: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })),
              deployment_types: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })),
              is_active: Type.Optional(
                Type.Boolean({
                  description:
                    "Backend accepts only true; retirement requests receive an audited refusal",
                }),
              ),
            },
            // Preserve obsolete arguments for the native backend's strict,
            // audited refusal; never silently strip a legacy project/entry ID.
            { additionalProperties: true },
          ),
          execute: (_id: string, params: Record<string, unknown>) =>
            opsStageWrite(capability, params),
        },
        logger,
      ),
    );
  }

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
