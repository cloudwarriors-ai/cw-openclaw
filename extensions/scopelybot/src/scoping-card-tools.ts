import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { opsRead } from "./ops-client.js";
import { opsStageWrite } from "./ops-write-client.js";

// Scoping-card config tools (Scopely VIP admin). Cards are the wizard questions
// shown per project type: /api/admin/vendors/<key>/project-types/<pt>/cards/.
// All IsPlatformStaff. Reads run immediately; writes are confirm-gated.
//
// IMPORTANT semantics: when `fields` is supplied on create/update, the backend
// REPLACES the card's entire field set (delete-all + recreate). Same for the
// `visibility` dict. Tool descriptions warn the model to send the FULL desired
// set, never a delta.

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
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_scoping_cards",
        description:
          "List the scoping cards (wizard question groups) of a VIP vendor's project type as " +
          "summaries (title, description, gate question, visibility, field count); read one " +
          "card's fields with scopely_get_scoping_card. Read-only — runs immediately.",
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
        name: "scopely_get_scoping_card",
        description:
          "Get one VIP scoping card with its offered fields (type, required, help, pricing key, " +
          "dependency gate, bounds; options capped per field). Read-only — runs immediately.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          project_type: Type.String({
            description: "Project-type key (from scopely_list_project_types)",
          }),
          card_key: Type.String({ description: "Card key (from scopely_list_scoping_cards)" }),
        }),
        execute: opsRead,
      },
      logger,
    ),
  );

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_create_scoping_card",
        description:
          "Prepare a native scoping card; human CONFIRM is required. " +
          "Supports unpriced fields and deployment visibility. New pricing bindings and " +
          "visibility_condition are not supported. Exact oversized previews refuse.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          project_type_id: Type.Optional(
            Type.Number({ description: "Project-type id; provide this or project_type, not both" }),
          ),
          project_type: Type.Optional(
            Type.String({ description: "Stable project-type key from catalog reads" }),
          ),
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
        execute: (_id: string, params: Record<string, unknown>) =>
          opsStageWrite("catalog.scoping_cards.create", params),
      },
      logger,
    ),
  );

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_update_scoping_card",
        description:
          "Prepare a native scoping-card update; human CONFIRM is required. " +
          "Keys are immutable; richer metadata replacement and pricing remapping refuse. If you supply " +
          "`fields` or `visibility`, the backend REPLACES the card's ENTIRE field set / visibility map — " +
          "send the complete authoring set. The ordinary read omits retired fields and may cap options; " +
          "do not treat it as a full replacement source. Omit fields/visibility to preserve them.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          project_type_id: Type.Optional(
            Type.Number({ description: "Project-type id; provide this or project_type, not both" }),
          ),
          project_type: Type.Optional(
            Type.String({ description: "Stable project-type key from catalog reads" }),
          ),
          card_id: Type.Optional(
            Type.Number({ description: "Card id; provide this or card_key, not both" }),
          ),
          card_key: Type.Optional(
            Type.String({ description: "Stable card key from catalog reads" }),
          ),
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
        execute: (_id: string, params: Record<string, unknown>) =>
          opsStageWrite("catalog.scoping_cards.update", params),
      },
      logger,
    ),
  );

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_delete_scoping_card",
        description:
          "Prepare deletion of a native scoping card and its fields. " +
          "Only operator-admitted targets are available; human CONFIRM is required. Remaining dependencies must still validate.",
        parameters: Type.Object({
          vendor_key: Type.String({ description: "Vendor key" }),
          project_type_id: Type.Optional(
            Type.Number({ description: "Project-type id; provide this or project_type, not both" }),
          ),
          project_type: Type.Optional(
            Type.String({ description: "Stable project-type key from catalog reads" }),
          ),
          card_id: Type.Optional(
            Type.Number({ description: "Card id; provide this or card_key, not both" }),
          ),
          card_key: Type.Optional(
            Type.String({ description: "Stable card key from catalog reads" }),
          ),
        }),
        execute: (_id: string, params: Record<string, unknown>) =>
          opsStageWrite("catalog.scoping_cards.delete", params),
      },
      logger,
    ),
  );
}
