const BIGHEAD_OPS_BASE_URL = () =>
  process.env.BIGHEAD_OPS_BASE_URL ?? process.env.BIGHEAD_API_URL ?? "";
const BIGHEAD_OPS_TOKEN = () =>
  process.env.BIGHEAD_OPS_TOKEN ??
  process.env.BIGHEAD_GATEWAY_TOKEN ??
  process.env.OPENCLAW_GATEWAY_TOKEN ??
  "";
// Fixture mode must be an EXPLICIT opt-in. A missing base URL in a real
// deployment is a misconfiguration we surface (see bigheadOpsFetch), not a
// silent fall-through to healthy-looking fixture data during support triage.
const FIXTURE_MODE = () => process.env.BIGHEAD_OPS_FIXTURE_MODE === "1";

export interface BigheadOpsFetchResult {
  ok: boolean;
  status: number;
  data: unknown;
  source: "fixture" | "api";
}

const fixture = {
  health: {
    ok: true,
    service: "bighead",
    env: "fixture",
    api_alive: true,
    zoom_service_alive: true,
    redis_connected: true,
    audio_runtime_ready: true,
    scopely_reachable: true,
  },
  active: [
    {
      session_id: "bh-fixture-1",
      meeting_id: "987654321",
      stage: "in_meeting",
      customer_name: "Acme",
      waiting_on: "customer",
      audio_input: "healthy",
      transcript: "receiving",
      captured_fields: 5,
      last_event_at: "2026-06-22T14:05:02Z",
    },
  ],
  stuck: [
    {
      session_id: "bh-fixture-stuck",
      meeting_id: "123456789",
      stage: "in_meeting",
      issue: "bighead.audio.no_input_detected",
      age_seconds: 128,
      summary: "Joined meeting but no participant audio has been detected.",
    },
  ],
  session: {
    session_id: "bh-fixture-1",
    meeting_id: "987654321",
    stage: "in_meeting",
    customer_name: "Acme",
    latest_question: "Asked for Zoom Phone user count.",
    audio_input: "healthy",
    transcript: "receiving",
    captured_fields: 5,
    rejected_fields: 0,
  },
  timeline: [
    { ts: "2026-06-22T14:04:29Z", event: "bighead.webhook.create_meeting_received" },
    { ts: "2026-06-22T14:05:02Z", event: "bighead.join.succeeded" },
    { ts: "2026-06-22T14:05:31Z", event: "bighead.field.captured", field_key: "phone_users" },
  ],
  audio: {
    ok: true,
    input_state: "healthy",
    output_state: "healthy",
    mute_state: "unmuted",
    last_audio_at: "2026-06-22T14:05:31Z",
  },
  transcript: {
    ok: true,
    state: "receiving",
    last_entry_at: "2026-06-22T14:05:31Z",
    entries: 12,
  },
  transcript_text: {
    ok: true,
    count: 2,
    total_entries: 12,
    truncated: true,
    lines: [
      {
        speaker: "Customer",
        source: "participant_audio",
        ts: "2026-06-22T14:05:28Z",
        text: "No I already said I don't want CRM integrations!",
      },
      {
        speaker: "Rebecca",
        source: "assistant",
        ts: "2026-06-22T14:05:31Z",
        text: "Understood — I'll leave CRM out. How many Zoom Phone users?",
      },
    ],
  },
  writeback: {
    ok: true,
    last_writeback_at: "2026-06-22T14:05:33Z",
    patched_fields: ["phone_users"],
    failed_fields: [],
  },
};

export async function bigheadOpsFetch(path: string): Promise<BigheadOpsFetchResult> {
  if (FIXTURE_MODE()) {
    return { ok: true, status: 200, data: fixtureFor(path), source: "fixture" };
  }
  if (BIGHEAD_OPS_BASE_URL().trim() === "") {
    return {
      ok: false,
      status: 0,
      data: {
        ok: false,
        error:
          "BIGHEAD_OPS_BASE_URL is not configured (set it, or BIGHEAD_OPS_FIXTURE_MODE=1 for local dev).",
      },
      source: "api",
    };
  }

  const headers: Record<string, string> = {};
  const token = BIGHEAD_OPS_TOKEN().trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const resp = await fetch(`${BIGHEAD_OPS_BASE_URL().replace(/\/$/, "")}${path}`, { headers });
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
  if (path.includes("/audio")) return fixture.audio;
  // /transcript/text must be checked before /transcript (substring overlap).
  if (path.includes("/transcript/text")) return fixture.transcript_text;
  if (path.includes("/transcript")) return fixture.transcript;
  if (path.includes("/writeback")) return fixture.writeback;
  return fixture.session;
}

// Phone masking only runs on free-text fields; a numeric meeting_id or an ISO
// timestamp matches the phone pattern, so masking every string would corrupt
// structured values. Emails/Zoom URLs/tokens are safe to mask anywhere.
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
      if (
        /(token|secret|password|cookie|authorization|api[_-]?key|meeting_url|join_url)/i.test(key)
      ) {
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
    })
    .replace(/https:\/\/[^\s"]*zoom[^\s"]*/gi, "[REDACTED_ZOOM_URL]");
  if (freeText) {
    // Transcript text often contains phone numbers; the tool promises masking.
    masked = masked.replace(/\+?\d[\d\s().-]{7,}\d/g, "+***");
  }
  return masked;
}
