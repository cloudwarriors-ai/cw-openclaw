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

// Key selectors come directly from native reads; alternate numeric IDs invite
// fabricated zero placeholders. Unknown fields remain for backend refusal.
const keySchema = Type.String({ pattern: "^[-a-zA-Z0-9_]+$", minLength: 1, maxLength: 50 });
const orderSchema = Type.Integer({ minimum: 0, maximum: 2147483647 });
const cardFieldSchema = Type.Object(
  {
    key: Type.String({ pattern: "^[-a-zA-Z0-9_]+$", minLength: 1, maxLength: 64 }),
    label: Type.String({ minLength: 1, maxLength: 200 }),
    field_type: Type.String({
      enum: ["number", "boolean", "select", "textarea", "text", "email", "multiselect"],
    }),
    help_text: Type.Optional(Type.String({ maxLength: 500 })),
    pricing_key: Type.Optional(Type.String({ maxLength: 100 })),
    depends_on: Type.Optional(
      Type.String({ pattern: "^[-a-zA-Z0-9_]+$", minLength: 1, maxLength: 64 }),
    ),
    // Keep the existing numeric model subset; the API also supports decimal strings.
    min_value: Type.Optional(Type.Number()),
    max_value: Type.Optional(Type.Number()),
    is_required: Type.Optional(Type.Boolean()),
    is_offered: Type.Optional(Type.Boolean()),
    validation_pattern: Type.Optional(Type.String({ maxLength: 255 })),
    default_value: Type.Optional(Type.Number()),
    sort_order: Type.Optional(orderSchema),
    options: Type.Optional(
      Type.Array(
        Type.Object(
          {
            value: Type.String({ maxLength: 100 }),
            label: Type.String({ minLength: 1, maxLength: 200 }),
            pricing_key: Type.Optional(Type.String({ maxLength: 100 })),
            sort_order: Type.Optional(orderSchema),
          },
          { additionalProperties: true },
        ),
        { maxItems: 25 },
      ),
    ),
  },
  { additionalProperties: true },
);
const visibilitySchema = Type.Record(
  Type.String(),
  Type.String({ enum: ["yes", "gated", "skip"] }),
  { maxProperties: 20 },
);

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
        parameters: Type.Object(
          {
            vendor_key: keySchema,
            project_type: Type.String({
              ...keySchema,
              description:
                "Exact project-type key from scopely_list_project_types; never invent an ID",
            }),
            key: keySchema,
            title: Type.String({ minLength: 1, maxLength: 200 }),
            description: Type.Optional(Type.String({ maxLength: 500 })),
            icon: Type.Optional(Type.String({ maxLength: 100 })),
            gate_question: Type.Optional(Type.String({ maxLength: 255 })),
            sort_order: Type.Optional(orderSchema),
            fields: Type.Optional(
              Type.Array(cardFieldSchema, {
                maxItems: 50,
                description: "Full replacement field set; omit to preserve existing fields",
              }),
            ),
            visibility: Type.Optional(visibilitySchema),
          },
          { additionalProperties: true },
        ),
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
          "Prepare a native scoping-card update; human CONFIRM is required. Send only requested changes. " +
          "Keys are immutable; richer metadata replacement and pricing remapping refuse. If you supply " +
          "`fields` or `visibility`, the backend REPLACES the card's ENTIRE field set / visibility map — " +
          "send the complete authoring set. The ordinary read omits retired fields and may cap options; " +
          "do not treat it as a full replacement source. Omit fields/visibility to preserve them.",
        parameters: Type.Object(
          {
            vendor_key: keySchema,
            project_type: Type.String({
              ...keySchema,
              description:
                "Exact project-type key from scopely_list_project_types; never invent an ID",
            }),
            card_key: Type.String({
              ...keySchema,
              description: "Exact card key from scopely_list_scoping_cards",
            }),
            title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            description: Type.Optional(Type.String({ maxLength: 500 })),
            icon: Type.Optional(Type.String({ maxLength: 100 })),
            gate_question: Type.Optional(Type.String({ maxLength: 255 })),
            sort_order: Type.Optional(orderSchema),
            fields: Type.Optional(
              Type.Array(cardFieldSchema, {
                maxItems: 50,
                description: "Full replacement field set; omit to preserve existing fields",
              }),
            ),
            visibility: Type.Optional(visibilitySchema),
          },
          { additionalProperties: true },
        ),
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
        parameters: Type.Object(
          {
            vendor_key: keySchema,
            project_type: Type.String({
              ...keySchema,
              description:
                "Exact project-type key from scopely_list_project_types; never invent an ID",
            }),
            card_key: Type.String({
              ...keySchema,
              description: "Exact card key from scopely_list_scoping_cards",
            }),
          },
          { additionalProperties: true },
        ),
        execute: (_id: string, params: Record<string, unknown>) =>
          opsStageWrite("catalog.scoping_cards.delete", params),
      },
      logger,
    ),
  );
}
