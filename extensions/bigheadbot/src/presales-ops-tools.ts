import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { bigheadOpsFetch, redactForSupport } from "./presales-ops-api.js";

type BigheadPresalesToolSpec = {
  name: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  path: (toolParams: Record<string, unknown>) => string;
};

const bigheadPresalesToolGroups = {
  observe: [
    {
      name: "bh_presales_ops_health",
      description:
        "Check Bighead presales ops health: API, Zoom service, Redis, audio runtime, transcript pipeline, and Scopely reachability.",
      parameters: Type.Object({}),
      path: () => "/internal/ops/health",
    },
    {
      name: "bh_presales_active_sessions",
      description:
        "List active Bighead presales sessions with stage, audio/transcript health, waiting state, and captured field counts.",
      parameters: Type.Object({}),
      path: () => "/internal/ops/active",
    },
    {
      name: "bh_presales_recent_sessions",
      description:
        "List recent Bighead presales sessions, including ended meetings, with meeting id, Scopely session id, status, timestamps, and transcript entry counts. Use this before transcript/status lookups when the operator asks for the latest meeting but does not provide a Bighead session id.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Number({ description: "Max recent sessions to return (default 20, max 100)" }),
        ),
        with_transcript: Type.Optional(
          Type.Boolean({
            description: "When true, return only sessions that have transcript entries.",
          }),
        ),
      }),
      path: (toolParams) => {
        const query = new URLSearchParams();
        if (toolParams.limit) query.set("limit", String(toolParams.limit));
        if (toolParams.with_transcript === true) query.set("with_transcript", "true");
        const suffix = query.toString() ? `?${query.toString()}` : "";
        return `/internal/ops/recent${suffix}`;
      },
    },
    {
      name: "bh_presales_stuck_sessions",
      description:
        "List Bighead presales sessions that appear stuck or customer-impacting, including no-audio/no-transcript conditions.",
      parameters: Type.Object({}),
      path: () => "/internal/ops/stuck",
    },
  ],
  meeting: [
    subjectTool({
      name: "bh_presales_session_status",
      description:
        "Get Bighead presales session status by session id: join state, audio/transcript state, active question, fields, and latest error.",
      segment: "session",
      paramName: "session_id",
    }),
    subjectTool({
      name: "bh_presales_meeting_status",
      description:
        "Get Bighead presales meeting status by Zoom meeting id when the operator does not know the internal session id.",
      segment: "meeting",
      paramName: "meeting_id",
    }),
    subjectTool({
      name: "bh_presales_session_timeline",
      description:
        "Get a redacted Bighead presales activity timeline for a session. Use to answer 'what happened in the meeting?'",
      segment: "session",
      paramName: "session_id",
      suffix: "/timeline",
    }),
  ],
  audio: [
    subjectTool({
      name: "bh_presales_audio_status",
      description:
        "Get Bighead audio diagnostics for a presales session: mute state, audio input/output health, and last audio timestamps.",
      segment: "session",
      paramName: "session_id",
      suffix: "/audio",
    }),
    subjectTool({
      name: "bh_presales_transcript_status",
      description:
        "Get Bighead transcript diagnostics for a presales session: transcript state, last entry time, and entry counts.",
      segment: "session",
      paramName: "session_id",
      suffix: "/transcript",
    }),
    {
      name: "bh_presales_transcript_text",
      description:
        "Read the recent Bighead presales transcript LINES (speaker + text) for a session. Use this to see what the customer actually said in the meeting — e.g. spotting 'No I already said I don't want CRM integrations!'. Operator-only; text is preserved but emails/phones/Zoom URLs are masked.",
      parameters: Type.Object({
        session_id: Type.String({ description: "Bighead internal session id" }),
        limit: Type.Optional(
          Type.Number({ description: "Max recent lines to return (default 50, max 500)" }),
        ),
        source: Type.Optional(
          Type.String({ description: "Filter by transcript source, e.g. participant_audio" }),
        ),
      }),
      path: (toolParams) => {
        const sessionId = encodeURIComponent(String(toolParams.session_id ?? ""));
        const query = new URLSearchParams();
        if (toolParams.limit) query.set("limit", String(toolParams.limit));
        if (toolParams.source) query.set("source", String(toolParams.source));
        const suffix = query.toString() ? `?${query.toString()}` : "";
        return `/internal/ops/session/${sessionId}/transcript/text${suffix}`;
      },
    },
  ],
  writeback: [
    subjectTool({
      name: "bh_presales_writeback_status",
      description:
        "Get Bighead Scopely writeback status for a presales session: last writeback, patched fields, failed fields, and latest error.",
      segment: "session",
      paramName: "session_id",
      suffix: "/writeback",
    }),
  ],
} satisfies Record<string, readonly BigheadPresalesToolSpec[]>;

export const BIGHEAD_PRESALES_TOOL_GROUPS: Record<
  keyof typeof bigheadPresalesToolGroups,
  readonly string[]
> = {
  observe: bigheadPresalesToolGroups.observe.map((tool) => tool.name),
  meeting: bigheadPresalesToolGroups.meeting.map((tool) => tool.name),
  audio: bigheadPresalesToolGroups.audio.map((tool) => tool.name),
  writeback: bigheadPresalesToolGroups.writeback.map((tool) => tool.name),
};

export function registerPresalesOpsTools(api: OpenClawPluginApi, logger: AuditLogger) {
  for (const group of Object.values(bigheadPresalesToolGroups)) {
    for (const tool of group) registerGet(api, logger, tool);
  }
}

function registerGet(api: OpenClawPluginApi, logger: AuditLogger, params: BigheadPresalesToolSpec) {
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: params.name,
        description: params.description,
        parameters: params.parameters,
        async execute(_id: string, toolParams: Record<string, unknown>) {
          try {
            const result = await bigheadOpsFetch(params.path(toolParams));
            return jsonResult({
              ok: result.ok,
              status: result.status,
              source: result.source,
              data: result.data,
            });
          } catch (err) {
            return jsonResult({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      },
      logger,
    ),
  );
}

function subjectTool(params: {
  name: string;
  description: string;
  segment: string;
  paramName: string;
  suffix?: string;
}): BigheadPresalesToolSpec {
  return {
    name: params.name,
    description: params.description,
    parameters: Type.Object({
      [params.paramName]: Type.String({
        description: "Bighead session, meeting, or related lookup id",
      }),
    }),
    path: (toolParams) =>
      `/internal/ops/${params.segment}/${encodeURIComponent(String(toolParams[params.paramName] ?? ""))}${params.suffix ?? ""}`,
  };
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(redactForSupport(data)) }] };
}
