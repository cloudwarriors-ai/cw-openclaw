import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { describeChanges, pickBody, stageWrite } from "./gated.js";
import { errorResult, jsonResult, scopelyFetch } from "./scopely-api.js";

// Scoping-card config tools (Scopely VIP admin). Cards are the wizard questions
// shown per project type: /api/admin/vendors/<key>/project-types/<pt>/cards/.
// All IsPlatformStaff. Reads run immediately; writes are confirm-gated.
//
// IMPORTANT semantics: when `fields` is supplied on create/update, the backend
// REPLACES the card's entire field set (delete-all + recreate). Same for the
// `visibility` dict. Tool descriptions warn the model to send the FULL desired
// set, never a delta.

const CARD_FIELDS = [
  "key",
  "title",
  "description",
  "icon",
  "gate_question",
  "sort_order",
  "fields",
  "visibility",
  "visibility_condition",
] as const;

// One wizard field inside a card. options[] only applies to select fields.
const cardFieldSchema = Type.Object({
  key: Type.String({ description: "Field key (machine id)" }),
  label: Type.String({ description: "Field label shown to the user" }),
  field_type: Type.String({ description: "One of: number, boolean, select, textarea" }),
  help_text: Type.Optional(Type.String()),
  pricing_key: Type.Optional(Type.String({ description: "Pricing item key this field drives" })),
  depends_on: Type.Optional(Type.String({ description: "Key of a field this one depends on" })),
  min_value: Type.Optional(Type.Number()),
  max_value: Type.Optional(Type.Number()),
  is_required: Type.Optional(Type.Boolean()),
  is_offered: Type.Optional(Type.Boolean()),
  validation_pattern: Type.Optional(Type.String()),
  default_value: Type.Optional(Type.Number()),
  sort_order: Type.Optional(Type.Number()),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        value: Type.String(),
        label: Type.String(),
        pricing_key: Type.Optional(Type.String()),
        sort_order: Type.Optional(Type.Number()),
      }),
      { description: "Choices for select fields" },
    ),
  ),
});

export function registerScopingCardTools(api: OpenClawPluginApi, logger: AuditLogger) {
  const cardBase = (vendorKey: string, ptPk: number) =>
    `/api/admin/vendors/${encodeURIComponent(vendorKey)}/project-types/${ptPk}/cards/`;

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_scoping_cards",
        description:
          "List the scoping cards (wizard question groups) on a Scopely VIP vendor's project type, " +
          "including their fields and visibility. Read-only — runs immediately.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key (e.g. zoom)" }),
          project_type_id: Type.Number({ description: "Project-type id" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const res = await scopelyFetch(
              cardBase(params.vendor_key as string, params.project_type_id as number),
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
        name: "scopely_get_scoping_card",
        description:
          "Get a single Scopely VIP scoping card with its full field definitions and visibility. " +
          "Read-only — runs immediately. Use before updating a card so you can send the complete field set.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          project_type_id: Type.Number({ description: "Project-type id" }),
          card_id: Type.Number({ description: "Card id (from scopely_list_scoping_cards)" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const res = await scopelyFetch(
              `${cardBase(params.vendor_key as string, params.project_type_id as number)}${params.card_id as number}/`,
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
        name: "scopely_create_scoping_card",
        description:
          "Create a scoping card on a Scopely VIP project type (admin action). You ARE authorized — CALL " +
          "this tool. It only STAGES the create; nothing happens until `CONFIRM <code>`. visibility maps " +
          'deployment-type keys to "yes" | "gated" | "skip". visibility_condition is {} or ' +
          "{field_key, operator(eq|neq|gt|gte|lt|lte|in|not_in), value}.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          project_type_id: Type.Number({ description: "Project-type id" }),
          key: Type.String({ description: "Card key (machine id)" }),
          title: Type.String({ description: "Card title" }),
          description: Type.Optional(Type.String()),
          icon: Type.Optional(Type.String({ description: "Lucide icon key" })),
          gate_question: Type.Optional(Type.String({ description: "Gate question text" })),
          sort_order: Type.Optional(Type.Number()),
          fields: Type.Optional(
            Type.Array(cardFieldSchema, { description: "Full field set for the card" }),
          ),
          visibility: Type.Optional(
            Type.Record(Type.String(), Type.String(), {
              description: 'Per-deployment visibility, e.g. {"autopilot":"yes","bespoke":"skip"}',
            }),
          ),
          visibility_condition: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "{} or {field_key, operator, value}",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const ptPk = params.project_type_id as number;
            const body = pickBody(params, CARD_FIELDS);
            const fieldCount = Array.isArray(params.fields) ? params.fields.length : 0;
            return stageWrite(
              `create scoping card ${params.key as string} ("${params.title as string}", ${fieldCount} fields) on ${vendorKey}/pt ${ptPk}`,
              () =>
                scopelyFetch(cardBase(vendorKey, ptPk), {
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
        name: "scopely_update_scoping_card",
        description:
          "Update a scoping card on a Scopely VIP project type (admin action). You ARE authorized — CALL " +
          "this tool. It only STAGES the change; nothing applies until `CONFIRM <code>`. ⚠️ If you supply " +
          "`fields` or `visibility`, the backend REPLACES the card's ENTIRE field set / visibility map — " +
          "always fetch the card first (scopely_get_scoping_card) and send the complete desired set, " +
          "never just the delta. Omit `fields`/`visibility` entirely to leave them unchanged.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          project_type_id: Type.Number({ description: "Project-type id" }),
          card_id: Type.Number({ description: "Card id" }),
          key: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          icon: Type.Optional(Type.String()),
          gate_question: Type.Optional(Type.String()),
          sort_order: Type.Optional(Type.Number()),
          fields: Type.Optional(
            Type.Array(cardFieldSchema, {
              description: "FULL replacement field set (omit to keep current fields)",
            }),
          ),
          visibility: Type.Optional(
            Type.Record(Type.String(), Type.String(), {
              description: "FULL replacement visibility map (omit to keep current)",
            }),
          ),
          visibility_condition: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const ptPk = params.project_type_id as number;
            const cardId = params.card_id as number;
            const body = pickBody(params, CARD_FIELDS);
            if (Object.keys(body).length === 0) {
              return jsonResult({ ok: false, error: "No fields to update." });
            }
            // Summarize scalar changes; flag full-set replacements explicitly.
            const scalar = Object.fromEntries(
              Object.entries(body).filter(([k]) => k !== "fields" && k !== "visibility"),
            );
            const parts: string[] = [];
            if (Object.keys(scalar).length > 0) parts.push(describeChanges(scalar));
            if (body.fields)
              parts.push(`REPLACE fields (${(body.fields as unknown[]).length} total)`);
            if (body.visibility) parts.push("REPLACE visibility map");
            return stageWrite(
              `update scoping card id ${cardId} on ${vendorKey}/pt ${ptPk}: ${parts.join("; ")}`,
              () =>
                scopelyFetch(`${cardBase(vendorKey, ptPk)}${cardId}/`, {
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
        name: "scopely_delete_scoping_card",
        description:
          "Delete a scoping card from a Scopely VIP project type (admin action, destructive — removes the " +
          "card and all its fields). You ARE authorized — CALL this tool. It only STAGES the delete; " +
          "nothing happens until `CONFIRM <code>`.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          project_type_id: Type.Number({ description: "Project-type id" }),
          card_id: Type.Number({ description: "Card id" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string;
            const ptPk = params.project_type_id as number;
            const cardId = params.card_id as number;
            return stageWrite(`DELETE scoping card id ${cardId} on ${vendorKey}/pt ${ptPk}`, () =>
              scopelyFetch(`${cardBase(vendorKey, ptPk)}${cardId}/`, { method: "DELETE" }),
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
