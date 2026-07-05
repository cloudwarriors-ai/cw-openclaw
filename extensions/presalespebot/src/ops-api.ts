const PE_OPS_BASE_URL = () => process.env.PRESALES_PE_OPS_BASE_URL ?? "";
const PE_OPS_TOKEN = () => process.env.PRESALES_PE_OPS_TOKEN ?? "";
// Fixture mode is an EXPLICIT opt-in. A missing base URL in a real deployment
// is surfaced as a misconfiguration (see peOpsFetch), never a silent fall-through
// to healthy-looking fixture data during support triage.
const FIXTURE_MODE = () => process.env.PRESALES_PE_OPS_FIXTURE_MODE === "1";

export interface PeOpsFetchResult {
  ok: boolean;
  status: number;
  data: unknown;
  source: "fixture" | "api";
}

const fixture = {
  health: {
    ok: true,
    service: "pe",
    env: "fixture",
    poller_alive: true,
    scopely_reachable: true,
    schema_cache: "fresh",
  },
  active: [
    {
      engagement_id: "pe-fixture-1",
      stage: "collecting_fields",
      customer_name: "Acme",
      waiting_on: "customer",
      captured_fields: 7,
      missing_required_fields: 4,
      last_event_at: "2026-06-22T14:02:11Z",
    },
  ],
  stuck: [
    {
      engagement_id: "pe-fixture-stuck",
      stage: "waiting_on_service",
      issue: "pe.schema.fetch_failed",
      age_seconds: 315,
      summary: "Scopely auth failed; customer received service unavailable.",
    },
  ],
  engagement: {
    engagement_id: "pe-fixture-1",
    stage: "collecting_fields",
    customer_name: "Acme",
    ae_email: "m***@cloudwarriors.ai",
    scopely_session_id: "scopely-fixture-1",
    latest_bot_prompt: "Asked for Zoom Phone user count.",
    latest_customer_reply_preview: "We have 250 users.",
    captured_fields: 7,
    missing_required_fields: 4,
  },
  timeline: [
    { ts: "2026-06-22T14:02:11Z", event: "pe.launchpad.channel_created" },
    { ts: "2026-06-22T14:03:08Z", event: "pe.field.captured", field_key: "customer_name" },
  ],
  schema: {
    ok: true,
    schema_version: "fixture",
    last_fetch_at: "2026-06-22T14:01:00Z",
    cache_state: "fresh",
  },
  fields: {
    captured: ["customer_name", "contact_name", "phone_users"],
    missing_required: ["deployment_type", "sites", "go_live_date"],
    rejected: [],
  },
  sms: {
    ok: true,
    stage: "waiting_on_customer",
    delivery_status: "delivered",
    last_inbound_preview: "Can you send the SOW link?",
  },
};

export async function peOpsFetch(path: string): Promise<PeOpsFetchResult> {
  if (FIXTURE_MODE()) {
    return { ok: true, status: 200, data: fixtureFor(path), source: "fixture" };
  }
  if (PE_OPS_BASE_URL().trim() === "") {
    return {
      ok: false,
      status: 0,
      data: {
        ok: false,
        error:
          "PRESALES_PE_OPS_BASE_URL is not configured (set it, or PRESALES_PE_OPS_FIXTURE_MODE=1 for local dev).",
      },
      source: "api",
    };
  }

  const headers: Record<string, string> = {};
  const token = PE_OPS_TOKEN().trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const resp = await fetch(`${PE_OPS_BASE_URL().replace(/\/$/, "")}${path}`, { headers });
  const data = resp.headers.get("content-type")?.includes("application/json")
    ? await resp.json()
    : await resp.text();
  return { ok: resp.ok, status: resp.status, data: redactForSupport(data), source: "api" };
}

function fixtureFor(path: string): unknown {
  if (path === "/internal/ops/health") return fixture.health;
  if (path === "/internal/ops/active") return fixture.active;
  if (path === "/internal/ops/stuck") return fixture.stuck;
  if (path.includes("/timeline")) return fixture.timeline;
  if (path.includes("/schema")) return fixture.schema;
  if (path.includes("/fields")) return fixture.fields;
  if (path.startsWith("/internal/ops/sms/")) return fixture.sms;
  return fixture.engagement;
}

export function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(redactForSupport(data)) }] };
}

export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return jsonResult({ ok: false, error: message });
}

// Phone masking only runs on free-text fields; a numeric id or an ISO timestamp
// matches the phone pattern, so masking every string would corrupt structured
// values. Emails/tokens are safe to mask anywhere.
const FREE_TEXT_KEYS = new Set([
  "text",
  "preview",
  "summary",
  "reply",
  "body",
  "note",
  "notes",
  "question",
  "latest_question",
  "latest_customer_reply_preview",
  "last_inbound_preview",
]);
// Keys whose VALUE is itself a phone number → mask even though not free text.
const PHONE_KEY_RE = /(phone|mobile|msisdn|caller|from_number|to_number)/i;

export function redactForSupport(value: unknown, freeText = false): unknown {
  if (Array.isArray(value)) return value.map((item) => redactForSupport(item, freeText));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/(token|secret|password|cookie|authorization|api[_-]?key)/i.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactForSupport(
          item,
          freeText || FREE_TEXT_KEYS.has(key) || PHONE_KEY_RE.test(key),
        );
      }
    }
    return out;
  }
  if (typeof value !== "string") return value;
  let masked = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => {
      const [user, domain] = email.split("@");
      return `${user.slice(0, 1)}***@${domain}`;
    });
  if (freeText) {
    masked = masked.replace(/\+?\d[\d\s().-]{7,}\d/g, "+***");
  }
  return masked;
}
