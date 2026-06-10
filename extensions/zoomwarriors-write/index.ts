import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { zw2Fetch, getZw2Base } from "./zw2-auth.js";

const ZW2_BASE = getZw2Base();

// --- Extraction tracking DB ---

const DATA_DIR = join(process.env.HOME ?? "/root", ".openclaw", "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, "zw2-extractions.db"));
db.exec(`CREATE TABLE IF NOT EXISTS extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT UNIQUE NOT NULL,
  order_id INTEGER,
  customer_name TEXT,
  order_type TEXT,
  extracted_data TEXT NOT NULL,
  missing_fields TEXT,
  confidence_notes TEXT,
  followup_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'in_progress',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);

// --- Helpers ---

function absoluteUrl(path: string): string {
  if (path.startsWith("/")) return `${ZW2_BASE}${path}`;
  return path;
}

function processDict(data: any): any {
  if (typeof data !== "object" || data === null) return data;
  const result: any = Array.isArray(data) ? [] : {};
  for (const key in data) {
    let val = data[key];
    if (typeof val === "string" && (key.endsWith("_url") || key === "url")) {
      val = absoluteUrl(val);
    } else if (typeof val === "object") {
      val = processDict(val);
    }
    result[key] = val;
  }
  return result;
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(processDict(data)) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
  };
}

// --- Section submission helper ---

function registerSectionTool(
  api: OpenClawPluginApi,
  name: string,
  description: string,
  endpoint: (orderId: number) => string,
  method: "POST" | "GET" = "POST",
) {
  api.registerTool(() => ({
    name,
    description,
    parameters: Type.Object({
      order_id: Type.Number({ description: "The ZW2 order ID" }),
      data:
        method === "POST"
          ? Type.Optional(Type.String({ description: "JSON string of section fields to submit" }))
          : Type.Optional(Type.String({ description: "Not used for GET requests" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const orderId = params.order_id as number;
        const rawData = params.data as string | undefined;
        const body = rawData ? JSON.parse(rawData) : undefined;

        const result = await zw2Fetch(endpoint(orderId), {
          method,
          ...(body ? { body: JSON.stringify(body) } : {}),
        });

        return jsonResult({ ok: result.ok, status: result.status, data: result.data });
      } catch (err) {
        return errorResult(err);
      }
    },
  }));
}

// --- Plugin ---

const plugin = {
  id: "zoomwarriors-write",
  name: "ZoomWarriors2 Write",
  description: "ZoomWarriors2 write tools - create orders, submit sections, generate SOW",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // zw2_create_order
    api.registerTool(() => ({
      name: "zw2_create_order",
      description:
        "Create a new ZoomWarriors2 order. Returns the order ID for use with section submission tools.",
      parameters: Type.Object({
        status: Type.Optional(
          Type.String({ description: 'Order status, typically "in_progress" (default)' }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const result = await zw2Fetch("/api/v1/orders/", {
            method: "POST",
            body: JSON.stringify({ status: (params.status as string) ?? "in_progress" }),
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // Section submission tools
    registerSectionTool(
      api,
      "zw2_submit_customer_info",
      "Submit customer info (Section 1) for a ZW2 order: order_name, order_type, company details, decision maker, billing contact.",
      (id) => `/api/v1/orders/${id}/customer-info/`,
    );

    registerSectionTool(
      api,
      "zw2_submit_zp_license",
      "Submit Zoom Phone license counts (Section 2): zoom_phone_licenses, common_area_licenses, power_pack_licenses, additional_dids.",
      (id) => `/api/v1/orders/${id}/zp-license/`,
    );

    registerSectionTool(
      api,
      "zw2_submit_zp_location",
      "Submit Zoom Phone location info (Section 3): sites, e911 zones, foreign ports, international deployment.",
      (id) => `/api/v1/orders/${id}/zp-location/`,
    );

    registerSectionTool(
      api,
      "zw2_submit_zp_features",
      "Submit Zoom Phone features (Section 4): auto receptionists, call queues, ATAs, paging.",
      (id) => `/api/v1/orders/${id}/zp-features/`,
    );

    registerSectionTool(
      api,
      "zw2_submit_zp_hardware",
      "Submit Zoom Phone hardware info (Section 5): physical phones, reprovisioning.",
      (id) => `/api/v1/orders/${id}/zp-hardware/`,
    );

    registerSectionTool(
      api,
      "zw2_submit_zp_sbc_pbx",
      "Submit Zoom Phone SBC/PBX config (Section 6): BYOC, SBC count/type, PBX count/type.",
      (id) => `/api/v1/orders/${id}/zp-sbc-pbx/`,
    );

    registerSectionTool(
      api,
      "zw2_submit_zcc",
      "Submit Zoom Contact Center config (Section 7): agents, channels (voice/video/sms/webchat/email/social), BYOC.",
      (id) => `/api/v1/orders/${id}/zcc/`,
    );

    registerSectionTool(
      api,
      "zw2_submit_wfo",
      "Submit Workplace Optimization (Section 8): workforce management, quality management, AI expert assist, ZVA.",
      (id) => `/api/v1/orders/${id}/zcc-workplace-optimization/`,
    );

    registerSectionTool(
      api,
      "zw2_submit_additions",
      "Submit additions (Section 9): SSO, marketplace apps, CTI integrations.",
      (id) => `/api/v1/orders/${id}/additions/`,
    );

    registerSectionTool(
      api,
      "zw2_submit_wrapup",
      "Submit wrapup questions (Section 10): go-live events, training sessions, on-site support.",
      (id) => `/api/v1/orders/${id}/wrapup-questions/`,
    );

    // --- Order Modification Tools (Training Data Patterns) ---

    // zw2_refresh_pricing
    api.registerTool(() => ({
      name: "zw2_refresh_pricing",
      description:
        "Re-calculate the order's total pricing using the latest rate card values. Use when a quote is expired (stale) or rates have changed.",
      parameters: Type.Object({
        order_id: Type.Number({ description: "The ZW2 order ID" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const orderId = params.order_id as number;
          const result = await zw2Fetch(`/api/v1/pricing/orders/${orderId}/calculate/`, {
            method: "POST",
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // SOW generation
    registerSectionTool(
      api,
      "zw2_generate_sow",
      "Generate the Statement of Work document for a completed ZW2 order.",
      (id) => `/api/v1/orders/${id}/generate-sow/`,
    );

    // SOW download (GET)
    registerSectionTool(
      api,
      "zw2_download_sow",
      "Download the generated SOW PDF for a ZW2 order. Returns the PDF content or download URL.",
      (id) => `/api/v1/orders/${id}/download-sow-pdf/`,
      "GET",
    );

    // --- Extraction tracking tools ---

    api.registerTool(() => ({
      name: "zw2_save_extraction",
      description:
        "Save transcript extraction data for a ZW2 order. Call after each bighead_analyze_transcript or bighead_followup to track the latest state. Links conversation_id to order_id.",
      parameters: Type.Object({
        conversation_id: Type.String({ description: "Rebecca conversation ID from bighead" }),
        order_id: Type.Optional(
          Type.Number({ description: "ZW2 order ID (set after zw2_create_order)" }),
        ),
        extracted_data: Type.String({ description: "Full extracted JSON blob from Rebecca" }),
        customer_name: Type.Optional(Type.String({ description: "Customer/company name" })),
        order_type: Type.Optional(
          Type.String({ description: "zoom_phone, zoom_contact_center, or both" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const convId = params.conversation_id as string;
          const data = params.extracted_data as string;
          const parsed = JSON.parse(data);
          const missing = JSON.stringify(parsed.missing_fields ?? []);
          const notes = JSON.stringify(parsed.confidence_notes ?? []);
          const mfCount = Array.isArray(parsed.missing_fields) ? parsed.missing_fields.length : 0;

          const existing = db
            .prepare("SELECT id, followup_count FROM extractions WHERE conversation_id = ?")
            .get(convId) as { id: number; followup_count: number } | undefined;

          if (existing) {
            db.prepare(`UPDATE extractions SET
              extracted_data = ?, missing_fields = ?, confidence_notes = ?,
              order_id = COALESCE(?, order_id),
              customer_name = COALESCE(?, customer_name),
              order_type = COALESCE(?, order_type),
              followup_count = ?
              WHERE conversation_id = ?`).run(
              data,
              missing,
              notes,
              params.order_id ?? null,
              params.customer_name ?? null,
              params.order_type ?? null,
              existing.followup_count + 1,
              convId,
            );
          } else {
            db.prepare(`INSERT INTO extractions
              (conversation_id, order_id, customer_name, order_type, extracted_data, missing_fields, confidence_notes, started_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
              convId,
              params.order_id ?? null,
              params.customer_name ?? null,
              params.order_type ?? null,
              data,
              missing,
              notes,
              new Date().toISOString(),
            );
          }

          return jsonResult({
            ok: true,
            conversation_id: convId,
            missing_fields_count: mfCount,
            updated: !!existing,
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    api.registerTool(() => ({
      name: "zw2_complete_extraction",
      description:
        "Mark an extraction session as complete. Call after all sections are submitted and SOW is generated. Snapshots the final state.",
      parameters: Type.Object({
        conversation_id: Type.String({ description: "Rebecca conversation ID" }),
        order_id: Type.Optional(Type.Number({ description: "ZW2 order ID to link" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const convId = params.conversation_id as string;
          const row = db
            .prepare("SELECT id FROM extractions WHERE conversation_id = ?")
            .get(convId) as { id: number } | undefined;
          if (!row) return jsonResult({ ok: false, error: "Session not found" });

          db.prepare(`UPDATE extractions SET
            status = 'completed', completed_at = ?,
            order_id = COALESCE(?, order_id)
            WHERE conversation_id = ?`).run(
            new Date().toISOString(),
            params.order_id ?? null,
            convId,
          );

          const session = db
            .prepare("SELECT * FROM extractions WHERE conversation_id = ?")
            .get(convId) as Record<string, unknown>;
          return jsonResult({ ok: true, ...session });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    api.registerTool(() => ({
      name: "zw2_get_extraction",
      description:
        "Retrieve a stored extraction session by conversation_id or order_id. Returns the full extracted data without an OpenAI call.",
      parameters: Type.Object({
        conversation_id: Type.Optional(Type.String({ description: "Rebecca conversation ID" })),
        order_id: Type.Optional(Type.Number({ description: "ZW2 order ID" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          let row: Record<string, unknown> | undefined;
          if (params.conversation_id) {
            row = db
              .prepare("SELECT * FROM extractions WHERE conversation_id = ?")
              .get(params.conversation_id as string) as Record<string, unknown> | undefined;
          } else if (params.order_id) {
            row = db
              .prepare("SELECT * FROM extractions WHERE order_id = ?")
              .get(params.order_id as number) as Record<string, unknown> | undefined;
          } else {
            return jsonResult({ ok: false, error: "Provide conversation_id or order_id" });
          }

          if (!row) return jsonResult({ ok: false, error: "Session not found" });

          // Parse JSON fields for readability
          if (typeof row.extracted_data === "string") {
            try {
              row.extracted_data = JSON.parse(row.extracted_data);
            } catch {}
          }
          if (typeof row.missing_fields === "string") {
            try {
              row.missing_fields = JSON.parse(row.missing_fields);
            } catch {}
          }
          if (typeof row.confidence_notes === "string") {
            try {
              row.confidence_notes = JSON.parse(row.confidence_notes);
            } catch {}
          }

          return jsonResult({ ok: true, ...row });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    api.registerTool(() => ({
      name: "zw2_list_extractions",
      description:
        "List recent extraction sessions. Shows conversation_id, order_id, customer, status, and followup count.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max rows to return (default 20)" })),
        status: Type.Optional(
          Type.String({ description: "Filter by status: in_progress, completed" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const limit = (params.limit as number) || 20;
          const status = params.status as string | undefined;

          let rows: unknown[];
          if (status) {
            rows = db
              .prepare(
                "SELECT id, conversation_id, order_id, customer_name, order_type, status, followup_count, started_at, completed_at FROM extractions WHERE status = ? ORDER BY id DESC LIMIT ?",
              )
              .all(status, limit) as unknown[];
          } else {
            rows = db
              .prepare(
                "SELECT id, conversation_id, order_id, customer_name, order_type, status, followup_count, started_at, completed_at FROM extractions ORDER BY id DESC LIMIT ?",
              )
              .all(limit) as unknown[];
          }

          return jsonResult({ ok: true, count: rows.length, sessions: rows });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));
  },
};

export default plugin;
